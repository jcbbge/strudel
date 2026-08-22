/**
 * Transport + harness restriction shim — the full agent-side loop:
 * mock pi → submit_edit_intent → UDS server → applier → real git repo.
 * Proves the pi restriction manifest (C1's mechanical half) end to end.
 */

import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import type { Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PatchApplier } from "../src/patchonly/applier.js";
import { eventsPath, setEventsDir } from "../src/patchonly/log.js";
import { loadEvents } from "../src/patchonly/metrics.js";
import patchOnly from "../src/patchonly/pi-extension.js";
import { serve, submitIntent } from "../src/patchonly/server.js";

let root: string;
let repo: string;
let socketPath: string;
let server: Server;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "patchonly-server-"));
	repo = join(root, "repo");
	socketPath = join(root, "applier.sock");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@local"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
	writeFileSync(join(repo, "app.ts"), "const version = 1;\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
	setEventsDir(root);
});

afterEach(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
	rmSync(root, { recursive: true, force: true });
});

async function startServer(): Promise<PatchApplier> {
	const applier = new PatchApplier({ repoPath: repo });
	server = await serve(applier, socketPath);
	return applier;
}

function head(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
		.toString()
		.trim();
}

describe("UDS transport", () => {
	it("carries an intent from client to applier and the commit lands", async () => {
		await startServer();
		const r = await submitIntent(socketPath, {
			intent_id: "via-socket-1",
			agent_id: "agent-x",
			base_commit: head(),
			edits: [
				{
					file: "app.ts",
					type: "search_replace",
					search: "= 1;",
					replace: "= 2;",
				},
			],
		});
		expect(r.ok).toBe(true);
		expect(readFileSync(join(repo, "app.ts"), "utf-8")).toBe(
			"const version = 2;\n",
		);
	});

	it("returns structured rejections unchanged through the wire", async () => {
		await startServer();
		const r = await submitIntent(socketPath, {
			intent_id: "bad-1",
			agent_id: "agent-x",
			base_commit: head(),
			edits: [
				{
					file: "missing.ts",
					type: "search_replace",
					search: "a",
					replace: "b",
				},
			],
		});
		expect(r).toMatchObject({ ok: false, kind: "conflict" });
	});
});

/** Minimal mock of pi's ExtensionAPI surface the shim uses. */
function mockPi() {
	const tools: Array<{
		name: string;
		execute: (...args: unknown[]) => Promise<unknown>;
	}> = [];
	let activeTools = ["read", "grep", "find", "ls", "edit", "write"];
	const handlers: Record<string, Array<(event: unknown) => unknown>> = {};
	const api = {
		registerTool: vi.fn(
			(def: {
				name: string;
				execute: (...args: unknown[]) => Promise<unknown>;
			}) => tools.push(def),
		),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = names;
		},
		on: vi.fn((event: string, handler: (event: unknown) => unknown) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		}),
	};
	return {
		api,
		tools,
		handlers,
		get activeTools() {
			return activeTools;
		},
	};
}

describe("pi restriction shim — the manifest for harness #1", () => {
	it("removes mutating tools from the active surface and registers exactly one door", async () => {
		await startServer();
		const m = mockPi();
		patchOnly(m.api as never, { socketPath });
		expect(m.activeTools).toEqual(["read", "grep", "find", "ls"]);
		expect(m.api.registerTool).toHaveBeenCalledTimes(1);
		expect(m.tools[0].name).toBe("submit_edit_intent");
	});

	it("blocks edit/write at the tool_call hook with a redirect reason", async () => {
		await startServer();
		const m = mockPi();
		patchOnly(m.api as never, { socketPath });
		const hook = m.handlers.tool_call![0] as (e: unknown) => {
			block?: boolean;
			reason?: string;
		};
		expect(hook({ toolName: "edit" })).toMatchObject({
			block: true,
			reason: /submit_edit_intent/,
		});
		expect(hook({ toolName: "write" })).toMatchObject({ block: true });
		expect(hook({ toolName: "read" })).toBeUndefined(); // reads stay free
		// The wall leaves a trace — friction must be visible (ablation lens).
		const events = loadEvents(eventsPath());
		const blocked = events.filter((e) => e.type === "blocked_attempt");
		expect(
			blocked.map((e) => (e as { tool_name: string }).tool_name).sort(),
		).toEqual(["edit", "write"]);
		expect(
			blocked.every((e) => (e as { agent_id: string }).agent_id.length > 0),
		).toBe(true);
	});

	it("execute() drives the real applier over the real socket — full loop", async () => {
		await startServer();
		const m = mockPi();
		patchOnly(m.api as never, { socketPath });
		const result = (await m.tools[0].execute(
			"tc-1",
			{
				intent_id: "loop-1",
				base_commit: head(),
				rationale: "bump version",
				edits: [
					{
						file: "app.ts",
						type: "unified_diff",
						diff: "@@ -1 +1 @@\n-const version = 1;\n+const version = 3;\n",
					},
				],
			},
			undefined,
			undefined,
			undefined,
		)) as { content: Array<{ text: string }>; isError?: boolean };

		expect(result.isError).toBeFalsy();
		const outcome = JSON.parse(result.content[0].text);
		expect(outcome).toMatchObject({
			ok: true,
			intent_id: "loop-1",
			isolation_cost: { files_copied: 0 },
		});
		expect(readFileSync(join(repo, "app.ts"), "utf-8")).toBe(
			"const version = 3;\n",
		);
	});

	it("surfaces rejections as error results so the model re-reasons", async () => {
		await startServer();
		const m = mockPi();
		patchOnly(m.api as never, { socketPath });
		const staleBase = "0".repeat(40);
		const result = (await m.tools[0].execute(
			"tc-2",
			{
				intent_id: "loop-2",
				base_commit: staleBase,
				edits: [{ file: "app.ts", type: "full_file", content: "x\n" }],
			},
			undefined,
			undefined,
			undefined,
		)) as { content: Array<{ text: string }>; isError?: boolean };
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.content[0].text)).toMatchObject({
			ok: false,
			kind: "stale_base",
		});
	});
});
