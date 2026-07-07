/**
 * The Recipe primitive — named, versioned, indexable assemblies.
 *
 * A recipe is a template: a `goal_template` string with `{param}` tokens and a
 * `layers` array whose inputs may also contain `{param}` tokens. When an agent
 * calls `strudel_prep({ recipe: "name", params: {...} })`, the recipe is looked
 * up in the pantry, its params are substituted throughout, and the resulting
 * expanded layers are handed to `prep()` for the usual validation.
 *
 * Recipes are stored as JSON or markdown-with-frontmatter under a `recipes/`
 * directory (either `~/.strudel/recipes/` or `./.strudel/recipes/`, discovered
 * by the pantry indexer just like every other kind).
 */

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { RecipeLayer } from "./oven.js";
import type { Primitive } from "./pantry.js";

export interface Recipe {
	name: string;
	version?: number;
	description?: string;
	when_to_use?: string;
	params: string[];
	layers: RecipeLayer[];
}

/** Load a recipe from its source file (JSON or markdown-with-frontmatter). */
export async function loadRecipe(source: string): Promise<Recipe> {
	const raw = await readFile(source, "utf-8");
	const ext = extname(source).toLowerCase();

	if (ext === ".json") {
		const parsed = JSON.parse(raw) as Recipe;
		validateShape(parsed, source);
		return parsed;
	}

	// Markdown with YAML-ish frontmatter — same minimal splitter the pantry uses,
	// extended to pick up `params:` and `layers:` blocks.
	const parsed = parseMarkdownRecipe(raw, source);
	validateShape(parsed, source);
	return parsed;
}

function validateShape(
	r: Partial<Recipe>,
	source: string,
): asserts r is Recipe {
	if (!r.name || typeof r.name !== "string") {
		throw new Error(`Recipe ${source}: missing or invalid 'name'`);
	}
	if (!Array.isArray(r.layers) || r.layers.length === 0) {
		throw new Error(`Recipe ${source}: 'layers' must be a non-empty array`);
	}
	if (r.params !== undefined && !Array.isArray(r.params)) {
		throw new Error(`Recipe ${source}: 'params' must be an array`);
	}
	if (!r.params) r.params = [];
}

/**
 * Very small markdown-frontmatter parser tuned for our recipe shape.
 * Supports:
 *   name: string
 *   version: number
 *   description: string (may be quoted)
 *   when_to_use: |-block or single-line
 *   params: [] (single-line array) or ["a", "b"]
 *   layers: JSON block starting with `[` on its own line (or right after `:`)
 *
 * For anything richer (nested YAML, multi-line strings beyond `when_to_use`),
 * users can drop to `.json`. Keeping this parser small makes it dependency-free.
 */
function parseMarkdownRecipe(raw: string, source: string): Partial<Recipe> {
	const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!fmMatch) {
		throw new Error(`Recipe ${source}: no frontmatter block`);
	}
	const block = fmMatch[1];

	const out: Partial<Recipe> = {};

	// Simple key: value lines
	for (const line of block.split(/\r?\n/)) {
		const m = line.match(/^(\w+)\s*:\s*(.*)$/);
		if (!m) continue;
		const [, key, valRaw] = m;
		if (key === "name") out.name = unquote(valRaw);
		else if (key === "version") out.version = Number(valRaw) || undefined;
		else if (key === "description") out.description = unquote(valRaw);
		else if (key === "params" && valRaw.trim().startsWith("[")) {
			try {
				out.params = JSON.parse(valRaw) as string[];
			} catch {
				// leave undefined; validator will default to []
			}
		}
	}

	// Multiline `when_to_use: |` block
	const wtuMatch = block.match(
		/^when_to_use\s*:\s*\|\s*\r?\n([\s\S]*?)(?=^\w+\s*:|\Z)/m,
	);
	if (wtuMatch) {
		out.when_to_use = wtuMatch[1]
			.split(/\r?\n/)
			.map((l) => l.replace(/^\s{2}/, ""))
			.join("\n")
			.trim();
	} else {
		const single = block.match(/^when_to_use\s*:\s*(.+)$/m);
		if (single) out.when_to_use = unquote(single[1]);
	}

	// Layers: expect a JSON array. Find `layers:` and take everything after it
	// through the closing `]` at column 0 (or end of block).
	const layersIdx = block.search(/^layers\s*:/m);
	if (layersIdx >= 0) {
		const after = block.slice(layersIdx).replace(/^layers\s*:\s*/, "");
		// Find balanced brackets
		const parsed = extractJsonArray(after);
		if (parsed) {
			out.layers = parsed as RecipeLayer[];
		} else {
			throw new Error(`Recipe ${source}: could not parse 'layers' JSON array`);
		}
	}

	return out;
}

function unquote(s: string): string {
	const t = s.trim();
	if (
		(t.startsWith('"') && t.endsWith('"')) ||
		(t.startsWith("'") && t.endsWith("'"))
	) {
		return t.slice(1, -1);
	}
	return t;
}

/** Extract the first balanced JSON array from the head of a string. */
function extractJsonArray(text: string): unknown {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("[")) return undefined;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (ch === "\\" && inStr) {
			esc = true;
			continue;
		}
		if (ch === '"') inStr = !inStr;
		if (inStr) continue;
		if (ch === "[") depth++;
		else if (ch === "]") {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(trimmed.slice(0, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

// ─── Param expansion ────────────────────────────────────────────────────────

/**
 * Substitute `{param}` tokens in a recipe's layer inputs with the given values.
 * Recurses into arrays and nested objects. String values that consist entirely
 * of a single `{param}` token are replaced with the raw value (preserving type);
 * string values with `{param}` interpolated inline are stringified.
 */
export function expandParams(
	layers: RecipeLayer[],
	params: Record<string, unknown>,
): RecipeLayer[] {
	return layers.map((layer) => ({
		...layer,
		inputs: substitute(layer.inputs, params) as Record<string, unknown>,
	}));
}

function substitute(value: unknown, params: Record<string, unknown>): unknown {
	if (typeof value === "string") {
		// Whole-string exact match on a single {param} → return the raw value.
		const whole = value.match(/^\{(\w+)\}$/);
		if (whole && whole[1] in params) return params[whole[1]];
		// Otherwise interpolate all {param} tokens as strings.
		return value.replace(/\{(\w+)\}/g, (m, k: string) =>
			k in params ? String(params[k]) : m,
		);
	}
	if (Array.isArray(value)) {
		return value.map((v) => substitute(v, params));
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) {
			out[k] = substitute(v, params);
		}
		return out;
	}
	return value;
}

/** Collect the set of {param} tokens referenced anywhere in the layers. */
export function referencedParams(layers: RecipeLayer[]): Set<string> {
	const found = new Set<string>();
	const walk = (v: unknown): void => {
		if (typeof v === "string") {
			for (const m of v.matchAll(/\{(\w+)\}/g)) found.add(m[1]);
		} else if (Array.isArray(v)) v.forEach(walk);
		else if (v && typeof v === "object") Object.values(v).forEach(walk);
	};
	for (const l of layers) walk(l.inputs);
	return found;
}

/** Validate that all required params are provided and no unknown params were passed. */
export function checkParams(
	recipe: Recipe,
	params: Record<string, unknown>,
): { ok: boolean; missing: string[]; extra: string[] } {
	const referenced = referencedParams(recipe.layers);
	// declared params must be a superset of referenced params — but we trust the
	// declaration for the required list, and treat extras as unused.
	const required = new Set(recipe.params.filter((p) => referenced.has(p)));
	const missing = [...required].filter((p) => !(p in params));
	const declared = new Set(recipe.params);
	const extra = Object.keys(params).filter((p) => !declared.has(p));
	return { ok: missing.length === 0, missing, extra };
}

/** Find a recipe primitive in the file index by name. */
export function findRecipe(
	index: Primitive[],
	name: string,
): Primitive | undefined {
	return index.find((p) => p.kind === "recipe" && p.name === name);
}

/** Convenience: extension check to know if a primitive source is a recipe file. */
export function isRecipeSource(source: string): boolean {
	const b = basename(source).toLowerCase();
	return (
		b.endsWith(".json") ||
		b.endsWith(".md") ||
		b.endsWith(".mdx") ||
		b.endsWith(".markdown")
	);
}
