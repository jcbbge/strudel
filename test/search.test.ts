/**
 * Search-strategy unit tests. The no-embeddings and fallback paths are
 * verifiable without any live endpoint (the fallback test relies only on a
 * connection error to a dead local port, which any error satisfies).
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Primitive } from "../src/pantry.js";
import { search } from "../src/search.js";

const items: Primitive[] = [
	{
		name: "micro-animation-director",
		kind: "skill",
		description: "motion for HTML presentations",
		source: "a",
	},
	{
		name: "galley-api",
		kind: "skill",
		description: "graphql queries",
		source: "b",
	},
];
const cachePath = join(tmpdir(), `strudel-search-test-${Date.now()}.json`);

describe("search", () => {
	it("uses lexical when no embeddings are configured", async () => {
		const { hits, mode } = await search(items, "animate a presentation", {
			cachePath,
		});
		expect(mode).toBe("lexical");
		expect(hits[0].name).toBe("micro-animation-director");
	});

	it("falls back to lexical when the embeddings endpoint errors", async () => {
		const { hits, mode } = await search(items, "animate a presentation", {
			embeddings: { baseUrl: "http://127.0.0.1:1/v1", model: "none" },
			cachePath,
		});
		expect(mode).toBe("lexical");
		expect(hits[0].name).toBe("micro-animation-director");
	});

	it("respects the limit parameter", async () => {
		const manyItems: Primitive[] = Array.from({ length: 20 }, (_, i) => ({
			name: `skill-${i}`,
			kind: "skill",
			description: `skill number ${i}`,
			source: `source-${i}`,
		}));

		const { hits } = await search(manyItems, "skill", {
			cachePath,
			limit: 5,
		});
		expect(hits.length).toBeLessThanOrEqual(5);
	});

	it("returns empty array for empty items", async () => {
		const { hits, mode } = await search([], "anything", { cachePath });
		expect(hits).toEqual([]);
		expect(mode).toBe("lexical");
	});

	it("returns empty array for query with no matches", async () => {
		const { hits } = await search(items, "quantum physics", { cachePath });
		expect(hits).toEqual([]);
	});

	it("defaults to limit of 8", async () => {
		const manyItems: Primitive[] = Array.from({ length: 20 }, (_, i) => ({
			name: `thing-${i}`,
			kind: "skill",
			description: "thing",
			source: `s-${i}`,
		}));

		const { hits } = await search(manyItems, "thing", { cachePath });
		expect(hits.length).toBeLessThanOrEqual(8);
	});
});
