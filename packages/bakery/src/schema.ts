/**
 * Pantry schema bootstrap. Idempotent — safe to run on every connect.
 *
 * Tables:
 *   ingredient          — the manifest catalog
 *
 * Indexes:
 *   ingredient_name     — unique on name
 *   ingredient_kind     — secondary on kind for fast listing
 *   ingredient_tags     — array index for tag lookups
 *   ingredient_embed    — HNSW vector index on embedding (created on demand
 *                         when the first embedded ingredient lands; SurrealDB
 *                         requires a fixed dimension so we defer.)
 */

import type { SurrealClient } from "./surreal.js";

const SCHEMA_SQL = `
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

let schemaApplied: WeakSet<SurrealClient> | undefined;

/** Apply the Pantry schema once per client instance. */
export async function ensureSchema(client: SurrealClient): Promise<void> {
	schemaApplied ??= new WeakSet();
	if (schemaApplied.has(client)) return;
	// SurrealDB rejects the surreal-ns/db headers when the namespace does not
	// yet exist, so we issue DEFINE NAMESPACE / DEFINE DATABASE without scope
	// headers before applying the rest of the schema.
	await client.queryRoot(
		`DEFINE NAMESPACE IF NOT EXISTS \`${client.namespace}\`;
		 USE NS \`${client.namespace}\`;
		 DEFINE DATABASE IF NOT EXISTS \`${client.database}\`;`,
	);
	await client.query(SCHEMA_SQL);
	schemaApplied.add(client);
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
