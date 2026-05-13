/**
 * Forager — Phase ① of the cupboard pipeline.
 *
 * A Forager walks a root directory and yields RawCandidates: opaque, paradigm-
 * tagged blobs that the Cupboard stashes verbatim. Foragers do NOT classify,
 * tag, or interpret content — that's Phase ② (the cupboard-curator subagent,
 * landing in Track 2).
 *
 * Each Forager handles ONE source paradigm. New paradigms are added as new
 * adapters; the schema does not change. The bundled paradigms are listed below;
 * the type intentionally allows arbitrary string values so external callers
 * can register their own without touching the bakery.
 */

/**
 * Source paradigms the foragers know how to identify. Open-ended on purpose —
 * `string & {}` keeps autocomplete on the well-known values without locking
 * external callers out of registering custom ones.
 */
export type SourceParadigm =
	| "pi-extension"
	| "claude-skill"
	| "mcp-config"
	| "agent-md"
	| "raw-markdown"
	| "raw-script"
	| "unknown"
	| (string & {});

/** Inline content threshold (bytes). Larger files store a content_path pointer. */
export const INLINE_CONTENT_LIMIT = 64 * 1024;

/**
 * One foraged candidate. The `id` is a content hash so re-foraging the same
 * content from any path is idempotent; the Cupboard upserts on `id`.
 */
export interface RawCandidate {
	/** SHA-256 content hash (hex). Stable across paths. */
	id: string;
	/** First-seen absolute path. Subsequent finds append to `seen_at`. */
	source_path: string;
	/** Which paradigm the discovering forager belongs to. */
	source_paradigm: SourceParadigm;
	/** File size in bytes. */
	content_size: number;
	/** Inlined content if `content_size <= INLINE_CONTENT_LIMIT`, else undefined. */
	raw_content?: string;
	/** Pointer to the on-disk file when content was too large to inline. */
	content_path?: string;
	/** Adapter-specific metadata. Free-form. */
	adapter_meta?: Record<string, unknown>;
	/** ISO timestamp of when this candidate was foraged. */
	discovered_at: string;
}

/**
 * Context passed to a Forager when scanning a root.
 */
export interface ForagerContext {
	/** Absolute root directory the user pointed us at. */
	root: string;
	/** Optional logger; defaults to a no-op. */
	log?: (message: string) => void;
}

/**
 * Forager interface. Implementations should:
 *   - Return false from `match()` if the root has nothing for this paradigm.
 *   - Yield candidates lazily from `forage()`; the caller drives the cadence.
 *   - Skip `node_modules`, `.git`, `dist`, `build` by default.
 */
export interface Forager {
	/** Stable paradigm tag stamped onto every candidate this forager yields. */
	paradigm: SourceParadigm;
	/** One-line description for /strudel status. */
	description: string;
	/** Optional cheap pre-check; omit to always run forage(). */
	match?(ctx: ForagerContext): Promise<boolean>;
	/** Walk the root and yield candidates. */
	forage(ctx: ForagerContext): AsyncIterable<RawCandidate>;
}

/** Directories every walker should refuse to descend into. */
export const ALWAYS_SKIP_DIRS: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	".cache",
	".next",
	".turbo",
	".vercel",
	".pnpm-store",
	"dist",
	"build",
	"out",
	"coverage",
	".venv",
	"venv",
	"__pycache__",
]);
