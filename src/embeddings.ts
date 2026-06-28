/**
 * L1 — semantic search via embeddings. Opt-in.
 *
 * OpenAI-compatible (`POST {baseUrl}/embeddings`), so it works with any local
 * server (mlx-omni, Ollama, LM Studio, llama.cpp), a hosted endpoint, or a
 * keyed provider (OpenAI, OpenRouter, ...). If no embeddings config is present,
 * strudel_search stays on L0 lexical — zero infrastructure by default.
 *
 * Item vectors are cached on disk by content hash, so only changed primitives
 * re-embed; repeat searches cost one query embedding.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Primitive, Ranked } from "./pantry.js";

export interface EmbeddingConfig {
	/** e.g. http://127.0.0.1:10240/v1 */
	baseUrl: string;
	model: string;
	/** Optional bearer token for hosted/keyed providers. */
	apiKey?: string;
}

export type Embedder = (texts: string[]) => Promise<number[][]>;

const REQUEST_TIMEOUT_MS = 60_000; // first call can cold-start a local model (3-10s+)
const EMBED_BATCH = 64; // chunk large pantries so one request can't blow the timeout

/** OpenAI-compatible embeddings client. */
export function httpEmbedder(cfg: EmbeddingConfig): Embedder {
	const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
	return async (texts) => {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
			},
			body: JSON.stringify({ model: cfg.model, input: texts }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!res.ok) {
			throw new Error(
				`embeddings ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`,
			);
		}
		const json = (await res.json()) as {
			data?: Array<{ embedding: number[] }>;
		};
		if (!json.data || json.data.length !== texts.length) {
			throw new Error("embeddings: unexpected response shape");
		}
		return json.data.map((d) => d.embedding);
	};
}

export function cosine(a: number[], b: number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		na += a[i] * a[i];
		nb += b[i] * b[i];
	}
	const denom = Math.sqrt(na) * Math.sqrt(nb);
	return denom === 0 ? 0 : dot / denom;
}

/** The text representation that gets embedded for a primitive. */
export function embedText(p: Primitive): string {
	return p.description ? `${p.name}. ${p.description}` : p.name;
}

function hash(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

type Cache = Record<string, number[]>;

async function loadCache(path: string): Promise<Cache> {
	try {
		return JSON.parse(await readFile(path, "utf-8")) as Cache;
	} catch {
		return {};
	}
}

async function saveCache(path: string, cache: Cache): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, JSON.stringify(cache));
	} catch {
		// best-effort cache; a write failure must not break search
	}
}

/**
 * Semantic (L1) search. Embeds items (cached by content hash) + the query, then
 * ranks by cosine similarity. `embed` is injected so this is testable without a
 * live endpoint.
 */
export async function semanticSearch(
	items: Primitive[],
	query: string,
	embed: Embedder,
	cachePath: string,
	limit = 8,
): Promise<Ranked[]> {
	if (items.length === 0 || query.trim().length === 0) return [];

	const cache = await loadCache(cachePath);
	const texts = items.map(embedText);
	const keys = texts.map(hash);

	const missIdx: number[] = [];
	for (let i = 0; i < keys.length; i++) {
		if (!cache[keys[i]]) missIdx.push(i);
	}
	if (missIdx.length > 0) {
		const missTexts = missIdx.map((i) => texts[i]);
		const vecs: number[][] = [];
		for (let b = 0; b < missTexts.length; b += EMBED_BATCH) {
			vecs.push(...(await embed(missTexts.slice(b, b + EMBED_BATCH))));
		}
		missIdx.forEach((i, k) => {
			cache[keys[i]] = vecs[k];
		});
		await saveCache(cachePath, cache);
	}

	const [qvec] = await embed([query]);
	const ranked: Ranked[] = items.map((it, i) => ({
		...it,
		score: cosine(qvec, cache[keys[i]]),
	}));
	ranked.sort((a, b) => b.score - a.score);
	return ranked.slice(0, limit);
}
