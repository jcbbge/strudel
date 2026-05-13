/**
 * Manifest and ingredient types for the Pantry.
 */

/** The nine ingredient kinds the Master Baker can compose. */
export type IngredientKind =
	| "directive"
	| "command"
	| "skill"
	| "hook"
	| "tool"
	| "mcp"
	| "plugin"
	| "agent"
	| "subagent";

/** Where in the bakery the ingredient is shelved (drives discovery affordances). */
export type ShelfLocation = "front_shelf" | "back_shelf" | "fridge" | "display_case" | "cold_storage";

/**
 * Lifecycle stage of an ingredient. Drives the natural primitive evolution
 * pipeline (`phrase → command → skill → mcp/tool → subagent`): a `pantry promote`
 * call advances `kind` and `stage` together as the item matures.
 *
 *   cupboard   — captured intent on the staging shelf; not yet recommended
 *   draft      — being shaped; usable but unstable
 *   active     — recommended; full member of the Pantry
 *   deprecated — discouraged; kept for history and back-compat
 */
export type IngredientStage = "cupboard" | "draft" | "active" | "deprecated";

/** Lightweight usage telemetry kept on each ingredient. */
export interface UsageStats {
	/** Total number of times the ingredient has been baked with. */
	bakes: number;
	/** Wall-clock millis of the last bake. */
	last_baked_at?: string;
	/** Successful bakes. */
	successes: number;
	/** Failed bakes. */
	failures: number;
}

/**
 * A bake history entry, kept short for token efficiency.
 *
 * Append-only by discipline. Entries are never mutated in place once written;
 * new events are appended (capped to N most-recent entries by the Pantry).
 * This guarantee underpins the future Auto-Research evaluation layer — it can
 * mine history confident that earlier readings have not been rewritten.
 */
export interface BakeHistoryEntry {
	/** When the bake happened. */
	at: string;
	/** Outcome of the bake. */
	outcome: "success" | "failure" | "aborted";
	/** Optional one-line tasting note. */
	note?: string;
}

/** Full ingredient manifest stored in the Pantry. */
export interface IngredientManifest {
	/** Unique stable name; also the SurrealDB record id (escaped). */
	name: string;
	/** Which of the nine primitives this ingredient is. */
	kind: IngredientKind;
	/** One-line flavor / purpose description for fast scanning. */
	flavor: string;
	/** Long-form description (optional). */
	description?: string;
	/** JSON-Schema-compatible input schema (optional). */
	input_schema?: unknown;
	/** JSON-Schema-compatible output schema (optional). */
	output_schema?: unknown;
	/** A few short illustrative examples. */
	examples?: string[];
	/** Tags / categories for hybrid filtering. */
	tags?: string[];
	/** Embedding vector for semantic search; absent when no LLM is available. */
	embedding?: number[];
	/** Where this ingredient is shelved. */
	shelf: ShelfLocation;
	/** Lifecycle stage. Defaults to `"active"` for explicit registrations. */
	stage: IngredientStage;
	/** Usage telemetry. */
	usage_stats: UsageStats;
	/** Recent bake history (append-only, capped to N entries). */
	bake_history: BakeHistoryEntry[];
	/** Semver-ish version string. */
	version: string;
	/** Other ingredient names this depends on. */
	dependencies?: string[];
	/** Free-form metadata for the registering layer (path, source, etc.). */
	source?: Record<string, unknown>;
	/** ISO timestamp of last update. */
	updated_at: string;
}

/** Result row from a Pantry search. */
export interface PantrySearchHit {
	manifest: IngredientManifest;
	/** 0..1 relevance score (semantic when embeddings present, lexical otherwise). */
	score: number;
	/** Why the hit matched ("tag", "name", "flavor", "semantic"). */
	via: "tag" | "name" | "flavor" | "semantic";
}
