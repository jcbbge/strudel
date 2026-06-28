/**
 * Embedding-search unit tests — zero infrastructure. The embedder is injected
 * (a deterministic keyword-vector fake), so ranking, caching, and cosine are
 * verified without any live endpoint.
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Embedder,
	cosine,
	embedText,
	semanticSearch,
} from "../src/embeddings.js";
import type { Primitive } from "../src/pantry.js";

// Deterministic fake embedder: 3 dims = presence of [animation, graphql, debug].
const KEYWORDS = ["anim", "graphql", "debug"];
function fakeVector(text: string): number[] {
	const t = text.toLowerCase();
	return KEYWORDS.map((k) => (t.includes(k) ? 1 : 0));
}
function makeFakeEmbedder(): Embedder & { calls: number; embedded: number } {
	const fn = (async (texts: string[]) => {
		fn.calls++;
		fn.embedded += texts.length;
		return texts.map(fakeVector);
	}) as Embedder & { calls: number; embedded: number };
	fn.calls = 0;
	fn.embedded = 0;
	return fn;
}

const items: Primitive[] = [
	{
		name: "micro-animation-director",
		kind: "skill",
		description: "motion and animation for HTML",
		source: "a",
	},
	{
		name: "galley-api",
		kind: "skill",
		description: "graphql recipe queries",
		source: "b",
	},
	{
		name: "debug-hypothesis",
		kind: "skill",
		description: "debug bugs scientifically",
		source: "c",
	},
];

let cachePath: string;
afterEach(() => {
	if (cachePath) rmSync(cachePath, { force: true });
});
function tmpCache(): string {
	cachePath = join(
		tmpdir(),
		`strudel-emb-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
	);
	return cachePath;
}

describe("cosine", () => {
	it("is 1 for identical, 0 for orthogonal", () => {
		expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
		expect(cosine([1, 0, 0], [0, 1, 0])).toBeCloseTo(0);
	});
	it("is 0 against a zero vector", () => {
		expect(cosine([0, 0, 0], [1, 1, 1])).toBe(0);
	});
});

describe("embedText", () => {
	it("combines name and description", () => {
		expect(
			embedText({
				name: "x",
				kind: "skill",
				description: "does y",
				source: "s",
			}),
		).toBe("x. does y");
	});
});

describe("semanticSearch", () => {
	it("ranks by meaning, not lexical token overlap", async () => {
		const embed = makeFakeEmbedder();
		const hits = await semanticSearch(
			items,
			"I need animation for a slide",
			embed,
			tmpCache(),
		);
		expect(hits[0].name).toBe("micro-animation-director");
	});

	it("caches item vectors — a second search re-embeds only the query", async () => {
		const path = tmpCache();
		const embed = makeFakeEmbedder();

		await semanticSearch(items, "animation", embed, path);
		// first run: 1 batch for the 3 item misses + 1 for the query = 4 embedded
		expect(embed.embedded).toBe(items.length + 1);

		const before = embed.embedded;
		await semanticSearch(items, "graphql", embed, path);
		// second run: items are cached → only the query is embedded
		expect(embed.embedded - before).toBe(1);
	});

	it("batches large pantries into multiple embed requests", async () => {
		const many: Primitive[] = Array.from({ length: 70 }, (_, i) => ({
			name: `s${i}`,
			kind: "skill",
			description: "x",
			source: `p${i}`,
		}));
		const embed = makeFakeEmbedder();
		await semanticSearch(many, "query", embed, tmpCache());
		// 70 items → 2 batches (64 + 6), plus 1 query batch = 3 calls
		expect(embed.calls).toBe(3);
	});

	it("returns empty for empty query or empty pantry", async () => {
		const embed = makeFakeEmbedder();
		expect(await semanticSearch(items, "  ", embed, tmpCache())).toEqual([]);
		expect(await semanticSearch([], "animation", embed, tmpCache())).toEqual(
			[],
		);
	});
});
