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
});
