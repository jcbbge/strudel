/**
 * The Pantry — a unified index over primitives of every kind.
 *
 * File-based kinds are discovered by walking configured roots and inferring the
 * kind from the subdirectory name (skills/, rules/, prompts/, hooks/, ...).
 * Code-based kinds (tools, MCP tools, commands) are folded in from Pi's live
 * runtime registry at search time — see index.ts.
 *
 * Kind-agnostic by construction: nothing here assumes "skills".
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

export interface Primitive {
	name: string;
	kind: string;
	description: string;
	/** Absolute file path, or "runtime:<api>" for registry-sourced primitives. */
	source: string;
}

/** Subdirectory name → primitive kind. Kind is read off the directory structure. */
const DIR_KIND_MAP: Record<string, string> = {
	skills: "skill",
	tools: "tool",
	mcp: "mcp",
	mcps: "mcp",
	prompts: "prompt",
	commands: "command",
	slash_commands: "command",
	rules: "rule",
	hooks: "hook",
	agents: "agent",
	subagents: "subagent",
	directives: "directive",
	plugins: "plugin",
};

/**
 * Map a subdirectory name to a kind key, tolerating a leading ordering prefix
 * like "03_" or "10-" (common when people number dirs to control display order:
 * 01_directives, 02_commands, 03_skills, ...).
 */
function kindFromDir(dir: string): string {
	return dir.toLowerCase().replace(/^\d+[-_]/, "");
}

const TEXT_EXT = new Set([".md", ".mdx", ".markdown", ".txt"]);
const CODE_EXT = new Set([".ts", ".js", ".mjs", ".cjs", ".sh", ".bash", ".py"]);
const INDEXABLE_EXT = new Set([...TEXT_EXT, ...CODE_EXT]);
const ENTRY_STEMS = new Set(["skill", "index", "readme", "agent", "main"]);

/**
 * Ambient kinds are auto-invoked, not selectable — you don't "pick" a hook or a
 * rule; the runtime applies them. They stay in the Pantry inventory (counted,
 * listable) but are excluded from search ranking by {@link isOnDemand}.
 */
export const AMBIENT_KINDS = new Set(["rule", "hook", "directive", "provider"]);

/** On-demand primitives are the ones an agent selects per task — the searchable set. */
export function isOnDemand(p: Primitive): boolean {
	return !AMBIENT_KINDS.has(p.kind);
}

export function expandHome(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Walk the given roots and index every primitive kind found. Kind is inferred
 * from the subdirectory name. First occurrence wins (root order = precedence),
 * so a project root listed before a global one shadows by kind/name.
 */
export async function indexRoots(roots: string[]): Promise<Primitive[]> {
	const out: Primitive[] = [];
	const seen = new Set<string>();

	for (const rawRoot of roots) {
		const root = expandHome(rawRoot);
		let kindDirs: string[];
		try {
			kindDirs = await readdir(root);
		} catch {
			continue; // root absent — skip, don't fail
		}

		for (const dir of kindDirs) {
			const kind = DIR_KIND_MAP[kindFromDir(dir)];
			if (!kind) continue;

			let entries: string[];
			try {
				entries = await readdir(join(root, dir));
			} catch {
				continue;
			}

			for (const entry of entries) {
				if (entry.startsWith(".") || entry.startsWith("_")) continue;
				const prim = await readPrimitive(kind, join(root, dir, entry), entry);
				if (!prim) continue;
				const key = `${prim.kind}/${prim.name}`;
				if (seen.has(key)) continue;
				seen.add(key);
				out.push(prim);
			}
		}
	}
	return out;
}

async function readPrimitive(
	kind: string,
	full: string,
	entryName: string,
): Promise<Primitive | undefined> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(full);
	} catch {
		return undefined;
	}

	let file: string;
	let name: string;

	if (info.isDirectory()) {
		let bundle: string[];
		try {
			bundle = await readdir(full);
		} catch {
			return undefined;
		}
		const entry = pickDirEntry(bundle);
		if (!entry) return undefined;
		file = join(full, entry);
		name = entryName; // directory name
	} else {
		const ext = extname(entryName).toLowerCase();
		if (ext && !INDEXABLE_EXT.has(ext)) return undefined;
		file = full;
		name = basename(entryName, ext);
	}

	const meta = await describeFile(file);
	return {
		name: meta.name ?? name,
		kind,
		description: meta.description ?? "",
		source: file,
	};
}

/** Pick the entry file inside a primitive directory: a manifest, a doc, or code. */
function pickDirEntry(files: string[]): string | undefined {
	const visible = files.filter((f) => !f.startsWith("."));
	if (visible.includes("package.json")) return "package.json";
	const stem = (f: string) => basename(f, extname(f)).toLowerCase();
	const byStem = (exts: Set<string>): string | undefined =>
		visible.find(
			(f) => ENTRY_STEMS.has(stem(f)) && exts.has(extname(f).toLowerCase()),
		);
	return (
		byStem(TEXT_EXT) ??
		byStem(CODE_EXT) ??
		visible.find((f) => INDEXABLE_EXT.has(extname(f).toLowerCase()))
	);
}

/** Best-effort {name, description} from a file: manifest, frontmatter, or comment. */
async function describeFile(
	file: string,
): Promise<{ name?: string; description?: string }> {
	let raw = "";
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return {};
	}

	if (basename(file) === "package.json") {
		try {
			const pkg = JSON.parse(raw) as { name?: string; description?: string };
			return { name: pkg.name, description: pkg.description };
		} catch {
			return {};
		}
	}

	if (TEXT_EXT.has(extname(file).toLowerCase())) {
		const { fm, body } = splitFrontmatter(raw);
		return { name: fm.name, description: fm.description ?? firstProse(body) };
	}

	// Code file — take the first JSDoc / line-comment as the description.
	return { description: firstCommentDescription(raw) };
}

/** First doc-comment line in the head of a code file (skips shebang/imports/blanks). */
function firstCommentDescription(raw: string): string | undefined {
	for (const line of raw.split("\n").slice(0, 30)) {
		const t = line.trim();
		if (!t || t.startsWith("#!")) continue;
		const star = t.match(/^\*\s*(.+?)\s*$/);
		if (star && star[1] !== "/" && star[1] !== "*/") {
			const text = star[1].replace(/\*\/\s*$/, "").trim();
			if (text) return text.slice(0, 200);
		}
		const lineComment = t.match(/^(?:\/\/+|#)\s*(.+)$/);
		if (lineComment?.[1]) return lineComment[1].slice(0, 200);
	}
	return undefined;
}

interface Frontmatter {
	name?: string;
	description?: string;
}

/**
 * Split a file into its frontmatter (name/description) and body. The single
 * place the `---` boundary is parsed — name, description, and the prose fallback
 * all derive from this one split.
 */
function splitFrontmatter(raw: string): { fm: Frontmatter; body: string } {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!m) return { fm: {}, body: raw };
	const block = m[1];
	const get = (key: string): string | undefined => {
		const r = block.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "im"));
		return r ? r[1].trim().replace(/^["']|["']$/g, "") : undefined;
	};
	return {
		fm: { name: get("name"), description: get("description") },
		body: raw.slice(m[0].length),
	};
}

/** First non-heading, non-fence prose line of a body — the description fallback. */
function firstProse(body: string): string | undefined {
	for (const line of body.split("\n")) {
		const t = line.trim();
		if (t && !t.startsWith("#") && !t.startsWith("```")) return t.slice(0, 200);
	}
	return undefined;
}

export interface Ranked extends Primitive {
	score: number;
}

/** L0 lexical search — token overlap over name + kind + description, name-weighted. */
export function lexicalSearch(
	items: Primitive[],
	query: string,
	limit = 8,
): Ranked[] {
	const q = tokenize(query);
	if (q.length === 0) return [];

	const ranked: Ranked[] = [];
	for (const it of items) {
		const hay = tokenize(`${it.name} ${it.kind} ${it.description}`);
		const haySet = new Set(hay);
		const nameSet = new Set(tokenize(it.name));
		let score = 0;
		for (const t of q) {
			if (haySet.has(t)) score += 2;
			else if (hay.some((h) => h.includes(t))) score += 1;
			if (nameSet.has(t)) score += 2; // name matches matter most
		}
		if (score > 0) ranked.push({ ...it, score });
	}
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, limit);
}

function tokenize(s: string): string[] {
	return s
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1);
}
