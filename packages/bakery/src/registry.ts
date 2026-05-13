/**
 * Auto-registration of on-disk primitives into the Pantry.
 *
 * Conventions for the source tree (defaults to `~/agent-core/primitives`):
 *   primitives/
 *     commands/<slug>.md            → kind=command
 *     directives/<slug>.md          → kind=directive
 *     hooks/<slug>.{sh,js,ts}       → kind=hook
 *     skills/<slug>/SKILL.md        → kind=skill   (case-insensitive filename)
 *     subagents/<slug>.md           → kind=subagent
 *     tools/<slug>.{md,ts,js}       → kind=tool
 *     mcp/<slug>.{md,json}          → kind=mcp
 *     plugins/<slug>.{md,json}      → kind=plugin
 *     agents/<slug>.{md,json}       → kind=agent
 *
 * Each file may begin with a YAML-ish frontmatter block delimited by `---`.
 * Recognized keys: name, description, tags, version, dependencies, examples.
 * Anything else is preserved under `source.frontmatter`.
 *
 * The walker is best-effort: unknown subdirectories are ignored, malformed
 * frontmatter does not abort the run. Each file produces one ingredient.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pantry, RegisterInput } from "./pantry.js";
import type { IngredientKind, IngredientManifest } from "./types.js";

const DEFAULT_ROOT = path.join(os.homedir(), "agent-core", "primitives");

/** Map subdirectory name → ingredient kind. Skills are intentionally omitted. */
const DIR_KIND_MAP: Record<string, IngredientKind> = {
	commands: "command",
	directives: "directive",
	hooks: "hook",
	subagents: "subagent",
	tools: "tool",
	mcp: "mcp",
	mcps: "mcp",
	plugins: "plugin",
	agents: "agent",
};

const TEXT_EXTENSIONS = new Set([
	".md",
	".mdx",
	".markdown",
	".txt",
	".sh",
	".bash",
	".js",
	".ts",
	".json",
	".yaml",
	".yml",
]);

export interface RegisterFromDirOptions {
	/** Root directory to scan. Defaults to `~/agent-core/primitives`. */
	root?: string;
	/** Override the default version stamped on each ingredient. */
	defaultVersion?: string;
	/** Optional logger for progress / problems. */
	log?: (message: string) => void;
}

export interface RegisterFromDirResult {
	root: string;
	registered: IngredientManifest[];
	skipped: Array<{ path: string; reason: string }>;
	byKind: Partial<Record<IngredientKind, number>>;
}

interface ParsedFile {
	frontmatter: Record<string, unknown>;
	body: string;
}

/** Walk a primitives directory and register each entry into the Pantry. */
export async function registerFromDirectory(
	pantry: Pantry,
	options: RegisterFromDirOptions = {},
): Promise<RegisterFromDirResult> {
	const root = options.root ?? DEFAULT_ROOT;
	const log = options.log ?? (() => {});
	const result: RegisterFromDirResult = { root, registered: [], skipped: [], byKind: {} };

	let entries: string[];
	try {
		entries = await fs.readdir(root);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot scan primitives root ${root}: ${message}`);
	}

	for (const entry of entries) {
		const dir = path.join(root, entry);
		const stat = await fs.stat(dir).catch(() => undefined);
		if (!stat?.isDirectory()) continue;

		const kind = DIR_KIND_MAP[entry.toLowerCase()];
		if (!kind) {
			log(`skip directory (no kind mapping): ${dir}`);
			continue;
		}

		const inputs = await collectInputs(kind, dir, log);
		for (const { input, source } of inputs) {
			try {
				const manifest = await pantry.register({
					...input,
					version: input.version ?? options.defaultVersion ?? "0.0.1",
				});
				result.registered.push(manifest);
				result.byKind[kind] = (result.byKind[kind] ?? 0) + 1;
				log(`registered ${kind}: ${manifest.name}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				result.skipped.push({ path: source, reason: message });
				log(`failed ${kind} at ${source}: ${message}`);
			}
		}
	}

	return result;
}

async function collectInputs(
	kind: IngredientKind,
	dir: string,
	_log: (m: string) => void,
): Promise<Array<{ input: RegisterInput; source: string }>> {
	const out: Array<{ input: RegisterInput; source: string }> = [];
	const entries = await fs.readdir(dir, { withFileTypes: true });

	for (const entry of entries) {
		const full = path.join(dir, entry.name);

		if (!entry.isFile()) continue;
		const ext = path.extname(entry.name).toLowerCase();
		if (ext && !TEXT_EXTENSIONS.has(ext)) continue;
		if (entry.name.startsWith(".")) continue;
		if (entry.name.toLowerCase() === "readme.md") continue;

		const slug = path.basename(entry.name, ext);
		const input = await fileToInput(kind, full, slug);
		if (input) out.push({ input, source: full });
	}

	return out;
}

async function fileToInput(kind: IngredientKind, file: string, slug: string): Promise<RegisterInput | undefined> {
	let raw: string;
	try {
		raw = await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}

	const parsed = parseFrontmatter(raw);
	const fm = parsed.frontmatter;

	const name = stringOrUndefined(fm.name) ?? stringOrUndefined(fm.id) ?? slug;
	const flavor = deriveFlavor(fm, parsed.body, slug);
	const description = stringOrUndefined(fm.description) ?? extractDescription(parsed.body);
	const tags = stringArray(fm.tags);
	const version = stringOrUndefined(fm.version);
	const dependencies = stringArray(fm.dependencies);
	const examples = stringArray(fm.examples);

	return {
		name: namespacedName(kind, name),
		kind,
		flavor,
		description,
		tags,
		version,
		dependencies,
		examples,
		source: {
			path: file,
			origin: "directory",
			frontmatter: Object.keys(fm).length > 0 ? fm : undefined,
		},
	};
}

function namespacedName(kind: IngredientKind, name: string): string {
	const cleaned = name.trim().replace(/\s+/g, "-").toLowerCase();
	return cleaned.startsWith(`${kind}.`) ? cleaned : `${kind}.${cleaned}`;
}

function deriveFlavor(fm: Record<string, unknown>, body: string, slug: string): string {
	const explicit =
		stringOrUndefined(fm.flavor) ??
		stringOrUndefined(fm.summary) ??
		stringOrUndefined(fm.tagline) ??
		stringOrUndefined(fm.description);
	if (explicit) return firstLine(explicit, 200);

	const heading = body.match(/^\s*#\s+(.+)$/m)?.[1];
	if (heading) return firstLine(heading, 200);

	const paragraph = body
		.split(/\n\s*\n/)
		.map((p) => p.trim())
		.find((p) => p.length > 0 && !p.startsWith("#") && !p.startsWith("```"));
	if (paragraph) return firstLine(paragraph, 200);

	return slug;
}

function extractDescription(body: string): string | undefined {
	const trimmed = body.trim();
	if (!trimmed) return undefined;
	return trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;
}

function firstLine(value: string, max: number): string {
	const line = value.split(/\r?\n/)[0]?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value
			.filter((v): v is string => typeof v === "string")
			.map((v) => v.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value === "string") {
		const items = value
			.replace(/^\[|\]$/g, "")
			.split(/[,\n]/)
			.map((v) => v.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}

/**
 * Tiny YAML-frontmatter parser. Handles the common subset:
 *   key: value
 *   key: [a, b, c]
 *   key:
 *     - a
 *     - b
 * Anything richer is left as a raw string under that key.
 */
function parseFrontmatter(raw: string): ParsedFile {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) return { frontmatter: {}, body: raw };
	const block = match[1];
	const body = raw.slice(match[0].length);
	const fm: Record<string, unknown> = {};

	const lines = block.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line.trim() || line.trim().startsWith("#")) {
			i++;
			continue;
		}
		const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
		if (!kv) {
			i++;
			continue;
		}
		const key = kv[1];
		const rest = kv[2];

		if (rest.trim().length === 0) {
			// Possible block list following.
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
				items.push(
					lines[j]
						.replace(/^\s*-\s+/, "")
						.trim()
						.replace(/^["']|["']$/g, ""),
				);
				j++;
			}
			if (items.length > 0) {
				fm[key] = items;
				i = j;
				continue;
			}
			fm[key] = "";
			i++;
			continue;
		}

		fm[key] = parseScalar(rest.trim());
		i++;
	}

	return { frontmatter: fm, body };
}

function parseScalar(value: string): unknown {
	if (value.startsWith("[") && value.endsWith("]")) {
		return value
			.slice(1, -1)
			.split(",")
			.map((v) => v.trim().replace(/^["']|["']$/g, ""))
			.filter(Boolean);
	}
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}
