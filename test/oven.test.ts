/**
 * Oven unit tests — recipe validation and execution.
 * 
 * Uses temp directories with mock tools for isolation.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	bake,
	prep,
	listTools,
	normalizeName,
	expandTilde,
	setToolsDir,
	resetToolsDir,
	type Recipe,
} from "../src/oven.js";

let toolsDir: string;

beforeEach(() => {
	toolsDir = join(
		tmpdir(),
		`strudel-oven-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(toolsDir, { recursive: true });
	setToolsDir(toolsDir);
});

afterEach(() => {
	resetToolsDir();
	rmSync(toolsDir, { recursive: true, force: true });
});

function writeTool(name: string, code: string): void {
	writeFileSync(join(toolsDir, `${name}.ts`), code, "utf8");
}

// =============================================================================
// Pure function tests (no I/O)
// =============================================================================

describe("normalizeName", () => {
	it("strips 'tool.' prefix", () => {
		expect(normalizeName("tool.read")).toBe("read");
		expect(normalizeName("tool.write")).toBe("write");
	});

	it("leaves names without prefix unchanged", () => {
		expect(normalizeName("read")).toBe("read");
		expect(normalizeName("bash")).toBe("bash");
	});

	it("only strips leading 'tool.'", () => {
		expect(normalizeName("mytool.read")).toBe("mytool.read");
		expect(normalizeName("tool.tool.read")).toBe("tool.read");
	});
});

describe("expandTilde", () => {
	const home = homedir();

	it("expands ~ at start of string", () => {
		expect(expandTilde("~/foo/bar")).toBe(join(home, "foo/bar"));
		expect(expandTilde("~/.config")).toBe(join(home, ".config"));
	});

	it("leaves strings without ~ unchanged", () => {
		expect(expandTilde("/absolute/path")).toBe("/absolute/path");
		expect(expandTilde("relative/path")).toBe("relative/path");
		expect(expandTilde("has~tilde")).toBe("has~tilde");
	});

	it("expands tildes in arrays", () => {
		expect(expandTilde(["~/a", "~/b", "/c"])).toEqual([
			join(home, "a"),
			join(home, "b"),
			"/c",
		]);
	});

	it("expands tildes in nested objects", () => {
		expect(expandTilde({ path: "~/foo", nested: { file: "~/bar" } })).toEqual({
			path: join(home, "foo"),
			nested: { file: join(home, "bar") },
		});
	});

	it("handles mixed types", () => {
		expect(expandTilde({ paths: ["~/a", "~/b"], count: 42, flag: true })).toEqual({
			paths: [join(home, "a"), join(home, "b")],
			count: 42,
			flag: true,
		});
	});

	it("leaves null and undefined unchanged", () => {
		expect(expandTilde(null)).toBe(null);
		expect(expandTilde(undefined)).toBe(undefined);
	});
});

// =============================================================================
// listTools
// =============================================================================

describe("listTools", () => {
	it("returns empty array for empty directory", () => {
		expect(listTools()).toEqual([]);
	});

	it("lists .ts files without extension", () => {
		writeTool("read", "export default async () => {}");
		writeTool("write", "export default async () => {}");
		writeTool("bash", "export default async () => {}");

		const tools = listTools();
		expect(tools.sort()).toEqual(["bash", "read", "write"]);
	});

	it("excludes files starting with underscore", () => {
		writeTool("read", "export default async () => {}");
		writeTool("_helper", "export const x = 1");

		expect(listTools()).toEqual(["read"]);
	});

	it("excludes non-.ts files", () => {
		writeTool("read", "export default async () => {}");
		writeFileSync(join(toolsDir, "readme.md"), "# Tools");
		writeFileSync(join(toolsDir, "config.json"), "{}");

		expect(listTools()).toEqual(["read"]);
	});
});

// =============================================================================
// prep — recipe validation
// =============================================================================

describe("prep", () => {
	it("validates a simple recipe with existing tool", async () => {
		writeTool("echo", "export default async (i: any) => i");

		const result = await prep({
			goal: "test",
			layers: [{ step: 1, ingredient: "echo", inputs: { msg: "hi" } }],
		});

		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
		expect(result.tools).toEqual([{ name: "echo", found: true }]);
	});

	it("detects missing tools", async () => {
		const result = await prep({
			goal: "test",
			layers: [{ step: 1, ingredient: "nonexistent", inputs: {} }],
		});

		expect(result.valid).toBe(false);
		expect(result.errors).toContain("Step 1: tool 'nonexistent' not found");
		expect(result.tools).toEqual([{ name: "nonexistent", found: false }]);
	});

	it("normalizes tool.* names when checking", async () => {
		writeTool("read", "export default async () => ({})");

		const result = await prep({
			goal: "test",
			layers: [{ step: 1, ingredient: "tool.read", inputs: {} }],
		});

		expect(result.valid).toBe(true);
		expect(result.tools).toEqual([{ name: "tool.read", found: true }]);
	});

	it("validates forward references in bindings", async () => {
		writeTool("a", "export default async () => ({})");
		writeTool("b", "export default async () => ({})");

		const result = await prep({
			goal: "test",
			layers: [
				{ step: 1, ingredient: "a", inputs: { x: "$2.value" } }, // Bad: references step 2
				{ step: 2, ingredient: "b", inputs: {} },
			],
		});

		expect(result.valid).toBe(false);
		expect(result.bindings).toContainEqual({
			step: 1,
			binding: "$2.value",
			valid: false,
			reason: "References step 2 which hasn't executed yet",
		});
	});

	it("accepts valid backward bindings", async () => {
		writeTool("a", "export default async () => ({})");
		writeTool("b", "export default async () => ({})");

		const result = await prep({
			goal: "test",
			layers: [
				{ step: 1, ingredient: "a", inputs: {} },
				{ step: 2, ingredient: "b", inputs: { x: "$1.value" } }, // Good: references step 1
			],
		});

		expect(result.valid).toBe(true);
		expect(result.bindings).toContainEqual({
			step: 2,
			binding: "$1.value",
			valid: true,
		});
	});

	it("detects duplicate step numbers", async () => {
		writeTool("a", "export default async () => ({})");

		const result = await prep({
			goal: "test",
			layers: [
				{ step: 1, ingredient: "a", inputs: {} },
				{ step: 1, ingredient: "a", inputs: {} }, // Duplicate
			],
		});

		expect(result.valid).toBe(false);
		expect(result.errors.some(e => e.includes("Duplicate step numbers"))).toBe(true);
	});

	it("detects invalid step references ($0)", async () => {
		writeTool("a", "export default async () => ({})");

		const result = await prep({
			goal: "test",
			layers: [{ step: 1, ingredient: "a", inputs: { x: "$0.value" } }],
		});

		expect(result.valid).toBe(false);
		expect(result.bindings).toContainEqual({
			step: 1,
			binding: "$0.value",
			valid: false,
			reason: "Invalid step number 0",
		});
	});
});

// =============================================================================
// bake — recipe execution
// =============================================================================

describe("bake", () => {
	it("executes a single-step recipe", async () => {
		writeTool("echo", `
			export default async function(inputs: any) {
				return { echoed: inputs.msg };
			}
		`);

		const result = await bake({
			goal: "echo test",
			layers: [{ step: 1, ingredient: "echo", inputs: { msg: "hello" } }],
		});

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.finalOutput).toEqual({ echoed: "hello" });
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0].error).toBeUndefined();
	});

	it("executes steps in order regardless of array order", async () => {
		const log: number[] = [];
		writeTool("log", `
			const log: number[] = [];
			export { log };
			export default async function(inputs: any) {
				return { step: inputs.n };
			}
		`);

		const result = await bake({
			goal: "order test",
			layers: [
				{ step: 3, ingredient: "log", inputs: { n: 3 } },
				{ step: 1, ingredient: "log", inputs: { n: 1 } },
				{ step: 2, ingredient: "log", inputs: { n: 2 } },
			],
		});

		expect(result.success).toBe(true);
		expect(result.steps.map(s => s.step)).toEqual([1, 2, 3]);
	});

	it("resolves $N bindings between steps", async () => {
		writeTool("produce", `
			export default async function(inputs: any) {
				return { value: inputs.x * 2 };
			}
		`);
		writeTool("consume", `
			export default async function(inputs: any) {
				return { result: inputs.v + 10 };
			}
		`);

		const result = await bake({
			goal: "binding test",
			layers: [
				{ step: 1, ingredient: "produce", inputs: { x: 5 } },
				{ step: 2, ingredient: "consume", inputs: { v: "$1.value" } },
			],
		});

		expect(result.success).toBe(true);
		// Step 1: 5 * 2 = 10
		// Step 2: 10 + 10 = 20
		expect(result.finalOutput).toEqual({ result: 20 });
	});

	it("resolves $N for entire output (no field)", async () => {
		writeTool("produce", `
			export default async function() {
				return { a: 1, b: 2 };
			}
		`);
		writeTool("consume", `
			export default async function(inputs: any) {
				return { got: inputs.data };
			}
		`);

		const result = await bake({
			goal: "whole output binding",
			layers: [
				{ step: 1, ingredient: "produce", inputs: {} },
				{ step: 2, ingredient: "consume", inputs: { data: "$1" } },
			],
		});

		expect(result.success).toBe(true);
		expect(result.finalOutput).toEqual({ got: { a: 1, b: 2 } });
	});

	it("resolves nested field paths ($1.foo.bar)", async () => {
		writeTool("produce", `
			export default async function() {
				return { nested: { deep: { value: 42 } } };
			}
		`);
		writeTool("consume", `
			export default async function(inputs: any) {
				return { result: inputs.x };
			}
		`);

		const result = await bake({
			goal: "nested binding",
			layers: [
				{ step: 1, ingredient: "produce", inputs: {} },
				{ step: 2, ingredient: "consume", inputs: { x: "$1.nested.deep.value" } },
			],
		});

		expect(result.success).toBe(true);
		expect(result.finalOutput).toEqual({ result: 42 });
	});

	it("expands tildes in inputs", async () => {
		writeTool("checkpath", `
			import { homedir } from "node:os";
			export default async function(inputs: any) {
				const home = homedir();
				return { 
					expanded: inputs.path.startsWith(home),
					path: inputs.path 
				};
			}
		`);

		const result = await bake({
			goal: "tilde expansion",
			layers: [{ step: 1, ingredient: "checkpath", inputs: { path: "~/.config" } }],
		});

		expect(result.success).toBe(true);
		expect((result.finalOutput as any).expanded).toBe(true);
	});

	it("stops on first error", async () => {
		writeTool("fail", `
			export default async function() {
				throw new Error("intentional failure");
			}
		`);
		writeTool("never", `
			export default async function() {
				return { reached: true };
			}
		`);

		const result = await bake({
			goal: "error handling",
			layers: [
				{ step: 1, ingredient: "fail", inputs: {} },
				{ step: 2, ingredient: "never", inputs: {} },
			],
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("intentional failure");
		expect(result.steps).toHaveLength(1);
		expect(result.steps[0].error).toContain("intentional failure");
	});

	it("fails on missing tool", async () => {
		const result = await bake({
			goal: "missing tool",
			layers: [{ step: 1, ingredient: "nonexistent", inputs: {} }],
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("Tool not found");
	});

	it("fails on invalid binding reference", async () => {
		writeTool("a", `export default async () => ({ x: 1 })`);

		const result = await bake({
			goal: "bad binding",
			layers: [
				{ step: 1, ingredient: "a", inputs: {} },
				{ step: 2, ingredient: "a", inputs: { y: "$1.nonexistent.path" } },
			],
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("cannot access");
	});

	it("records duration for each step", async () => {
		writeTool("slow", `
			export default async function() {
				await new Promise(r => setTimeout(r, 50));
				return {};
			}
		`);

		const result = await bake({
			goal: "timing",
			layers: [{ step: 1, ingredient: "slow", inputs: {} }],
		});

		expect(result.success).toBe(true);
		expect(result.steps[0].durationMs).toBeGreaterThanOrEqual(40);
		expect(result.totalDurationMs).toBeGreaterThanOrEqual(40);
	});

	it("handles tool.* prefix in ingredient names", async () => {
		writeTool("read", `
			export default async function(inputs: any) {
				return { file: inputs.path };
			}
		`);

		const result = await bake({
			goal: "prefix test",
			layers: [{ step: 1, ingredient: "tool.read", inputs: { path: "/tmp/x" } }],
		});

		expect(result.success).toBe(true);
		expect(result.finalOutput).toEqual({ file: "/tmp/x" });
	});
});

// =============================================================================
// Integration: prep + bake
// =============================================================================

describe("prep then bake workflow", () => {
	it("prep passes for recipes that bake successfully", async () => {
		writeTool("double", `
			export default async function(inputs: any) {
				return { value: inputs.n * 2 };
			}
		`);

		const recipe: Recipe = {
			goal: "double twice",
			layers: [
				{ step: 1, ingredient: "double", inputs: { n: 5 } },
				{ step: 2, ingredient: "double", inputs: { n: "$1.value" } },
			],
		};

		const prepResult = await prep(recipe);
		expect(prepResult.valid).toBe(true);

		const bakeResult = await bake(recipe);
		expect(bakeResult.success).toBe(true);
		expect(bakeResult.finalOutput).toEqual({ value: 20 }); // 5 * 2 * 2
	});

	it("prep catches what bake would fail on", async () => {
		const recipe: Recipe = {
			goal: "will fail",
			layers: [
				{ step: 1, ingredient: "missing", inputs: {} },
			],
		};

		const prepResult = await prep(recipe);
		expect(prepResult.valid).toBe(false);

		const bakeResult = await bake(recipe);
		expect(bakeResult.success).toBe(false);
	});
});

// =============================================================================
// Tool caching
// =============================================================================

describe("tool caching", () => {
	it("loads the same tool only once across multiple steps", async () => {
		let loadCount = 0;
		writeTool("counter", `
			global.loadCount = (global.loadCount || 0) + 1;
			export default async function(inputs: any) {
				return { count: global.loadCount, x: inputs.x };
			}
		`);

		const result = await bake({
			goal: "use same tool twice",
			layers: [
				{ step: 1, ingredient: "counter", inputs: { x: 1 } },
				{ step: 2, ingredient: "counter", inputs: { x: 2 } },
				{ step: 3, ingredient: "counter", inputs: { x: 3 } },
			],
		});

		expect(result.success).toBe(true);
		// All steps should see the same loadCount (tool loaded once)
		const counts = result.steps.map(s => (s.output as any).count);
		expect(new Set(counts).size).toBe(1);
	});
});

// =============================================================================
// Edge cases and error messages
// =============================================================================

describe("edge cases", () => {
	it("handles empty recipe", async () => {
		const result = await bake({ goal: "nothing", layers: [] });
		expect(result.success).toBe(true);
		expect(result.steps).toEqual([]);
		expect(result.finalOutput).toBe(null);
	});

	it("handles non-sequential step numbers", async () => {
		writeTool("id", `export default async (i: any) => i`);

		const result = await bake({
			goal: "gaps in steps",
			layers: [
				{ step: 10, ingredient: "id", inputs: { x: "ten" } },
				{ step: 5, ingredient: "id", inputs: { x: "five" } },
				{ step: 100, ingredient: "id", inputs: { x: "hundred" } },
			],
		});

		expect(result.success).toBe(true);
		// Should execute in order: 5, 10, 100
		expect(result.steps.map(s => s.step)).toEqual([5, 10, 100]);
	});

	it("provides useful error for tool that doesn't export default", async () => {
		writeTool("nodefault", `export const x = 1;`);

		const result = await bake({
			goal: "bad tool",
			layers: [{ step: 1, ingredient: "nodefault", inputs: {} }],
		});

		expect(result.success).toBe(false);
		expect(result.error).toContain("does not export a default function");
	});

	it("provides useful error for syntax error in tool", async () => {
		writeTool("badsyntax", `export default async function( { broken`);

		const result = await bake({
			goal: "syntax error",
			layers: [{ step: 1, ingredient: "badsyntax", inputs: {} }],
		});

		expect(result.success).toBe(false);
		expect(result.steps[0].error).toBeDefined();
	});

	it("bindings don't resolve inside array elements", async () => {
		// Bindings only resolve string values that START with $, not embedded
		writeTool("arr", `export default async (i: any) => i`);

		const result = await bake({
			goal: "array with bindings",
			layers: [
				{ step: 1, ingredient: "arr", inputs: { x: 42 } },
				{ step: 2, ingredient: "arr", inputs: { items: ["$1.x", "literal"] } },
			],
		});

		expect(result.success).toBe(true);
		// Array elements are passed through as-is, not resolved
		expect((result.finalOutput as any).items).toEqual(["$1.x", "literal"]);
	});

	it("handles very long goal strings", async () => {
		writeTool("ok", `export default async () => ({ ok: true })`);
		const longGoal = "x".repeat(10000);

		const result = await bake({
			goal: longGoal,
			layers: [{ step: 1, ingredient: "ok", inputs: {} }],
		});

		expect(result.success).toBe(true);
		expect(result.goal).toBe(longGoal);
	});
});
