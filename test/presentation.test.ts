/**
 * Presentation genome + config tests.
 *
 * Covers: STRUDEL_CONFIG_PATH redirect, per-tool description/promptSnippet
 * overrides applied to registered tools, and the pantry inventory line
 * (default, custom, and suppressed via `inventoryLine: false`).
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../src/config.js";
import strudel from "../src/index.js";
import {
	defaultInventoryLine,
	presentTool,
	resolveInventoryLine,
} from "../src/presentation.js";

// Mock ExtensionAPI capturing tool registrations and event handlers
function createMockPi() {
	const tools: Array<{ name: string; description: string; promptSnippet?: string }> = [];
	const handlers = new Map<string, Function>();
	return {
		registerTool(t: { name: string; description: string; promptSnippet?: string }) {
			tools.push(t);
		},
		registerCommand() {},
		on(event: string, handler: Function) {
			handlers.set(event, handler);
		},
		setActiveTools() {},
		getAllTools: () => tools.map((t) => ({ name: t.name, description: t.description })),
		getCommands: () => [],
		// Test helpers
		_tools: tools,
		_handlers: handlers,
	};
}

let testRoot: string;
const savedEnv = process.env.STRUDEL_CONFIG_PATH;

function writeConfig(cfg: Record<string, unknown>): string {
	const p = join(testRoot, "config.json");
	writeFileSync(p, JSON.stringify(cfg));
	process.env.STRUDEL_CONFIG_PATH = p;
	return p;
}

beforeEach(() => {
	testRoot = join(tmpdir(), `strudel-presentation-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(join(testRoot, "skills"), { recursive: true });
	writeFileSync(
		join(testRoot, "skills", "test-skill.md"),
		"---\nname: test-skill\ndescription: A test skill\n---\nContent",
	);
});

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
	if (savedEnv === undefined) delete process.env.STRUDEL_CONFIG_PATH;
	else process.env.STRUDEL_CONFIG_PATH = savedEnv;
});

describe("STRUDEL_CONFIG_PATH redirect", () => {
	it("configPath returns the env override when set", () => {
		process.env.STRUDEL_CONFIG_PATH = "/some/where/config.json";
		expect(configPath()).toBe("/some/where/config.json");
	});

	it("configPath falls back to ~/.strudel/config.json when unset", () => {
		delete process.env.STRUDEL_CONFIG_PATH;
		expect(configPath()).toMatch(/\.strudel\/config\.json$/);
	});

	it("loadConfig reads the file named by STRUDEL_CONFIG_PATH", async () => {
		writeConfig({
			pantry: { roots: [testRoot] },
			surface: "strict",
			presentation: { inventoryLine: false },
		});
		const cfg = await loadConfig();
		expect(cfg.roots).toEqual([testRoot]);
		expect(cfg.surface).toBe("strict");
		expect(cfg.presentation?.inventoryLine).toBe(false);
	});
});

describe("presentTool", () => {
	const defaults = { description: "default desc", promptSnippet: "default snippet" };

	it("returns defaults when there is no presentation config", () => {
		expect(presentTool(undefined, "strudel_search", defaults)).toEqual(defaults);
	});

	it("applies per-field overrides, keeping unset fields at default", () => {
		const p = { tools: { strudel_search: { description: "GENOME DESC" } } };
		expect(presentTool(p, "strudel_search", defaults)).toEqual({
			description: "GENOME DESC",
			promptSnippet: "default snippet",
		});
	});

	it("ignores overrides for other tools", () => {
		const p = { tools: { strudel_bake: { description: "bake only" } } };
		expect(presentTool(p, "strudel_search", defaults)).toEqual(defaults);
	});
});

describe("inventory line helpers", () => {
	it("defaultInventoryLine formats total + kind counts", () => {
		const line = defaultInventoryLine(5, new Map([["skill", 3], ["rule", 2]]));
		expect(line).toBe(
			"Pantry: 5 indexed capabilities (skill:3 rule:2). " +
				"Your visible tools are a cache, not your inventory — strudel_search finds the rest.",
		);
	});

	it("resolveInventoryLine: absent → default, string → override, false → suppressed", () => {
		expect(resolveInventoryLine(undefined, "DEFAULT")).toBe("DEFAULT");
		expect(resolveInventoryLine({}, "DEFAULT")).toBe("DEFAULT");
		expect(resolveInventoryLine({ inventoryLine: "CUSTOM" }, "DEFAULT")).toBe("CUSTOM");
		expect(resolveInventoryLine({ inventoryLine: false }, "DEFAULT")).toBeUndefined();
	});
});

describe("extension wiring (via STRUDEL_CONFIG_PATH)", () => {
	it("applies a description override to the registered tool", async () => {
		writeConfig({
			pantry: { roots: [testRoot] },
			presentation: {
				tools: { strudel_search: { description: "GENOME SEARCH DESC", promptSnippet: "GENOME SNIPPET" } },
			},
		});
		const pi = createMockPi();
		await strudel(pi as any);
		const tool = pi._tools.find((t) => t.name === "strudel_search");
		expect(tool?.description).toBe("GENOME SEARCH DESC");
		expect(tool?.promptSnippet).toBe("GENOME SNIPPET");
		// Untouched tools keep their default presentation
		const bake = pi._tools.find((t) => t.name === "strudel_bake");
		expect(bake?.description).toContain("Execute a recipe");
	});

	it("injects the inventory line with correct counts into the system prompt", async () => {
		writeConfig({ pantry: { roots: [testRoot] } });
		const pi = createMockPi();
		await strudel(pi as any);
		const handler = pi._handlers.get("before_agent_start")!;
		const result = await handler({ systemPrompt: "You are an agent.\n\nAvailable tools:\n- read: read\n" });
		expect(result.systemPrompt).toContain(
			"Pantry: 1 indexed capabilities (skill:1). " +
				"Your visible tools are a cache, not your inventory — strudel_search finds the rest.",
		);
	});

	it("inventoryLine: false suppresses the line", async () => {
		writeConfig({
			pantry: { roots: [testRoot] },
			presentation: { inventoryLine: false },
		});
		const pi = createMockPi();
		await strudel(pi as any);
		const handler = pi._handlers.get("before_agent_start")!;
		const result = await handler({ systemPrompt: "You are an agent.\n" });
		expect(result.systemPrompt).not.toContain("Pantry:");
	});

	it("inventoryLine: string replaces the default line", async () => {
		writeConfig({
			pantry: { roots: [testRoot] },
			presentation: { inventoryLine: "CUSTOM INVENTORY LINE" },
		});
		const pi = createMockPi();
		await strudel(pi as any);
		const handler = pi._handlers.get("before_agent_start")!;
		const result = await handler({ systemPrompt: "You are an agent.\n" });
		expect(result.systemPrompt).toContain("CUSTOM INVENTORY LINE");
		expect(result.systemPrompt).not.toContain("indexed capabilities");
	});
});
