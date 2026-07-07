/**
 * Telemetry bandit — strudel's online learning loop.
 *
 * Implements the spec at /Users/jrg/evals/specs/telemetry-bandit.md:
 * append-only JSONL event log (~/.strudel/telemetry.jsonl), decayed counters
 * (half-life 14d), Beta-smoothed adopt/succeed prior, confidence-gated blend
 * with the semantic score (λ capped at 0.35), ε-greedy exploration slot,
 * audit penalty demotion, privacy redaction, and size-bounded compaction
 * into per-(primitive, day) rollups.
 *
 * All time and randomness are injectable so tests are deterministic and never
 * touch the real ~/.strudel.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Ranked } from "./pantry.js";

// ---------------------------------------------------------------------------
// Constants (spec §2, §3, §5)

const DAY_MS = 86_400_000;
export const HALF_LIFE_MS = 14 * DAY_MS; // §3: H = 14 days
export const MAX_AGE_MS = 56 * DAY_MS; // §5: drop events older than 8 weeks
export const MAX_BYTES = 10 * 1024 * 1024; // §5: 10 MB cap
export const MAX_LINES = 50_000; // §5: 50k line cap
export const LAMBDA_CAP = 0.35; // §2: λ cap
export const EPSILON = 0.1; // §2: exploration probability
const QUERY_MAX_CHARS = 120; // §1/§5: query truncation

// ---------------------------------------------------------------------------
// Event schema (spec §1, §4, §5) — v:1; unknown v rejected at read time.

export interface SurfaceEvent {
	v: 1;
	kind: "surface";
	ts: string;
	session: string;
	query: string;
	primitive: string;
	rank: number;
	score: number;
	explore?: boolean;
}

export interface InvokeEvent {
	v: 1;
	kind: "invoke";
	ts: string;
	session: string;
	primitive: string;
	via: "prep" | "bake" | "direct";
	surfaced: boolean;
	latency_from_surface_ms: number | null;
}

export interface OutcomeEvent {
	v: 1;
	kind: "outcome";
	ts: string;
	session: string;
	primitive: string;
	ok: boolean;
	error: string | null;
	steps_run: number;
	steps_total: number;
}

export interface AuditEvent {
	v: 1;
	kind: "audit";
	ts: string;
	primitive: string;
	penalty: number;
	task?: string;
}

export interface RollupEvent {
	v: 1;
	kind: "rollup";
	primitive: string;
	day: string; // YYYY-MM-DD (UTC); decayed weight computed from day midpoint
	surface: number;
	invoke: number;
	win: number;
	fail: number;
	audit: number;
}

export type TelemetryEvent =
	| SurfaceEvent
	| InvokeEvent
	| OutcomeEvent
	| AuditEvent
	| RollupEvent;

/** Decayed counters per primitive (spec §2, §4.3). */
export interface Counters {
	surface: number; // S_p
	invoke: number; // I_p
	win: number; // W_p
	fail: number; // F_p
	/** Π penalty_i^decay(t_i) over audit events — multiplies prior_p. */
	penaltyMult: number;
}

// ---------------------------------------------------------------------------
// Pure functions

/** Exponential decay with half-life 14d (spec §3). Future timestamps clamp to 1. */
export function decay(eventMs: number, nowMs: number): number {
	const age = nowMs - eventMs;
	if (age <= 0) return 1;
	return 2 ** (-age / HALF_LIFE_MS);
}

/**
 * Privacy redaction for the query field (spec §5): drop any whitespace-token
 * matching (?i)(key|token|secret)[=:]\S+, redact /Users/<name> → ~, then
 * truncate to 120 chars.
 */
export function redactQuery(query: string): string {
	return query
		.replace(/\S*(key|token|secret)[=:]\S+/gi, "")
		.replace(/\/Users\/[^/\s]+/g, "~")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, QUERY_MAX_CHARS);
}

/** Beta-smoothed prior (α=1, β=1) × audit penalty multiplier (spec §2, §4.3). */
export function priorOf(c: Counters): number {
	const adopt = (c.invoke + 1) / (c.surface + 2);
	const succeed = (c.win + 1) / (c.win + c.fail + 2);
	return adopt * succeed * c.penaltyMult;
}

/** Confidence-gated blend weight: λ = min(0.35, I / (I + 8)) (spec §2). */
export function lambdaOf(c: Counters): number {
	return Math.min(LAMBDA_CAP, c.invoke / (c.invoke + 8));
}

/** Pantry-namespaced telemetry key for a primitive: `<kind>:<name>`. */
export function primitiveKey(p: { kind: string; name: string }): string {
	return `${p.kind}:${p.name}`;
}

function emptyCounters(): Counters {
	return { surface: 0, invoke: 0, win: 0, fail: 0, penaltyMult: 1 };
}

/** A ranked hit that came out of the bandit reranker. */
export type BanditRanked = Ranked & { explore?: boolean };

// ---------------------------------------------------------------------------
// Telemetry — the log + aggregator + reranker

export interface TelemetryOptions {
	/** Path to the JSONL event log. Tests point this at a tmpdir. */
	logPath: string;
	/** Injectable clock. Defaults to the wall clock. */
	now?: () => Date;
	/** Kill switch (spec §5): false disables all writes and forces λ = 0. */
	enabled?: boolean;
	/** Size-bound overrides for tests. Default to the spec caps. */
	maxBytes?: number;
	maxLines?: number;
}

export class Telemetry {
	readonly logPath: string;
	readonly enabled: boolean;
	private readonly now: () => Date;
	private readonly maxBytes: number;
	private readonly maxLines: number;
	private lineCount: number | undefined;

	constructor(opts: TelemetryOptions) {
		this.logPath = opts.logPath;
		this.enabled = opts.enabled !== false;
		this.now = opts.now ?? (() => new Date());
		this.maxBytes = opts.maxBytes ?? MAX_BYTES;
		this.maxLines = opts.maxLines ?? MAX_LINES;
	}

	/** Current time in epoch ms (for latency computation by callers). */
	nowMs(): number {
		return this.now().getTime();
	}

	// -- reading -------------------------------------------------------------

	/** Parse the log. Skips malformed lines and unknown schema versions. */
	readEvents(): TelemetryEvent[] {
		if (!existsSync(this.logPath)) return [];
		const events: TelemetryEvent[] = [];
		for (const line of readFileSync(this.logPath, "utf-8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const e = JSON.parse(line) as TelemetryEvent;
				if (e.v !== 1 || typeof e.kind !== "string") continue; // reject unknown v
				events.push(e);
			} catch {
				// Malformed line — skip, never break ranking.
			}
		}
		return events;
	}

	/** Decayed counters per primitive, computed lazily from the log (spec §2). */
	aggregate(): Map<string, Counters> {
		const nowMs = this.nowMs();
		const map = new Map<string, Counters>();
		const get = (p: string): Counters => {
			let c = map.get(p);
			if (!c) {
				c = emptyCounters();
				map.set(p, c);
			}
			return c;
		};
		for (const e of this.readEvents()) {
			if (e.kind === "rollup") {
				// Decayed weight from the day midpoint (spec §5).
				const mid = Date.parse(`${e.day}T12:00:00.000Z`);
				if (Number.isNaN(mid)) continue;
				const d = decay(mid, nowMs);
				const c = get(e.primitive);
				c.surface += e.surface * d;
				c.invoke += e.invoke * d;
				c.win += e.win * d;
				c.fail += e.fail * d;
				if (e.audit > 0) c.penaltyMult *= 0.5 ** (e.audit * d);
				continue;
			}
			const t = Date.parse(e.ts);
			if (Number.isNaN(t)) continue;
			const d = decay(t, nowMs);
			const c = get(e.primitive);
			switch (e.kind) {
				case "surface":
					c.surface += d;
					break;
				case "invoke":
					c.invoke += d;
					break;
				case "outcome":
					if (e.ok) c.win += d;
					else c.fail += d;
					break;
				case "audit":
					c.penaltyMult *= e.penalty ** d;
					break;
			}
		}
		return map;
	}

	// -- writing -------------------------------------------------------------

	private append(event: TelemetryEvent): void {
		if (!this.enabled) return;
		this.compactIfOverCap();
		mkdirSync(dirname(this.logPath), { recursive: true });
		appendFileSync(this.logPath, `${JSON.stringify(event)}\n`, "utf-8");
		this.lineCount = this.countLines() + 1;
	}

	private countLines(): number {
		if (this.lineCount !== undefined) return this.lineCount;
		if (!existsSync(this.logPath)) {
			this.lineCount = 0;
			return 0;
		}
		let n = 0;
		const text = readFileSync(this.logPath, "utf-8");
		for (let i = 0; i < text.length; i++) if (text[i] === "\n") n++;
		this.lineCount = n;
		return n;
	}

	private compactIfOverCap(): void {
		if (!existsSync(this.logPath)) return;
		const bytes = statSync(this.logPath).size;
		if (bytes < this.maxBytes && this.countLines() < this.maxLines) return;
		this.compact();
	}

	/**
	 * Compaction (spec §5): drop events older than 8 weeks, collapse the
	 * survivors per (primitive, day) into rollup lines whose decayed weight is
	 * later computed from the day midpoint. Existing rollups merge in.
	 */
	compact(): void {
		const nowMs = this.nowMs();
		const rollups = new Map<string, RollupEvent>();
		const get = (primitive: string, day: string): RollupEvent => {
			const key = `${primitive} ${day}`;
			let r = rollups.get(key);
			if (!r) {
				r = {
					v: 1,
					kind: "rollup",
					primitive,
					day,
					surface: 0,
					invoke: 0,
					win: 0,
					fail: 0,
					audit: 0,
				};
				rollups.set(key, r);
			}
			return r;
		};
		for (const e of this.readEvents()) {
			if (e.kind === "rollup") {
				const mid = Date.parse(`${e.day}T12:00:00.000Z`);
				if (Number.isNaN(mid) || nowMs - mid > MAX_AGE_MS) continue;
				const r = get(e.primitive, e.day);
				r.surface += e.surface;
				r.invoke += e.invoke;
				r.win += e.win;
				r.fail += e.fail;
				r.audit += e.audit;
				continue;
			}
			const t = Date.parse(e.ts);
			if (Number.isNaN(t) || nowMs - t > MAX_AGE_MS) continue;
			const day = new Date(t).toISOString().slice(0, 10);
			const r = get(e.primitive, day);
			switch (e.kind) {
				case "surface":
					r.surface += 1;
					break;
				case "invoke":
					r.invoke += 1;
					break;
				case "outcome":
					if (e.ok) r.win += 1;
					else r.fail += 1;
					break;
				case "audit":
					r.audit += 1;
					break;
			}
		}
		const lines = [...rollups.values()]
			.sort((a, b) =>
				a.day === b.day
					? a.primitive.localeCompare(b.primitive)
					: a.day.localeCompare(b.day),
			)
			.map((r) => JSON.stringify(r));
		mkdirSync(dirname(this.logPath), { recursive: true });
		writeFileSync(
			this.logPath,
			lines.length > 0 ? `${lines.join("\n")}\n` : "",
			"utf-8",
		);
		this.lineCount = lines.length;
	}

	// -- record helpers (hook points) -----------------------------------------

	recordSurface(e: {
		session: string;
		query: string;
		primitive: string;
		rank: number;
		score: number;
		explore?: boolean;
	}): void {
		this.append({
			v: 1,
			kind: "surface",
			ts: this.now().toISOString(),
			session: e.session,
			query: redactQuery(e.query),
			primitive: e.primitive,
			rank: e.rank,
			score: e.score,
			...(e.explore ? { explore: true } : {}),
		});
	}

	recordInvoke(e: {
		session: string;
		primitive: string;
		via: "prep" | "bake" | "direct";
		surfaced: boolean;
		latencyFromSurfaceMs?: number | null;
	}): void {
		this.append({
			v: 1,
			kind: "invoke",
			ts: this.now().toISOString(),
			session: e.session,
			primitive: e.primitive,
			via: e.via,
			surfaced: e.surfaced,
			latency_from_surface_ms: e.latencyFromSurfaceMs ?? null,
		});
	}

	recordOutcome(e: {
		session: string;
		primitive: string;
		ok: boolean;
		error: string | null;
		stepsRun: number;
		stepsTotal: number;
	}): void {
		this.append({
			v: 1,
			kind: "outcome",
			ts: this.now().toISOString(),
			session: e.session,
			primitive: e.primitive,
			ok: e.ok,
			error: e.error,
			steps_run: e.stepsRun,
			steps_total: e.stepsTotal,
		});
	}

	recordAudit(e: { primitive: string; penalty: number; task?: string }): void {
		this.append({
			v: 1,
			kind: "audit",
			ts: this.now().toISOString(),
			primitive: e.primitive,
			penalty: e.penalty,
			...(e.task ? { task: e.task } : {}),
		});
	}

	// -- ranking (spec §2) -----------------------------------------------------

	/**
	 * Blend the telemetry prior into a semantically-ranked result set:
	 * `final = (1-λ)·sem + λ·prior`, sem min-max normalized within the set.
	 * With probability ε = 0.10 the last slot is given to the best-by-sem
	 * primitive that the blend demoted, flagged `explore: true`.
	 *
	 * Disabled telemetry or an empty log returns the hits unchanged
	 * (cold start = no-op, spec Acceptance #1).
	 */
	rerank(hits: Ranked[], rng: () => number = Math.random): BanditRanked[] {
		if (!this.enabled || hits.length === 0) return hits;
		const agg = this.aggregate();
		if (agg.size === 0) return hits;

		let min = Number.POSITIVE_INFINITY;
		let max = Number.NEGATIVE_INFINITY;
		for (const h of hits) {
			if (h.score < min) min = h.score;
			if (h.score > max) max = h.score;
		}
		const span = max - min;

		const entries = hits.map((h, i) => {
			const sem = span > 0 ? (h.score - min) / span : 0.5;
			const c = agg.get(primitiveKey(h));
			const lambda = c ? lambdaOf(c) : 0;
			const prior = c ? priorOf(c) : 0;
			return { h, i, sem, final: (1 - lambda) * sem + lambda * prior };
		});

		// Stable sort by blended score (ties keep semantic order).
		const sorted = [...entries].sort((a, b) => b.final - a.final || a.i - b.i);
		let out: BanditRanked[] = sorted.map((e) => e.h);

		// Exploration floor (spec §2): ε chance the last slot goes to the
		// best-by-sem primitive that telemetry down-weighted.
		if (rng() < EPSILON && hits.length > 1) {
			const finalRank = new Map(sorted.map((e, r) => [e.i, r]));
			const demoted = entries.filter((e) => (finalRank.get(e.i) ?? 0) > e.i);
			if (demoted.length > 0) {
				demoted.sort((a, b) => b.sem - a.sem || a.i - b.i);
				const pick = demoted[0];
				out = out.filter((h) => h !== pick.h);
				out.push({ ...pick.h, explore: true });
			}
		}
		return out;
	}
}
