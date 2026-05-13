/**
 * Pantry + Cupboard schema bootstrap. Idempotent — safe to run on every
 * connect. All tables live under `ns=strudel/db=bakery` (the namespace acts
 * as the strudel tenant boundary inside a multi-tenant SurrealDB instance).
 *
 * Tables:
 *   ingredient          — the manifest catalog (one row per registered primitive)
 *   cupboard            — staged raw foraged candidates awaiting curation
 *
 * Indexes:
 *   ingredient_name     — unique on name
 *   ingredient_kind     — secondary on kind for fast listing
 *   ingredient_tags     — array index for tag lookups
 *   ingredient_embed    — HNSW vector index on embedding (created on demand
 *                         when the first embedded ingredient lands; SurrealDB
 *                         requires a fixed dimension so we defer.)
 *   cupboard_paradigm   — secondary on source_paradigm
 *   cupboard_reviewed   — secondary on reviewed for "show unreviewed" queries
 */

import type { SurrealClient } from "./surreal.js";

const PANTRY_SQL = `
DEFINE TABLE IF NOT EXISTS ingredient SCHEMALESS PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS name        ON ingredient TYPE string;
DEFINE FIELD IF NOT EXISTS kind        ON ingredient TYPE string;
DEFINE FIELD IF NOT EXISTS flavor      ON ingredient TYPE string;
DEFINE FIELD IF NOT EXISTS description ON ingredient TYPE option<string>;
DEFINE FIELD IF NOT EXISTS tags        ON ingredient TYPE option<array<string>>;
DEFINE FIELD IF NOT EXISTS shelf       ON ingredient TYPE string;
DEFINE FIELD IF NOT EXISTS stage       ON ingredient TYPE string DEFAULT 'active';
DEFINE FIELD IF NOT EXISTS version     ON ingredient TYPE string;
DEFINE FIELD IF NOT EXISTS embedding   ON ingredient TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS updated_at  ON ingredient TYPE string;

DEFINE INDEX IF NOT EXISTS ingredient_name ON ingredient COLUMNS name UNIQUE;
DEFINE INDEX IF NOT EXISTS ingredient_kind ON ingredient COLUMNS kind;
DEFINE INDEX IF NOT EXISTS ingredient_tags ON ingredient COLUMNS tags;
`;

const CUPBOARD_SQL = `
DEFINE TABLE IF NOT EXISTS cupboard SCHEMALESS PERMISSIONS NONE;

DEFINE FIELD IF NOT EXISTS source_path     ON cupboard TYPE string;
DEFINE FIELD IF NOT EXISTS source_paradigm ON cupboard TYPE string;
DEFINE FIELD IF NOT EXISTS content_size    ON cupboard TYPE number;
DEFINE FIELD IF NOT EXISTS raw_content     ON cupboard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS content_path    ON cupboard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS adapter_meta    ON cupboard TYPE option<object>;
DEFINE FIELD IF NOT EXISTS seen_at         ON cupboard TYPE array<string>;
DEFINE FIELD IF NOT EXISTS discovered_at   ON cupboard TYPE string;
DEFINE FIELD IF NOT EXISTS reviewed        ON cupboard TYPE bool DEFAULT false;
DEFINE FIELD IF NOT EXISTS promoted_to     ON cupboard TYPE option<string>;
DEFINE FIELD IF NOT EXISTS updated_at      ON cupboard TYPE string;

DEFINE INDEX IF NOT EXISTS cupboard_paradigm ON cupboard COLUMNS source_paradigm;
DEFINE INDEX IF NOT EXISTS cupboard_reviewed ON cupboard COLUMNS reviewed;
`;

let pantrySchemaApplied: WeakSet<SurrealClient> | undefined;
let cupboardSchemaApplied: WeakSet<SurrealClient> | undefined;
let namespaceEnsured: WeakSet<SurrealClient> | undefined;

/**
 * Ensure the strudel namespace and bakery database exist. SurrealDB rejects
 * the surreal-ns/db headers when the namespace does not yet exist, so this
 * runs without scope headers. Idempotent per client.
 */
async function ensureNamespace(client: SurrealClient): Promise<void> {
	namespaceEnsured ??= new WeakSet();
	if (namespaceEnsured.has(client)) return;
	await client.queryRoot(
		`DEFINE NAMESPACE IF NOT EXISTS \`${client.namespace}\`;
		 USE NS \`${client.namespace}\`;
		 DEFINE DATABASE IF NOT EXISTS \`${client.database}\`;`,
	);
	namespaceEnsured.add(client);
}

/** Apply the Pantry (ingredient table) schema once per client instance. */
export async function ensureSchema(client: SurrealClient): Promise<void> {
	pantrySchemaApplied ??= new WeakSet();
	if (pantrySchemaApplied.has(client)) return;
	await ensureNamespace(client);
	await client.query(PANTRY_SQL);
	pantrySchemaApplied.add(client);
}

/** Apply the Cupboard (cupboard table) schema once per client instance. */
export async function ensureCupboardSchema(client: SurrealClient): Promise<void> {
	cupboardSchemaApplied ??= new WeakSet();
	if (cupboardSchemaApplied.has(client)) return;
	await ensureNamespace(client);
	await client.query(CUPBOARD_SQL);
	cupboardSchemaApplied.add(client);
}

/**
 * Define (idempotently) the HNSW vector index on `embedding`. Called the first
 * time an ingredient with an embedding is registered, when we know the
 * dimension.
 */
export async function ensureEmbeddingIndex(client: SurrealClient, dimension: number): Promise<void> {
	if (!Number.isInteger(dimension) || dimension <= 0) return;
	const sql = `DEFINE INDEX IF NOT EXISTS ingredient_embedding
		ON ingredient FIELDS embedding HNSW DIMENSION ${dimension} DIST COSINE;`;
	await client.query(sql);
}
