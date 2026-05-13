/**
 * The Pantry — SurrealDB-backed catalog of all bakery ingredients.
 *
 * Surface is intentionally narrow:
 *   register / upsert / get / list / search / recordBake
 *
 * Behavior knobs:
 *   - If a LocalLlm is provided AND reachable, registration auto-tags
 *     untagged ingredients and computes embeddings. Search then prefers
 *     vector similarity. Otherwise everything falls back to lexical
 *     matching against name + flavor + tags.
 */

import type { LocalLlm } from "./llm.js";
import { ensureEmbeddingIndex, ensureSchema } from "./schema.js";
import { SurrealClient, type SurrealClientOptions } from "./surreal.js";
import type {
	BakeHistoryEntry,
	IngredientKind,
	IngredientManifest,
	IngredientStage,
	PantrySearchHit,
	ShelfLocation,
	UsageStats,
} from "./types.js";

/** Maximum bake_history entries kept per ingredient. */
const MAX_BAKE_HISTORY = 25;

export interface PantryOptions {
	surreal?: SurrealClient | SurrealClientOptions;
	llm?: LocalLlm;
	/** Enable best-effort auto-tagging on register. Default: true. */
	autoTag?: boolean;
	/** Enable best-effort embedding on register. Default: true. */
	autoEmbed?: boolean;
}

/** Input shape for register(); fields not provided get sensible defaults. */
export interface RegisterInput {
	name: string;
	kind: IngredientKind;
	flavor: string;
	description?: string;
	input_schema?: unknown;
	output_schema?: unknown;
	examples?: string[];
	tags?: string[];
	shelf?: ShelfLocation;
	stage?: IngredientStage;
	version?: string;
	dependencies?: string[];
	source?: Record<string, unknown>;
}

export interface SearchOptions {
	limit?: number;
	kind?: IngredientKind;
	tags?: string[];
}

export class Pantry {
	private readonly client: SurrealClient;
	private readonly llm?: LocalLlm;
	private readonly autoTag: boolean;
	private readonly autoEmbed: boolean;
	private embeddingDimension: number | undefined;
	private initialized = false;

	constructor(options: PantryOptions = {}) {
		this.client = options.surreal instanceof SurrealClient ? options.surreal : new SurrealClient(options.surreal);
		this.llm = options.llm;
		this.autoTag = options.autoTag !== false;
		this.autoEmbed = options.autoEmbed !== false;
	}

	get info(): {
		surreal: { url: string; namespace: string; database: string };
		llm: { baseUrl: string; chatModel: string; embeddingModel: string } | undefined;
	} {
		return {
			surreal: this.client.info,
			llm: this.llm?.info,
		};
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await ensureSchema(this.client);
		this.initialized = true;
	}

	/** Register or update an ingredient. */
	async register(input: RegisterInput): Promise<IngredientManifest> {
		await this.init();
		const now = new Date().toISOString();

		const existing = await this.get(input.name);

		let tags = input.tags;
		if (this.autoTag && (!tags || tags.length === 0) && this.llm) {
			const auto = await this.llm.tag({
				name: input.name,
				flavor: input.flavor,
				description: input.description,
			});
			if (auto && auto.length > 0) tags = auto;
		}

		let embedding: number[] | undefined;
		if (this.autoEmbed && this.llm) {
			const embedText = [input.name, input.flavor, input.description ?? "", ...(tags ?? [])]
				.filter(Boolean)
				.join("\n");
			embedding = await this.llm.embed(embedText);
			if (embedding && embedding.length > 0) {
				if (this.embeddingDimension === undefined) {
					this.embeddingDimension = embedding.length;
					await ensureEmbeddingIndex(this.client, embedding.length);
				}
			}
		}

		const manifest: IngredientManifest = {
			name: input.name,
			kind: input.kind,
			flavor: input.flavor,
			description: input.description,
			input_schema: input.input_schema,
			output_schema: input.output_schema,
			examples: input.examples,
			tags,
			embedding,
			shelf: input.shelf ?? existing?.shelf ?? "front_shelf",
			stage: input.stage ?? existing?.stage ?? "active",
			usage_stats: existing?.usage_stats ?? { bakes: 0, successes: 0, failures: 0 },
			bake_history: existing?.bake_history ?? [],
			version: input.version ?? existing?.version ?? "0.0.1",
			dependencies: input.dependencies ?? existing?.dependencies,
			source: input.source ?? existing?.source,
			updated_at: now,
		};

		await this.client.query("UPSERT type::record('ingredient', $name) CONTENT $content", {
			name: input.name,
			content: manifest,
		});
		return manifest;
	}

	/** Fetch a single ingredient by name. */
	async get(name: string): Promise<IngredientManifest | undefined> {
		await this.init();
		const rows = await this.client.query<IngredientManifest>("SELECT * FROM type::record('ingredient', $name)", {
			name,
		});
		return rows[0];
	}

	/** List ingredients, optionally filtered by kind. */
	async list(options: { kind?: IngredientKind; limit?: number } = {}): Promise<IngredientManifest[]> {
		await this.init();
		const limit = options.limit ?? 100;
		if (options.kind) {
			return this.client.query<IngredientManifest>(
				"SELECT * FROM ingredient WHERE kind = $kind ORDER BY updated_at DESC LIMIT $limit",
				{ kind: options.kind, limit },
			);
		}
		return this.client.query<IngredientManifest>("SELECT * FROM ingredient ORDER BY updated_at DESC LIMIT $limit", {
			limit,
		});
	}

	/** Hybrid search: semantic when embeddings are available, lexical otherwise. */
	async search(query: string, options: SearchOptions = {}): Promise<PantrySearchHit[]> {
		await this.init();
		const limit = options.limit ?? 10;

		if (this.llm && (await this.llm.isAvailable())) {
			const queryEmbedding = await this.llm.embed(query);
			if (queryEmbedding && queryEmbedding.length > 0) {
				const semantic = await this.semanticSearch(queryEmbedding, limit, options);
				if (semantic.length > 0) return semantic;
			}
		}

		return this.lexicalSearch(query, limit, options);
	}

	/** Append a bake-history entry and bump usage stats. */
	async recordBake(name: string, entry: BakeHistoryEntry): Promise<void> {
		await this.init();
		const existing = await this.get(name);
		if (!existing) return;
		const stats: UsageStats = {
			bakes: existing.usage_stats.bakes + 1,
			successes: existing.usage_stats.successes + (entry.outcome === "success" ? 1 : 0),
			failures: existing.usage_stats.failures + (entry.outcome === "failure" ? 1 : 0),
			last_baked_at: entry.at,
		};
		const history = [entry, ...existing.bake_history].slice(0, MAX_BAKE_HISTORY);
		await this.client.query(
			"UPDATE type::record('ingredient', $name) SET usage_stats = $stats, bake_history = $history, updated_at = $now",
			{ name, stats, history, now: new Date().toISOString() },
		);
	}

	/** Wipe everything in the Pantry. Used by /strudel pantry reset. */
	async reset(): Promise<void> {
		await this.init();
		await this.client.query("DELETE ingredient");
	}

	private async semanticSearch(
		queryEmbedding: number[],
		limit: number,
		options: SearchOptions,
	): Promise<PantrySearchHit[]> {
		const filters: string[] = ["embedding != NONE"];
		const vars: Record<string, unknown> = { embedding: queryEmbedding, limit };
		if (options.kind) {
			filters.push("kind = $kind");
			vars.kind = options.kind;
		}
		if (options.tags && options.tags.length > 0) {
			filters.push("tags ?? [] CONTAINSANY $tags");
			vars.tags = options.tags;
		}
		const sql = `
			SELECT *, vector::similarity::cosine(embedding, $embedding) AS _score
			FROM ingredient
			WHERE ${filters.join(" AND ")}
			ORDER BY _score DESC
			LIMIT $limit;
		`;
		try {
			const rows = await this.client.query<IngredientManifest & { _score?: number }>(sql, vars);
			return rows.map((row) => {
				const { _score, ...manifest } = row;
				return {
					manifest: manifest as IngredientManifest,
					score: typeof _score === "number" ? _score : 0,
					via: "semantic" as const,
				};
			});
		} catch {
			return [];
		}
	}

	private async lexicalSearch(query: string, limit: number, options: SearchOptions): Promise<PantrySearchHit[]> {
		const needle = query.trim().toLowerCase();
		const tokens = needle.split(/\s+/).filter(Boolean);
		const all = await this.list({ kind: options.kind, limit: 1000 });
		const tagFilter = options.tags && options.tags.length > 0 ? new Set(options.tags) : undefined;

		const scored: PantrySearchHit[] = [];
		for (const manifest of all) {
			if (tagFilter && !(manifest.tags ?? []).some((t) => tagFilter.has(t))) continue;
			const haystack = [manifest.name, manifest.flavor, manifest.description ?? "", ...(manifest.tags ?? [])]
				.join(" ")
				.toLowerCase();

			let score = 0;
			let via: PantrySearchHit["via"] = "flavor";
			if (manifest.name.toLowerCase().includes(needle)) {
				score += 1;
				via = "name";
			}
			for (const tag of manifest.tags ?? []) {
				if (tokens.some((t) => tag.toLowerCase() === t)) {
					score += 0.6;
					via = "tag";
				}
			}
			for (const token of tokens) {
				if (haystack.includes(token)) score += 0.2;
			}

			if (score > 0) scored.push({ manifest, score, via });
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit);
	}
}
