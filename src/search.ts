/**
 * Search strategy — pick semantic (L1) when an embeddings endpoint is configured,
 * else lexical (L0), with graceful fallback. Owns the policy so the gateway tool
 * handler doesn't have to.
 */

import {
	type EmbeddingConfig,
	httpEmbedder,
	semanticSearch,
} from "./embeddings.js";
import { type Primitive, type Ranked, lexicalSearch } from "./pantry.js";
import type { BanditRanked } from "./telemetry.js";

/** Reranks a semantically-ordered result set with the telemetry prior. */
export interface BanditRanker {
	rerank(hits: Ranked[], rng?: () => number): BanditRanked[];
}

export interface SearchResult {
	hits: BanditRanked[];
	mode: "semantic" | "lexical";
}

export interface SearchOptions {
	embeddings?: EmbeddingConfig;
	cachePath: string;
	limit?: number;
	/** Telemetry bandit — blends the usage prior into the ranking when set. */
	bandit?: BanditRanker;
	/** Injectable RNG for the bandit's exploration slot (tests). */
	rng?: () => number;
}

/**
 * Rank `items` against `query`. Semantic when embeddings are configured — falling
 * back to lexical if the endpoint errors — lexical otherwise. When a bandit is
 * provided, the telemetry prior is blended into the final ordering
 * (`final = (1-λ)·sem + λ·prior`); with an empty log this is a no-op.
 */
export async function search(
	items: Primitive[],
	query: string,
	opts: SearchOptions,
): Promise<SearchResult> {
	const limit = opts.limit ?? 8;
	let result: SearchResult | undefined;
	if (opts.embeddings) {
		try {
			const hits = await semanticSearch(
				items,
				query,
				httpEmbedder(opts.embeddings),
				opts.cachePath,
				limit,
			);
			result = { hits, mode: "semantic" };
		} catch (err) {
			// Endpoint down / error — degrade to lexical, never break search.
			console.error(
				`[strudel] embeddings failed, falling back to lexical: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	if (!result) {
		result = { hits: lexicalSearch(items, query, limit), mode: "lexical" };
	}
	if (opts.bandit) {
		result.hits = opts.bandit.rerank(result.hits, opts.rng);
	}
	return result;
}
