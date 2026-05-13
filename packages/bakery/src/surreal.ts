/**
 * Minimal HTTP-based SurrealDB client. Mirrors the pattern in
 * /Users/jrg/infinity/artifacts/surreal_client.ts but trimmed to what the
 * Pantry needs.
 *
 * Implementation note: uses Node's `http`/`https` modules instead of `fetch`
 * because undici (Node's bundled fetch) hard-blocks "unsafe" ports such as
 * 6000 (X11) with `Error: bad port`, which is the default SurrealDB port in
 * this environment.
 */

import http, { type RequestOptions } from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface SurrealClientOptions {
	url?: string;
	namespace?: string;
	database?: string;
	user?: string;
	pass?: string;
	token?: string;
	timeoutMs?: number;
}

const DEFAULT_URL = "http://127.0.0.1:6000";
const DEFAULT_NAMESPACE = "strudel";
const DEFAULT_DATABASE = "bakery";
const DEFAULT_USER = "root";
const DEFAULT_PASS = "surreal";
const DEFAULT_TIMEOUT_MS = 8000;

interface SurrealStatementResult<T = unknown> {
	status: "OK" | "ERR" | string;
	time?: string;
	result?: T;
	detail?: string;
}

export class SurrealClient {
	private readonly sqlEndpoint: string;
	readonly namespace: string;
	readonly database: string;
	private readonly authHeader: string;
	private readonly timeoutMs: number;

	constructor(options: SurrealClientOptions = {}) {
		const rawUrl = (options.url ?? process.env.STRUDEL_SURREAL_URL ?? DEFAULT_URL).trim();
		const baseUrl = normalizeBaseUrl(rawUrl).replace(/\/$/, "");

		this.sqlEndpoint = `${baseUrl}/sql`;
		this.namespace = options.namespace ?? process.env.STRUDEL_SURREAL_NS ?? DEFAULT_NAMESPACE;
		this.database = options.database ?? process.env.STRUDEL_SURREAL_DB ?? DEFAULT_DATABASE;

		const token = options.token ?? process.env.STRUDEL_SURREAL_TOKEN;
		if (token && token.trim().length > 0) {
			this.authHeader = `Bearer ${token}`;
		} else {
			const user = options.user ?? process.env.STRUDEL_SURREAL_USER ?? DEFAULT_USER;
			const pass = options.pass ?? process.env.STRUDEL_SURREAL_PASS ?? DEFAULT_PASS;
			this.authHeader = `Basic ${Buffer.from(`${user}:${pass}`, "utf8").toString("base64")}`;
		}

		this.timeoutMs = options.timeoutMs ?? Number(process.env.STRUDEL_SURREAL_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
	}

	get info(): { url: string; namespace: string; database: string } {
		return { url: this.sqlEndpoint.replace(/\/sql$/, ""), namespace: this.namespace, database: this.database };
	}

	/** Execute a SurrealQL query and return the merged result rows. */
	async query<T = unknown>(sql: string, vars?: Record<string, unknown>): Promise<T[]> {
		const statements = await this.queryRaw<T>(sql, vars);
		const merged: T[] = [];
		for (const stmt of statements) {
			if (stmt.status !== "OK") {
				throw new Error(`SurrealDB query failed: ${stmt.detail ?? JSON.stringify(stmt.result)}`);
			}
			if (Array.isArray(stmt.result)) {
				merged.push(...(stmt.result as T[]));
			} else if (stmt.result !== undefined && stmt.result !== null) {
				merged.push(stmt.result as T);
			}
		}
		return merged;
	}

	/**
	 * Execute SurrealQL at the root level (no ns/db scope). Useful for bootstrap
	 * statements like DEFINE NAMESPACE / DEFINE DATABASE that must run before the
	 * scope headers can be sent.
	 */
	async queryRoot<T = unknown>(sql: string): Promise<SurrealStatementResult<T>[]> {
		return this.queryRaw<T>(sql, undefined, { scope: false });
	}

	/** Execute and return per-statement results (preserves boundaries). */
	async queryRaw<T = unknown>(
		sql: string,
		vars?: Record<string, unknown>,
		opts: { scope?: boolean } = {},
	): Promise<SurrealStatementResult<T>[]> {
		const timeout = Number.isFinite(this.timeoutMs) && this.timeoutMs > 0 ? this.timeoutMs : DEFAULT_TIMEOUT_MS;
		const includeScope = opts.scope !== false;
		const headers: Record<string, string> = {
			Accept: "application/json",
			"Content-Type": "text/plain",
			Authorization: this.authHeader,
		};
		if (includeScope) {
			headers["surreal-ns"] = this.namespace;
			headers["surreal-db"] = this.database;
		}

		const body = vars && Object.keys(vars).length > 0 ? prefixWithVars(sql, vars) : sql;

		const {
			status,
			statusText,
			body: raw,
		} = await httpRequest(this.sqlEndpoint, {
			method: "POST",
			headers,
			body,
			timeoutMs: timeout,
		});

		if (status < 200 || status >= 300) {
			throw new Error(`SurrealDB HTTP ${status} ${statusText}${raw ? `: ${raw}` : ""}`);
		}

		if (!raw) return [];

		const payload = JSON.parse(raw);
		if (!Array.isArray(payload)) {
			throw new Error("Unexpected SurrealDB response format (expected array of statement results)");
		}
		return payload as SurrealStatementResult<T>[];
	}

	/** Cheap connectivity probe. Returns the round-trip time in ms or throws. */
	async ping(): Promise<number> {
		const start = Date.now();
		await this.query("RETURN 1");
		return Date.now() - start;
	}
}

function prefixWithVars(sql: string, vars: Record<string, unknown>): string {
	// SurrealDB HTTP /sql does not accept variables in body. Inline as LET statements.
	const lets: string[] = [];
	for (const [key, value] of Object.entries(vars)) {
		lets.push(`LET $${key} = ${JSON.stringify(value)};`);
	}
	return `${lets.join("\n")}\n${sql}`;
}

interface HttpRequestOptions {
	method: string;
	headers: Record<string, string>;
	body?: string;
	timeoutMs: number;
}

interface HttpResponse {
	status: number;
	statusText: string;
	body: string;
}

function httpRequest(targetUrl: string, opts: HttpRequestOptions): Promise<HttpResponse> {
	return new Promise((resolve, reject) => {
		let parsed: URL;
		try {
			parsed = new URL(targetUrl);
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const isHttps = parsed.protocol === "https:";
		const transport = isHttps ? https : http;

		const headers: Record<string, string> = { ...opts.headers };
		if (opts.body !== undefined) {
			headers["Content-Length"] = String(Buffer.byteLength(opts.body, "utf8"));
		}

		const requestOptions: RequestOptions = {
			protocol: parsed.protocol,
			hostname: parsed.hostname,
			port: parsed.port || (isHttps ? 443 : 80),
			path: `${parsed.pathname}${parsed.search}`,
			method: opts.method,
			headers,
		};

		const req = transport.request(requestOptions, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				resolve({
					status: res.statusCode ?? 0,
					statusText: res.statusMessage ?? "",
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
			res.on("error", reject);
		});

		req.setTimeout(opts.timeoutMs, () => {
			req.destroy(new Error(`SurrealDB request timed out after ${opts.timeoutMs}ms`));
		});

		req.on("error", reject);

		if (opts.body !== undefined) req.write(opts.body);
		req.end();
	});
}

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim();
	const normalized = /^wss?:\/\//i.test(trimmed)
		? trimmed.replace(/^wss?:\/\//i, (p) => (p.toLowerCase() === "wss://" ? "https://" : "http://"))
		: /^https?:\/\//i.test(trimmed)
			? trimmed
			: `http://${trimmed}`;
	return new URL(normalized).origin;
}
