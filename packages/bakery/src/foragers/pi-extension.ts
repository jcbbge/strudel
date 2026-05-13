/**
 * Pi extension forager.
 *
 * A Pi extension is any TypeScript / JavaScript file whose default export is a
 * function taking a `pi: ExtensionAPI` parameter. They live in two shapes:
 *
 *   1. Package extension — a directory with `package.json` declaring a
 *      dependency on `@earendil-works/pi-coding-agent`. The extension entry
 *      is the package's `main` (or `exports['.']`).
 *
 *   2. Loose extension — a single `.ts` / `.mjs` / `.js` file that imports
 *      from `@earendil-works/pi-coding-agent` (or `@earendil-works/pi-agent-core`)
 *      and exports a default function.
 *
 * The forager performs a depth-bounded recursive walk, identifies both shapes,
 * and yields one RawCandidate per extension. Detection is text-grep based —
 * deliberately cheap and best-effort. The cupboard-curator (Phase ②) does the
 * judgement work of confirming intent and proposing the right ingredient kind.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
	ALWAYS_SKIP_DIRS,
	type Forager,
	type ForagerContext,
	INLINE_CONTENT_LIMIT,
	type RawCandidate,
} from "../forager.js";

const EXTENSION_FILE_EXTS = new Set([".ts", ".mts", ".cts", ".mjs", ".cjs", ".js"]);

const PI_PACKAGE_NAMES = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-agent-core"];

const EXTENSION_API_HINT = /ExtensionAPI|registerTool\s*\(|registerCommand\s*\(|@earendil-works\/pi-/;

const MAX_WALK_DEPTH = 8;

interface PackageJson {
	name?: string;
	version?: string;
	main?: string;
	module?: string;
	type?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	exports?: unknown;
}

export class PiExtensionForager implements Forager {
	readonly paradigm = "pi-extension";
	readonly description =
		"Walks for Pi extensions: packages depending on @earendil-works/pi-coding-agent and loose entry files importing ExtensionAPI.";

	async *forage(ctx: ForagerContext): AsyncIterable<RawCandidate> {
		const log = ctx.log ?? (() => {});
		const seenPackageDirs = new Set<string>();

		// First pass: package-level candidates. These claim their containing
		// directory so the loose-file pass below can skip everything inside.
		for await (const candidate of this.walkForPackages(ctx.root, 0, log)) {
			if (candidate) {
				seenPackageDirs.add(candidate.adapter_meta?.package_dir as string);
				yield candidate;
			}
		}

		// Second pass: loose extension files anywhere we haven't already
		// claimed via a package candidate.
		for await (const candidate of this.walkForLooseFiles(ctx.root, 0, seenPackageDirs, log)) {
			yield candidate;
		}
	}

	private async *walkForPackages(
		dir: string,
		depth: number,
		log: (m: string) => void,
	): AsyncIterable<RawCandidate | undefined> {
		if (depth > MAX_WALK_DEPTH) return;
		const entries = await safeReadDir(dir);
		if (!entries) return;

		const pkgPath = path.join(dir, "package.json");
		const pkg = await readPackageJson(pkgPath);
		if (pkg && hasPiDependency(pkg)) {
			const candidate = await packageToCandidate(dir, pkg, log);
			if (candidate) yield candidate;
		}

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (shouldSkipDir(entry.name)) continue;
			yield* this.walkForPackages(path.join(dir, entry.name), depth + 1, log);
		}
	}

	private async *walkForLooseFiles(
		dir: string,
		depth: number,
		claimedPackageDirs: Set<string>,
		log: (m: string) => void,
	): AsyncIterable<RawCandidate> {
		if (depth > MAX_WALK_DEPTH) return;
		// Skip walking into any directory already claimed as a package candidate.
		if (claimedPackageDirs.has(dir)) return;

		const entries = await safeReadDir(dir);
		if (!entries) return;

		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (shouldSkipDir(entry.name)) continue;
				yield* this.walkForLooseFiles(full, depth + 1, claimedPackageDirs, log);
				continue;
			}
			if (!entry.isFile()) continue;
			const ext = path.extname(entry.name).toLowerCase();
			if (!EXTENSION_FILE_EXTS.has(ext)) continue;

			const candidate = await looseFileToCandidate(full, log);
			if (candidate) yield candidate;
		}
	}
}

function shouldSkipDir(name: string): boolean {
	if (name.startsWith(".") && name !== "." && name !== "..") return true;
	return ALWAYS_SKIP_DIRS.has(name);
}

async function safeReadDir(dir: string): Promise<import("node:fs").Dirent[] | undefined> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
}

async function readPackageJson(file: string): Promise<PackageJson | undefined> {
	try {
		const raw = await fs.readFile(file, "utf8");
		return JSON.parse(raw) as PackageJson;
	} catch {
		return undefined;
	}
}

function hasPiDependency(pkg: PackageJson): boolean {
	const buckets = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
	for (const bucket of buckets) {
		if (!bucket) continue;
		for (const dep of PI_PACKAGE_NAMES) {
			if (Object.hasOwn(bucket, dep)) return true;
		}
	}
	return false;
}

async function packageToCandidate(
	dir: string,
	pkg: PackageJson,
	log: (m: string) => void,
): Promise<RawCandidate | undefined> {
	const entryRel = resolvePackageEntry(pkg);
	if (!entryRel) {
		log(`pi-extension: ${dir} has pi dep but no resolvable entry`);
		return undefined;
	}
	const entryAbs = path.join(dir, entryRel);
	let entrySrc: string | undefined;
	try {
		entrySrc = await fs.readFile(entryAbs, "utf8");
	} catch {
		// `main` often points at dist/; try the obvious src/ sibling instead.
		const srcGuess = await guessSourceEntry(dir, entryRel);
		if (!srcGuess) {
			log(`pi-extension: ${dir} entry ${entryRel} not readable`);
			return undefined;
		}
		entrySrc = srcGuess.content;
	}

	const stat = await fs.stat(entryAbs).catch(() => undefined);
	const size = stat?.size ?? Buffer.byteLength(entrySrc, "utf8");
	const id = sha256(`pkg:${pkg.name ?? path.basename(dir)}\n${entrySrc}`);

	const inline = entrySrc.length <= INLINE_CONTENT_LIMIT ? entrySrc : undefined;
	const meta: Record<string, unknown> = {
		shape: "package",
		package_dir: dir,
		package_name: pkg.name,
		package_version: pkg.version,
		entry_relative: entryRel,
		registers: detectRegistrations(entrySrc),
	};

	return {
		id,
		source_path: entryAbs,
		source_paradigm: "pi-extension",
		content_size: size,
		raw_content: inline,
		content_path: inline ? undefined : entryAbs,
		adapter_meta: meta,
		discovered_at: new Date().toISOString(),
	};
}

async function looseFileToCandidate(file: string, log: (m: string) => void): Promise<RawCandidate | undefined> {
	let content: string;
	try {
		content = await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
	if (!EXTENSION_API_HINT.test(content)) return undefined;
	if (!hasDefaultExportFunction(content)) return undefined;

	const stat = await fs.stat(file).catch(() => undefined);
	const size = stat?.size ?? Buffer.byteLength(content, "utf8");
	const id = sha256(`loose:${file}\n${content}`);
	const inline = content.length <= INLINE_CONTENT_LIMIT ? content : undefined;

	log(`pi-extension: loose candidate ${file}`);

	return {
		id,
		source_path: file,
		source_paradigm: "pi-extension",
		content_size: size,
		raw_content: inline,
		content_path: inline ? undefined : file,
		adapter_meta: {
			shape: "loose",
			registers: detectRegistrations(content),
		},
		discovered_at: new Date().toISOString(),
	};
}

function resolvePackageEntry(pkg: PackageJson): string | undefined {
	if (typeof pkg.main === "string" && pkg.main.length > 0) return pkg.main;
	if (typeof pkg.module === "string" && pkg.module.length > 0) return pkg.module;
	const exp = pkg.exports;
	if (exp && typeof exp === "object" && !Array.isArray(exp)) {
		const root = (exp as Record<string, unknown>)["."];
		if (typeof root === "string") return root;
		if (root && typeof root === "object") {
			const candidate =
				(root as Record<string, unknown>).import ??
				(root as Record<string, unknown>).default ??
				(root as Record<string, unknown>).require;
			if (typeof candidate === "string") return candidate;
		}
	}
	return "index.js";
}

async function guessSourceEntry(dir: string, entryRel: string): Promise<{ content: string } | undefined> {
	const guesses: string[] = [];
	const base = path.basename(entryRel, path.extname(entryRel));
	const tsExts = [".ts", ".mts", ".cts", ".tsx"];
	for (const ext of tsExts) {
		guesses.push(path.join(dir, "src", `${base}${ext}`));
		guesses.push(path.join(dir, `${base}${ext}`));
	}
	for (const guess of guesses) {
		try {
			const content = await fs.readFile(guess, "utf8");
			return { content };
		} catch {
			// keep trying
		}
	}
	return undefined;
}

/**
 * Heuristic check for `export default function (pi: ExtensionAPI)` /
 * `export default <Identifier>` / `export { x as default }`. Avoids requiring
 * a real TS parse — Phase ② can do strict validation.
 */
function hasDefaultExportFunction(content: string): boolean {
	if (/export\s+default\s+function/.test(content)) return true;
	if (/export\s+default\s+(?:async\s+)?\(/.test(content)) return true;
	if (/export\s+default\s+[A-Za-z_$][A-Za-z0-9_$]*\s*;?/.test(content)) return true;
	if (/export\s*\{[^}]*\bas\s+default\b[^}]*\}/.test(content)) return true;
	return false;
}

function detectRegistrations(content: string): string[] {
	const out: string[] = [];
	if (/\bregisterTool\s*\(/.test(content)) out.push("tool");
	if (/\bregisterCommand\s*\(/.test(content)) out.push("command");
	if (/\bregisterAgent\s*\(/.test(content)) out.push("agent");
	if (/\bpi\.on\s*\(/.test(content)) out.push("hook");
	return out;
}

function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}
