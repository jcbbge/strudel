/**
 * The Cupboard — staging area for raw foraged candidates before they become
 * Pantry ingredients.
 *
 * The Cupboard sits in the same SurrealDB namespace as the Pantry
 * (`ns=strudel/db=bakery`) but in a separate `cupboard` table because the row
 * shape is genuinely different: no flavor, no embedding, but raw_content,
 * source_paradigm, and review state.
 *
 * Lifecycle of a candidate:
 *   1. forage   →  Cupboard.stash()        (Phase ①, mechanical)
 *   2. review   →  cupboard-curator         (Phase ②, Track 2)
 *   3. promote  →  Cupboard.markReviewed() + Pantry.register()
 *
 * Idempotency: candidates are keyed by SHA-256 content hash, so re-foraging
 * the same content from any path collapses into one row. The `seen_at` array
 * preserves every path the content has been observed at.
 */

import type { RawCandidate, SourceParadigm } from "./forager.js";
import { ensureCupboardSchema } from "./schema.js";
import { SurrealClient, type SurrealClientOptions } from "./surreal.js";

export interface CupboardOptions {
	surreal?: SurrealClient | SurrealClientOptions;
}

/** A row stored in the cupboard table. */
export interface CupboardRow extends RawCandidate {
	/** Every path this content has been observed at. First entry == source_path. */
	seen_at: string[];
	/** Has the curator reviewed this candidate? */
	reviewed: boolean;
	/** If reviewed and accepted, the ingredient.name it was promoted to. */
	promoted_to?: string;
	/** ISO timestamp of the most recent stash() that touched this row. */
	updated_at: string;
}

export interface CupboardListOptions {
	paradigm?: SourceParadigm;
	reviewed?: boolean;
	limit?: number;
}

export interface StashSummary {
	/** Number of new rows inserted (content not previously in the cupboard). */
	inserted: number;
	/** Number of existing rows updated (same content, possibly new path). */
	updated: number;
	/** Per-paradigm count. */
	by_paradigm: Partial<Record<SourceParadigm, number>>;
}

export class Cupboard {
	private readonly client: SurrealClient;
	private initialized = false;

	constructor(options: CupboardOptions = {}) {
		this.client = options.surreal instanceof SurrealClient ? options.surreal : new SurrealClient(options.surreal);
	}

	get info(): { surreal: { url: string; namespace: string; database: string } } {
		return { surreal: this.client.info };
	}

	async init(): Promise<void> {
		if (this.initialized) return;
		await ensureCupboardSchema(this.client);
		this.initialized = true;
	}

	/** Upsert a candidate. Idempotent on content hash. */
	async stash(candidate: RawCandidate): Promise<{ inserted: boolean; row: CupboardRow }> {
		await this.init();
		const existing = await this.get(candidate.id);
		const now = new Date().toISOString();

		if (existing) {
			const seen = new Set(existing.seen_at);
			seen.add(candidate.source_path);
			const merged: CupboardRow = {
				...existing,
				// Refresh content / size / paradigm in case the file was updated
				// in place (same hash → impossible, but path-tracking still useful).
				source_path: existing.source_path, // first-seen path wins
				source_paradigm: existing.source_paradigm,
				content_size: candidate.content_size,
				raw_content: candidate.raw_content ?? existing.raw_content,
				content_path: candidate.content_path ?? existing.content_path,
				adapter_meta: { ...existing.adapter_meta, ...candidate.adapter_meta },
				seen_at: Array.from(seen),
				updated_at: now,
			};
			await this.upsert(merged);
			return { inserted: false, row: merged };
		}

		const row: CupboardRow = {
			...candidate,
			seen_at: [candidate.source_path],
			reviewed: false,
			updated_at: now,
		};
		await this.upsert(row);
		return { inserted: true, row };
	}

	/** Fetch one candidate by content hash. Tolerates the `cupboard:` prefix. */
	async get(id: string): Promise<CupboardRow | undefined> {
		await this.init();
		const bare = stripPrefix(id);
		const rows = await this.client.query<CupboardRow>("SELECT * FROM type::record('cupboard', $id)", { id: bare });
		return rows[0] ? normalizeRow(rows[0]) : undefined;
	}

	/** List cupboard rows with optional filters. Newest first. */
	async list(options: CupboardListOptions = {}): Promise<CupboardRow[]> {
		await this.init();
		const limit = options.limit ?? 100;
		const filters: string[] = [];
		const vars: Record<string, unknown> = { limit };
		if (options.paradigm) {
			filters.push("source_paradigm = $paradigm");
			vars.paradigm = options.paradigm;
		}
		if (options.reviewed !== undefined) {
			filters.push("reviewed = $reviewed");
			vars.reviewed = options.reviewed;
		}
		const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";
		const sql = `SELECT * FROM cupboard ${where} ORDER BY updated_at DESC LIMIT $limit`;
		const rows = await this.client.query<CupboardRow>(sql, vars);
		return rows.map(normalizeRow);
	}

	/** Mark a candidate reviewed; optionally record the promotion target. */
	async markReviewed(id: string, promotedTo?: string): Promise<void> {
		await this.init();
		await this.client.query(
			"UPDATE type::record('cupboard', $id) SET reviewed = true, promoted_to = $promoted, updated_at = $now",
			{ id: stripPrefix(id), promoted: promotedTo, now: new Date().toISOString() },
		);
	}

	/** Aggregate counts for a /strudel cupboard summary. */
	async summary(): Promise<{ total: number; reviewed: number; by_paradigm: Record<string, number> }> {
		await this.init();
		const rows = await this.list({ limit: 10000 });
		const by: Record<string, number> = {};
		let reviewed = 0;
		for (const row of rows) {
			by[row.source_paradigm] = (by[row.source_paradigm] ?? 0) + 1;
			if (row.reviewed) reviewed += 1;
		}
		return { total: rows.length, reviewed, by_paradigm: by };
	}

	/** Wipe the cupboard. Used by /strudel cupboard reset. */
	async reset(): Promise<void> {
		await this.init();
		await this.client.query("DELETE cupboard");
	}

	private async upsert(row: CupboardRow): Promise<void> {
		const bare = stripPrefix(row.id);
		await this.client.query("UPSERT type::record('cupboard', $id) CONTENT $content", {
			id: bare,
			content: { ...row, id: bare },
		});
	}
}

/**
 * Strip the `cupboard:` SurrealDB record-id prefix so the documented
 * "id is the SHA-256 content hash" contract holds for callers.
 */
function stripPrefix(id: string): string {
	return id.startsWith("cupboard:") ? id.slice("cupboard:".length) : id;
}

/** Apply id normalization to a row read from SurrealDB. */
function normalizeRow(row: CupboardRow): CupboardRow {
	return { ...row, id: stripPrefix(row.id) };
}
