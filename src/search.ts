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

export interface SearchResult {
	hits: Ranked[];
	mode: "semantic" | "lexical";
}

export interface SearchOptions {
	embeddings?: EmbeddingConfig;
	cachePath: string;
	limit?: number;
}

/**
 * Rank `items` against `query`. Semantic when embeddings are configured — falling
 * back to lexical if the endpoint errors — lexical otherwise.
 */
export async function search(
	items: Primitive[],
	query: string,
	opts: SearchOptions,
): Promise<SearchResult> {
	const limit = opts.limit ?? 8;
	if (opts.embeddings) {
		try {
			const hits = await semanticSearch(
				items,
				query,
				httpEmbedder(opts.embeddings),
				opts.cachePath,
				limit,
			);
			return { hits, mode: "semantic" };
		} catch (err) {
			// Endpoint down / error — degrade to lexical, never break search.
			console.error(
				`[strudel] embeddings failed, falling back to lexical: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return { hits: lexicalSearch(items, query, limit), mode: "lexical" };
}
