/**
 * Cupboard-curator — Phases ② / ③ of the foraging pipeline.
 *
 * Phase ②: IDENTIFY — classify a stashed candidate into one of the nine
 * ingredient kinds, propose a name, flavor, tags, and dependencies.
 * Phase ③: CLASSIFY — accept / edit / reject the recommendation, register
 * the accepted one into the Pantry as `stage: "draft"` and mark the
 * cupboard row reviewed.
 *
 * The Curator does no work that the Cupboard or Pantry can do; it
 * orchestrates the LLM hand-off and the row-state machine. It is safe to
 * call when the LLM is unavailable — `recommend()` returns a low-confidence
 * heuristic recommendation rather than failing.
 */

import type { Cupboard, CupboardRow } from "./cupboard.js";
import type { LocalLlm } from "./llm.js";
import type { Pantry, RegisterInput } from "./pantry.js";
import type { IngredientKind, IngredientManifest } from "./types.js";

export interface CuratorOptions {
	pantry: Pantry;
	cupboard: Cupboard;
	llm?: LocalLlm;
	/** Cap on raw_content sent to the LLM. Default 12 KB. */
	maxContentChars?: number;
}

/** What the curator (LLM or heuristic) proposes for a candidate. */
export interface CuratorRecommendation {
	kind: IngredientKind;
	name: string;
	flavor: string;
	description?: string;
	tags?: string[];
	dependencies?: string[];
	confidence: "low" | "medium" | "high";
	/** Where the recommendation came from. */
	via: "llm" | "heuristic";
	/** Optional one-line note explaining the choice. */
	reasoning?: string;
}

/** Optional manual overrides applied at promote() time. */
export interface PromoteOverrides {
	kind?: IngredientKind;
	name?: string;
	flavor?: string;
	description?: string;
	tags?: string[];
	dependencies?: string[];
	version?: string;
}

const DEFAULT_MAX_CONTENT_CHARS = 12 * 1024;

export class Curator {
	private readonly pantry: Pantry;
	private readonly cupboard: Cupboard;
	private readonly llm?: LocalLlm;
	private readonly maxContentChars: number;

	constructor(options: CuratorOptions) {
		this.pantry = options.pantry;
		this.cupboard = options.cupboard;
		this.llm = options.llm;
		this.maxContentChars = options.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
	}

	/** Pick the oldest unreviewed candidate (optionally of one paradigm). */
	async pickNext(paradigm?: string): Promise<CupboardRow | undefined> {
		const rows = await this.cupboard.list({ paradigm, reviewed: false, limit: 1 });
		return rows[0];
	}

	/**
	 * Produce a recommendation for `row`. Tries the LLM first; on any failure
	 * (down, malformed JSON, refusal) falls back to a paradigm-derived heuristic
	 * so the caller always gets something usable.
	 */
	async recommend(row: CupboardRow): Promise<CuratorRecommendation> {
		const llmRec = await this.recommendViaLlm(row);
		if (llmRec) return llmRec;
		return this.recommendViaHeuristic(row);
	}

	/**
	 * Register the recommendation as a Pantry ingredient (stage: "draft") and
	 * mark the cupboard row reviewed. Overrides win over the recommendation.
	 */
	async promote(
		row: CupboardRow,
		recommendation: CuratorRecommendation,
		overrides: PromoteOverrides = {},
	): Promise<IngredientManifest> {
		const input: RegisterInput = {
			name: overrides.name ?? recommendation.name,
			kind: overrides.kind ?? recommendation.kind,
			flavor: overrides.flavor ?? recommendation.flavor,
			description: overrides.description ?? recommendation.description,
			tags: overrides.tags ?? recommendation.tags,
			dependencies: overrides.dependencies ?? recommendation.dependencies,
			version: overrides.version,
			stage: "draft",
			source: {
				origin: "cupboard",
				cupboard_id: row.id,
				source_path: row.source_path,
				source_paradigm: row.source_paradigm,
				adapter_meta: row.adapter_meta,
				curator: {
					confidence: recommendation.confidence,
					via: recommendation.via,
					reasoning: recommendation.reasoning,
				},
			},
		};
		const manifest = await this.pantry.register(input);
		await this.cupboard.markReviewed(row.id, manifest.name);
		return manifest;
	}

	/** Mark a candidate reviewed without promoting it. */
	async reject(row: CupboardRow): Promise<void> {
		await this.cupboard.markReviewed(row.id);
	}

	private async recommendViaLlm(row: CupboardRow): Promise<CuratorRecommendation | undefined> {
		if (!this.llm) return undefined;
		const content = (row.raw_content ?? "").slice(0, this.maxContentChars);
		const recommendation = await this.llm.classify({
			paradigm: row.source_paradigm,
			source_path: row.source_path,
			content_size: row.content_size,
			adapter_meta: row.adapter_meta,
			content,
		});
		if (!recommendation) return undefined;
		return { ...recommendation, via: "llm" };
	}

	/**
	 * Heuristic fallback. Maps paradigm → most likely ingredient kind, derives
	 * a name from source_path, and tags with paradigm. Always low confidence.
	 */
	private recommendViaHeuristic(row: CupboardRow): CuratorRecommendation {
		const kind = paradigmToKind(row.source_paradigm);
		const name = `${kind}.${slugFromPath(row.source_path)}`;
		const flavor = `Foraged ${row.source_paradigm} candidate from ${row.source_path}.`;
		return {
			kind,
			name,
			flavor,
			tags: [row.source_paradigm],
			confidence: "low",
			via: "heuristic",
			reasoning: "LLM unavailable; assigned by paradigm-to-kind default.",
		};
	}
}

function paradigmToKind(paradigm: string): IngredientKind {
	switch (paradigm) {
		case "pi-extension":
			return "plugin";
		case "claude-skill":
			return "skill";
		case "mcp-config":
			return "mcp";
		case "agent-md":
			return "directive";
		case "raw-markdown":
			return "directive";
		default:
			return "directive";
	}
}

function slugFromPath(file: string): string {
	const last = file.split(/[\\/]/).pop() ?? "candidate";
	const base = last.replace(/\.[^.]+$/, "").toLowerCase();
	return base.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
}
