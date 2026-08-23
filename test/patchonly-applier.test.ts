/**
 * Applier integration — real git fixture repos in tmpdirs (no mocks; the
 * lock/base/apply/verify/commit machinery is only proven against real git).
 * Maps to docs/PATCH-ONLY.md claims C1–C4 at build time.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PatchApplier } from "../src/patchonly/applier.js";
import {
	eventsPath,
	resetClock,
	setClock,
	setEventsDir,
} from "../src/patchonly/log.js";
import { loadEvents } from "../src/patchonly/metrics.js";

let root: string;
let repo: string;
let applier: PatchApplier;
const NOW = 1_750_000_000_000;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "patchonly-applier-"));
	repo = join(root, "repo");
	mkdirSync(repo, { recursive: true });
	execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
	execFileSync("git", ["config", "user.email", "test@local"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
	writeFileSync(join(repo, "hello.txt"), "hello world\n");
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: repo });
	setEventsDir(root);
	setClock(() => NOW);
	applier = new PatchApplier({ repoPath: repo });
});

afterEach(() => {
	resetClock();
	rmSync(root, { recursive: true, force: true });
});

function head(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo })
		.toString()
		.trim();
}

function branch(): string {
	return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
		cwd: repo,
	})
		.toString()
		.trim();
}

function statusClean(): boolean {
	return (
		execFileSync("git", ["status", "--porcelain"], { cwd: repo })
			.toString()
			.trim().length === 0
	);
}

function intent(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		intent_id: `i-${Math.random().toString(36).slice(2, 8)}`,
		agent_id: "agent-test",
		base_commit: head(),
		edits: [
			{
				file: "hello.txt",
				type: "search_replace",
				search: "world",
				replace: "patchonly",
			},
		],
		test_commands: [],
		...overrides,
	};
}

describe("PatchApplier — happy path (C1, C2)", () => {
	it("applies, commits on the target branch, and returns the canonical tree clean", async () => {
		const r = await applier.applyIntent(
			intent({ rationale: "rename greeting" }),
		);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.branch).toBe("main");
		expect(r.isolation_cost).toEqual({ files_copied: 0, bytes_copied: 0 });
		expect(readFileSync(join(repo, "hello.txt"), "utf-8")).toBe(
			"hello patchonly\n",
		);
		const log = execFileSync("git", ["log", "-1", "--format=%B"], {
			cwd: repo,
		}).toString();
		expect(log).toContain(`Edit-Intent: ${r.intent_id}`);
		expect(log).toContain("Agent: agent-test");
		expect(statusClean()).toBe(true);
	});

	it("lands work on a named branch and returns the canonical tree to its default", async () => {
		const before = head();
		const r = await applier.applyIntent(intent({ branch: "patch/proposal" }));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.branch).toBe("patch/proposal");
		expect(branch()).toBe("main"); // tree handed back
		expect(head()).toBe(before); // main untouched
		expect(readFileSync(join(repo, "hello.txt"), "utf-8")).toBe(
			"hello world\n",
		);
		execFileSync("git", ["checkout", "-q", "patch/proposal"], { cwd: repo });
		expect(readFileSync(join(repo, "hello.txt"), "utf-8")).toBe(
			"hello patchonly\n",
		);
	});
});

describe("PatchApplier — rejections as data (C4)", () => {
	it("rejects stale base without touching anything", async () => {
		const r = await applier.applyIntent(
			intent({ base_commit: "0".repeat(40) }),
		);
		expect(r).toMatchObject({ ok: false, kind: "stale_base" });
		if (!r.ok) expect(r.detail).toMatch(/re-reason against current tree/);
		expect(statusClean()).toBe(true);
	});

	it("rejects conflict with edit index and leaves zero trace", async () => {
		const r = await applier.applyIntent(
			intent({
				edits: [
					{
						file: "hello.txt",
						type: "search_replace",
						search: "absent text",
						replace: "x",
					},
				],
			}),
		);
		expect(r).toMatchObject({ ok: false, kind: "conflict", edit_index: 0 });
		if (!r.ok) expect(r.detail).toMatch(/search text not found/);
		expect(statusClean()).toBe(true);
	});

	it("rejects test failure with captured command output and restores the tree", async () => {
		const before = head();
		const r = await applier.applyIntent(
			intent({ test_commands: ["echo file-ok; exit 3"] }),
		);
		expect(r).toMatchObject({ ok: false, kind: "test_failure" });
		if (!r.ok) {
			expect(r.command_output?.[0].exit_code).toBe(3);
			expect(r.command_output?.[0].stdout).toContain("file-ok");
		}
		expect(head()).toBe(before);
		expect(readFileSync(join(repo, "hello.txt"), "utf-8")).toBe(
			"hello world\n",
		);
		expect(statusClean()).toBe(true);
	});

	it("rolls back a failing intent that created a new file on a new branch", async () => {
		const before = head();
		const startingBranch = branch();
		const r = await applier.applyIntent(
			intent({
				branch: "patch/fails",
				edits: [{ file: "brand-new.txt", type: "full_file", content: "new\n" }],
				test_commands: ["exit 9"],
			}),
		);
		expect(r).toMatchObject({ ok: false, kind: "test_failure" });
		expect(branch()).toBe(startingBranch);
		expect(head()).toBe(before);
		expect(existsSync(join(repo, "brand-new.txt"))).toBe(false);
		expect(statusClean()).toBe(true);
	});

	it("rejects invalid intents structurally", async () => {
		const r = await applier.applyIntent({ nope: true });
		expect(r).toMatchObject({ ok: false, kind: "invalid" });
	});

	it("rejects when the canonical tree is already dirty — mutations enter only via intents", async () => {
		writeFileSync(join(repo, "hello.txt"), "dirty\n");
		const r = await applier.applyIntent(intent());
		expect(r).toMatchObject({ ok: false, kind: "dirty_tree" });
	});

	it("does not rob a live lock even when the caller's wait expires first", async () => {
		// The slow intent holds the lock ~600ms; the fast caller gives up at
		// 150ms and must see `busy`, never a stolen-lock mid-apply failure.
		const tight = new PatchApplier({ repoPath: repo, lockTimeoutMs: 150 });
		const slow = tight.applyIntent(
			intent({ test_commands: ["sleep 0.6"], intent_id: "i-slow" }),
		);
		await new Promise((r2) => setTimeout(r2, 50));
		const r = await tight.applyIntent(intent({ intent_id: "i-fast" }));
		expect(r).toMatchObject({ ok: false, kind: "busy" });
		expect(await slow).toMatchObject({ ok: true });
	}, 15_000);

	it("steals a genuinely dead lock (older than staleLockMs)", async () => {
		const { utimesSync } = await import("node:fs");
		mkdirSync(join(repo, ".git", "patchonly"), { recursive: true });
		const lockPath = join(repo, ".git", "patchonly", "lock");
		writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquired_at: 0 }));
		const old = new Date(Date.now() - 120_000);
		utimesSync(lockPath, old, old);
		const thief = new PatchApplier({
			repoPath: repo,
			staleLockMs: 60_000,
			lockTimeoutMs: 300,
		});
		const r = await thief.applyIntent(intent());
		expect(r).toMatchObject({ ok: true });
	}, 10_000);
});

describe("PatchApplier — partition enforcement (#3)", () => {
	it("accepts an intent whose edits all sit inside the declared partition", async () => {
		const r = await applier.applyIntent(intent({ partition: ["hello.txt"] }));
		expect(r).toMatchObject({ ok: true });
	});

	it("matches directory prefixes with or without trailing slash", async () => {
		writeFileSync(join(repo, "nested.txt"), "deep\n");
		execFileSync("git", ["add", "."], { cwd: repo });
		execFileSync("git", ["commit", "-q", "-m", "nested"], { cwd: repo });
		let n = 0;
		for (const partition of [["src/"], ["src"]]) {
			n++;
			const r = await applier.applyIntent(
				intent({
					partition,
					base_commit: head(),
					edits: [
						{ file: "src/deep.ts", type: "full_file", content: `x-${n}\n` },
					],
				}),
			);
			expect(r, `partition ${JSON.stringify(partition)}`).toMatchObject({
				ok: true,
			});
		}
	});

	it("rejects edits outside the partition with a violation naming the offender", async () => {
		const r = await applier.applyIntent(
			intent({
				partition: ["src/patchonly/**"],
				edits: [
					{
						file: "hello.txt",
						type: "search_replace",
						search: "world",
						replace: "x",
					},
				],
			}),
		);
		expect(r).toMatchObject({ ok: false, kind: "partition_violation" });
		if (!r.ok) expect(r.detail).toContain("hello.txt");
		expect(statusClean()).toBe(true);
	});

	it("rejects when ANY edit escapes, even if others comply", async () => {
		const r = await applier.applyIntent(
			intent({
				partition: ["hello.txt"],
				edits: [
					{
						file: "hello.txt",
						type: "search_replace",
						search: "world",
						replace: "x",
					},
					{ file: "other.txt", type: "full_file", content: "escape\n" },
				],
			}),
		);
		expect(r).toMatchObject({ ok: false, kind: "partition_violation" });
		if (!r.ok) expect(r.detail).toContain("other.txt");
		expect(statusClean()).toBe(true);
	});
});

describe("PatchApplier — no-op intents", () => {
	it("reports no_change instead of a fake conflict when the proposal deltas nothing", async () => {
		// First intent establishes content.
		expect(await applier.applyIntent(intent())).toMatchObject({ ok: true });
		// Second intent proposes the identical result.
		const r = await applier.applyIntent(
			intent({
				intent_id: "i-noop",
				edits: [
					{
						file: "hello.txt",
						type: "full_file",
						content: "hello patchonly\n",
					},
				],
			}),
		);
		expect(r).toMatchObject({ ok: false, kind: "no_change" });
		if (!r.ok) expect(r.detail).toMatch(/zero delta/);
		expect(statusClean()).toBe(true);
	});
});

describe("PatchApplier — event log + isolation economics (C3)", () => {
	it("writes received/applied events with zero-copy isolation cost", async () => {
		await applier.applyIntent(intent());
		const events = loadEvents(eventsPath());
		expect(events.map((e) => e.type)).toEqual([
			"intent_received",
			"intent_applied",
		]);
		const applied = events[1];
		expect(applied).toMatchObject({
			type: "intent_applied",
			intent_id: expect.any(String),
			isolation_cost: { files_copied: 0, bytes_copied: 0 },
			ts: NOW,
		});
	});

	it("records rejections with kind and timing", async () => {
		await applier.applyIntent(intent({ base_commit: "f".repeat(40) }));
		const events = loadEvents(eventsPath());
		expect(events.at(-1)).toMatchObject({
			type: "intent_rejected",
			kind: "stale_base",
		});
	});
});
