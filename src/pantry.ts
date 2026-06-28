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

const TEXT_EXT = new Set([".md", ".mdx", ".markdown", ".txt"]);
const ENTRY_STEMS = /^(skill|index|readme|agent|main)\.(md|mdx|markdown|txt)$/i;

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
			const kind = DIR_KIND_MAP[dir.toLowerCase()];
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
		const entryFile =
			bundle.find((f) => ENTRY_STEMS.test(f)) ??
			bundle.find((f) => TEXT_EXT.has(extname(f).toLowerCase()));
		if (!entryFile) return undefined;
		file = join(full, entryFile);
		name = entryName; // directory name
	} else {
		const ext = extname(entryName).toLowerCase();
		if (ext && !TEXT_EXT.has(ext)) return undefined;
		file = full;
		name = basename(entryName, ext);
	}

	let raw = "";
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return undefined;
	}

	const fm = parseFrontmatter(raw);
	return {
		name: fm.name ?? name,
		kind,
		description: fm.description ?? firstProse(raw) ?? "",
		source: file,
	};
}

function parseFrontmatter(raw: string): {
	name?: string;
	description?: string;
} {
	const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!m) return {};
	const block = m[1];
	const get = (key: string): string | undefined => {
		const r = block.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, "im"));
		return r ? r[1].trim().replace(/^["']|["']$/g, "") : undefined;
	};
	return { name: get("name"), description: get("description") };
}

function firstProse(raw: string): string | undefined {
	const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
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
