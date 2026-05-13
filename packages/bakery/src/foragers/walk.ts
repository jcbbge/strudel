/**
 * Shared filesystem walk for the simpler foragers. Handles depth limits,
 * ALWAYS_SKIP_DIRS, hidden directories, and per-file predicates. Yields
 * absolute file paths.
 *
 * The pi-extension forager keeps its own walker because it needs a two-pass
 * package-vs-loose flow; everything else uses this.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ALWAYS_SKIP_DIRS, INLINE_CONTENT_LIMIT, type RawCandidate, type SourceParadigm } from "../forager.js";

export const DEFAULT_MAX_WALK_DEPTH = 8;

export interface WalkOptions {
	maxDepth?: number;
	/** Predicate decides whether a file is interesting. Defaults to "yes". */
	accept?: (file: string, name: string) => boolean;
	/** Extra directory names to refuse, beyond ALWAYS_SKIP_DIRS. */
	extraSkipDirs?: ReadonlySet<string>;
}

/** Async generator yielding absolute file paths under `root`. */
export async function* walkFiles(root: string, options: WalkOptions = {}): AsyncIterable<string> {
	const maxDepth = options.maxDepth ?? DEFAULT_MAX_WALK_DEPTH;
	const accept = options.accept ?? (() => true);
	yield* walk(root, 0, maxDepth, accept, options.extraSkipDirs);
}

async function* walk(
	dir: string,
	depth: number,
	maxDepth: number,
	accept: (file: string, name: string) => boolean,
	extra: ReadonlySet<string> | undefined,
): AsyncIterable<string> {
	if (depth > maxDepth) return;
	const entries = await safeReadDir(dir);
	if (!entries) return;
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (shouldSkipDir(entry.name, extra)) continue;
			yield* walk(full, depth + 1, maxDepth, accept, extra);
			continue;
		}
		if (!entry.isFile()) continue;
		if (accept(full, entry.name)) yield full;
	}
}

export async function safeReadDir(dir: string): Promise<import("node:fs").Dirent[] | undefined> {
	try {
		return await fs.readdir(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
}

export function shouldSkipDir(name: string, extra?: ReadonlySet<string>): boolean {
	if (name.startsWith(".") && name !== "." && name !== "..") return true;
	if (ALWAYS_SKIP_DIRS.has(name)) return true;
	if (extra?.has(name)) return true;
	return false;
}

export function sha256(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

export interface FileCandidateOptions {
	paradigm: SourceParadigm;
	/** Hash-input prefix; lets two paradigms differ on identical bytes. */
	hashPrefix: string;
	adapterMeta?: Record<string, unknown>;
}

/**
 * Read a file and turn it into a RawCandidate. Returns undefined if the file
 * is unreadable. Handles the inline-vs-pointer threshold uniformly.
 */
export async function fileToCandidate(file: string, options: FileCandidateOptions): Promise<RawCandidate | undefined> {
	let content: string;
	try {
		content = await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
	const stat = await fs.stat(file).catch(() => undefined);
	const size = stat?.size ?? Buffer.byteLength(content, "utf8");
	const id = sha256(`${options.hashPrefix}\n${content}`);
	const inline = content.length <= INLINE_CONTENT_LIMIT ? content : undefined;
	return {
		id,
		source_path: file,
		source_paradigm: options.paradigm,
		content_size: size,
		raw_content: inline,
		content_path: inline ? undefined : file,
		adapter_meta: options.adapterMeta,
		discovered_at: new Date().toISOString(),
	};
}
