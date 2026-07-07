/**
 * Recipe unit tests — the loader, param expansion, and pantry integration.
 *
 * Zero infrastructure: temp dirs only. Consistent with the rest of the
 * strudel test suite.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRoots } from "../src/pantry.js";
import {
	checkParams,
	expandParams,
	findRecipe,
	loadRecipe,
	referencedParams,
} from "../src/recipe.js";

let root: string;

beforeEach(() => {
	root = join(
		tmpdir(),
		`strudel-recipe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(join(root, "recipes"), { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function writeRecipe(name: string, content: string): string {
	const path = join(root, "recipes", name);
	writeFileSync(path, content, "utf8");
	return path;
}

// ─── Loader ─────────────────────────────────────────────────────────────

describe("loadRecipe — markdown with frontmatter", () => {
	it("parses a minimal recipe", async () => {
		const path = writeRecipe(
			"minimal.md",
			`---
name: minimal
description: a minimal recipe
params: []
layers: [
  { "step": 1, "ingredient": "tool.read", "inputs": { "path": "/tmp/x" } }
]
---

# minimal
`,
		);
		const r = await loadRecipe(path);
		expect(r.name).toBe("minimal");
		expect(r.description).toBe("a minimal recipe");
		expect(r.params).toEqual([]);
		expect(r.layers).toHaveLength(1);
		expect(r.layers[0].ingredient).toBe("tool.read");
	});

	it("parses multi-line when_to_use blocks", async () => {
		const path = writeRecipe(
			"wtu.md",
			`---
name: wtu
params: []
when_to_use: |
  This is line one.
  This is line two.
layers: [
  { "step": 1, "ingredient": "tool.read", "inputs": {} }
]
---
`,
		);
		const r = await loadRecipe(path);
		expect(r.when_to_use).toContain("This is line one.");
		expect(r.when_to_use).toContain("This is line two.");
	});

	it("parses params arrays with multiple entries", async () => {
		const path = writeRecipe(
			"multi.md",
			`---
name: multi
params: ["path", "content"]
layers: [
  { "step": 1, "ingredient": "tool.write", "inputs": { "path": "{path}", "content": "{content}" } }
]
---
`,
		);
		const r = await loadRecipe(path);
		expect(r.params).toEqual(["path", "content"]);
	});

	it("throws on missing frontmatter", async () => {
		const path = writeRecipe("nofm.md", "just prose, no frontmatter\n");
		await expect(loadRecipe(path)).rejects.toThrow(/no frontmatter block/);
	});

	it("throws on missing name", async () => {
		const path = writeRecipe(
			"noname.md",
			`---
description: sneaky
layers: [{ "step": 1, "ingredient": "x", "inputs": {} }]
---
`,
		);
		await expect(loadRecipe(path)).rejects.toThrow(/missing or invalid 'name'/);
	});

	it("throws on missing layers", async () => {
		const path = writeRecipe(
			"nolayers.md",
			`---
name: nolayers
description: no layers
---
`,
		);
		await expect(loadRecipe(path)).rejects.toThrow(
			/'layers' must be a non-empty array/,
		);
	});
});

describe("loadRecipe — JSON format", () => {
	it("parses a JSON recipe", async () => {
		const path = writeRecipe(
			"json.json",
			JSON.stringify({
				name: "json-recipe",
				description: "in JSON",
				params: ["x"],
				layers: [{ step: 1, ingredient: "tool.read", inputs: { path: "{x}" } }],
			}),
		);
		const r = await loadRecipe(path);
		expect(r.name).toBe("json-recipe");
		expect(r.params).toEqual(["x"]);
		expect(r.layers[0].inputs.path).toBe("{x}");
	});

	it("throws on invalid JSON", async () => {
		const path = writeRecipe("bad.json", "{ not json");
		await expect(loadRecipe(path)).rejects.toThrow();
	});
});

// ─── Param expansion ────────────────────────────────────────────────────

describe("expandParams", () => {
	it("substitutes a single-token string with the raw value", () => {
		const layers = [{ step: 1, ingredient: "x", inputs: { path: "{path}" } }];
		const out = expandParams(layers, { path: "/tmp/a" });
		expect(out[0].inputs.path).toBe("/tmp/a");
	});

	it("interpolates multiple tokens inline as string", () => {
		const layers = [
			{
				step: 1,
				ingredient: "x",
				inputs: { msg: "hi {name}, path is {path}" },
			},
		];
		const out = expandParams(layers, { name: "Grok", path: "/tmp/x" });
		expect(out[0].inputs.msg).toBe("hi Grok, path is /tmp/x");
	});

	it("preserves raw types when a whole string is a single token", () => {
		const layers = [{ step: 1, ingredient: "x", inputs: { n: "{count}" } }];
		const out = expandParams(layers, { count: 42 });
		expect(out[0].inputs.n).toBe(42); // number, not "42"
	});

	it("recurses into nested arrays", () => {
		const layers = [
			{
				step: 1,
				ingredient: "x",
				inputs: { paths: ["{a}", "literal", "{b}"] },
			},
		];
		const out = expandParams(layers, { a: "/x", b: "/y" });
		expect(out[0].inputs.paths).toEqual(["/x", "literal", "/y"]);
	});

	it("recurses into nested objects", () => {
		const layers = [
			{
				step: 1,
				ingredient: "x",
				inputs: { outer: { inner: { path: "{p}" } } },
			},
		];
		const out = expandParams(layers, { p: "/deep" });
		expect(
			(
				(out[0].inputs.outer as Record<string, unknown>).inner as Record<
					string,
					unknown
				>
			).path,
		).toBe("/deep");
	});

	it("leaves unknown tokens intact", () => {
		const layers = [
			{ step: 1, ingredient: "x", inputs: { path: "{missing}" } },
		];
		const out = expandParams(layers, {});
		expect(out[0].inputs.path).toBe("{missing}");
	});

	it("does not touch $N.field bindings", () => {
		const layers = [
			{ step: 1, ingredient: "x", inputs: {} },
			{ step: 2, ingredient: "y", inputs: { data: "$1.value", path: "{p}" } },
		];
		const out = expandParams(layers, { p: "/tmp/x" });
		expect(out[1].inputs.data).toBe("$1.value");
		expect(out[1].inputs.path).toBe("/tmp/x");
	});
});

describe("referencedParams", () => {
	it("finds params used across layers", () => {
		const layers = [
			{ step: 1, ingredient: "x", inputs: { a: "{alpha}" } },
			{
				step: 2,
				ingredient: "y",
				inputs: { b: ["{beta}", "{gamma}"], c: "$1.value" },
			},
		];
		const refs = referencedParams(layers);
		expect(refs).toEqual(new Set(["alpha", "beta", "gamma"]));
	});
});

describe("checkParams", () => {
	const recipe = {
		name: "r",
		params: ["path", "content"],
		layers: [
			{
				step: 1,
				ingredient: "w",
				inputs: { path: "{path}", body: "{content}" },
			},
		],
	};

	it("reports missing required params", () => {
		const r = checkParams(recipe, { path: "/tmp/x" });
		expect(r.ok).toBe(false);
		expect(r.missing).toEqual(["content"]);
	});

	it("passes when all required params are provided", () => {
		const r = checkParams(recipe, { path: "/tmp/x", content: "hi" });
		expect(r.ok).toBe(true);
		expect(r.missing).toEqual([]);
	});

	it("reports extras but does not fail", () => {
		const r = checkParams(recipe, { path: "/tmp/x", content: "hi", bonus: 1 });
		expect(r.ok).toBe(true);
		expect(r.extra).toEqual(["bonus"]);
	});

	it("does not require declared params that no layer references", () => {
		// If params array declares an unused param, it's not required.
		const r2 = { ...recipe, params: ["path", "content", "unused"] };
		const r = checkParams(r2, { path: "/tmp/x", content: "hi" });
		expect(r.ok).toBe(true);
	});
});

// ─── Pantry integration ────────────────────────────────────────────────

describe("pantry indexes recipes", () => {
	it("indexes recipe files as kind='recipe'", async () => {
		writeRecipe(
			"bench.load.md",
			`---
name: bench.load
description: load the bench
params: []
layers: [{ "step": 1, "ingredient": "tool.batch", "inputs": { "paths": ["/tmp/x"] } }]
---
`,
		);
		const items = await indexRoots([root]);
		const recipe = items.find((i) => i.name === "bench.load");
		expect(recipe?.kind).toBe("recipe");
		expect(recipe?.description).toBe("load the bench");
	});

	it("findRecipe locates a recipe primitive by name", async () => {
		writeRecipe(
			"foo.md",
			`---
name: foo
description: a recipe called foo
params: []
layers: [{ "step": 1, "ingredient": "tool.read", "inputs": {} }]
---
`,
		);
		const items = await indexRoots([root]);
		const found = findRecipe(items, "foo");
		expect(found?.name).toBe("foo");
		expect(found?.kind).toBe("recipe");
	});

	it("findRecipe returns undefined for unknown recipe", async () => {
		const items = await indexRoots([root]);
		expect(findRecipe(items, "does-not-exist")).toBeUndefined();
	});
});
