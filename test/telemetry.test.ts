/**
 * Telemetry bandit tests — the 5 acceptance criteria from
 * bench/agent-evals/specs/telemetry-bandit.md plus privacy redaction, the
 * exploration slot, the kill switch, and an integration pass through the
 * registered tools (search → bake) on a mock Pi.
 *
 * Every Telemetry instance points at a tmpdir and gets an injected clock —
 * the real ~/.strudel is never touched.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import strudel from "../src/index.js";
import { resetToolsDir, setToolsDir } from "../src/oven.js";
import type { Ranked } from "../src/pantry.js";
import { search } from "../src/search.js";
import {
	decay,
	HALF_LIFE_MS,
	MAX_LINES,
	redactQuery,
	Telemetry,
	type TelemetryEvent,
} from "../src/telemetry.js";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-07-02T12:00:00.000Z");
const fixedNow = () => NOW;

let testRoot: string;
let logPath: string;

beforeEach(() => {
	testRoot = join(
		tmpdir(),
		`strudel-telemetry-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	mkdirSync(testRoot, { recursive: true });
	logPath = join(testRoot, "telemetry.jsonl");
});

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
	delete process.env.STRUDEL_CONFIG_PATH;
	delete process.env.STRUDEL_TELEMETRY_PATH;
	resetToolsDir();
});

function tel(overrides: Partial<ConstructorParameters<typeof Telemetry>[0]> = {}): Telemetry {
	return new Telemetry({ logPath, now: fixedNow, ...overrides });
}

/** A writer whose events are stamped at `NOW - daysAgo`. */
function writerAt(daysAgo: number): Telemetry {
	return new Telemetry({
		logPath,
		now: () => new Date(NOW.getTime() - daysAgo * DAY_MS),
	});
}

function seedWin(primitive: string, daysAgo: number, session = "s1"): void {
	const w = writerAt(daysAgo);
	w.recordSurface({ session, query: "q", primitive, rank: 1, score: 0.9 });
	w.recordInvoke({ session, primitive, via: "bake", surfaced: true });
	w.recordOutcome({ session, primitive, ok: true, error: null, stepsRun: 1, stepsTotal: 1 });
}

function hit(name: string, score: number, kind = "recipe"): Ranked {
	return { name, kind, description: `${name} desc`, source: `test:${name}`, score };
}

const noExplore = () => 0.99;

// ---------------------------------------------------------------------------
// Privacy redaction (spec §1, §5)

describe("redaction", () => {
	it("truncates queries to 120 chars", () => {
		expect(redactQuery("x".repeat(300))).toHaveLength(120);
	});

	it("redacts /Users/<name> to ~", () => {
		expect(redactQuery("read /Users/jrg/notes.md please")).toBe("read ~/notes.md please");
	});

	it("drops secret-looking tokens", () => {
		const out = redactQuery("call api_key=sk-12345 and TOKEN:abc then go");
		expect(out).not.toContain("sk-12345");
		expect(out).not.toContain("abc");
		expect(out).toContain("call");
		expect(out).toContain("then go");
	});

	it("applies redaction on recordSurface", () => {
		const t = tel();
		t.recordSurface({
			session: "s",
			query: `secret=hunter2 in /Users/jrg/x ${"y".repeat(200)}`,
			primitive: "recipe:a",
			rank: 1,
			score: 0.5,
		});
		const [e] = t.readEvents() as Array<Extract<TelemetryEvent, { kind: "surface" }>>;
		expect(e.query).not.toContain("hunter2");
		expect(e.query).not.toContain("/Users/");
		expect(e.query.length).toBeLessThanOrEqual(120);
	});
});

// ---------------------------------------------------------------------------
// AC1 — cold start is a no-op

describe("acceptance 1: cold start", () => {
	it("rerank with an empty log returns the hits unchanged", () => {
		const hits = [hit("a", 0.9), hit("b", 0.5), hit("c", 0.1)];
		expect(tel().rerank(hits, noExplore)).toBe(hits);
	});

	it("search() with the bandit and an empty log ranks identically to search() without", async () => {
		const prims = [
			hit("alpha reader", 0),
			hit("beta writer", 0),
			hit("gamma reader tool", 0),
		].map(({ score: _s, ...p }) => p);
		const cachePath = join(testRoot, "cache.json");
		const plain = await search(prims, "reader", { cachePath });
		const banded = await search(prims, "reader", {
			cachePath,
			bandit: tel(),
			rng: noExplore,
		});
		expect(banded).toEqual(plain);
	});
});

// ---------------------------------------------------------------------------
// AC2 — win lift

describe("acceptance 2: wins lift ranking iff the semantic gap is small enough", () => {
	// 5 fresh wins for recipe:a → I=5, λ=min(0.35, 5/13)=0.35,
	// adopt = 6/7, succeed = 6/7, prior ≈ 0.7347.
	beforeEach(() => {
		for (let i = 0; i < 5; i++) seedWin("recipe:a", 0, `s${i}`);
	});

	it("lifts A above B when the sem gap < the λ-weighted prior gap", () => {
		// Normalized sems: c=1, b=0.5, a=0.4, d=0. final_a = 0.65·0.4 + 0.35·0.7347 ≈ 0.517 > 0.5.
		const hits = [hit("c", 1.0), hit("b", 0.5), hit("a", 0.4), hit("d", 0.0)];
		const out = tel().rerank(hits, noExplore);
		expect(out.map((h) => h.name)).toEqual(["c", "a", "b", "d"]);
	});

	it("does not lift A when the sem gap is too large", () => {
		const hits = [hit("c", 1.0), hit("b", 0.6), hit("a", 0.4), hit("d", 0.0)];
		const out = tel().rerank(hits, noExplore);
		expect(out.map((h) => h.name)).toEqual(["c", "b", "a", "d"]);
	});
});

// ---------------------------------------------------------------------------
// AC3 — decay

describe("acceptance 3: decay", () => {
	it("decay() halves at 14 days", () => {
		expect(decay(NOW.getTime() - HALF_LIFE_MS, NOW.getTime())).toBeCloseTo(0.5, 10);
	});

	it("a 15-day-old win counts less than half a fresh win", () => {
		seedWin("recipe:old", 15);
		seedWin("recipe:fresh", 0);
		const agg = tel().aggregate();
		const oldWin = agg.get("recipe:old")?.win ?? -1;
		const freshWin = agg.get("recipe:fresh")?.win ?? -1;
		expect(freshWin).toBeCloseTo(1, 10);
		expect(oldWin).toBeGreaterThan(0);
		expect(oldWin).toBeLessThan(0.5 * freshWin);
	});
});

// ---------------------------------------------------------------------------
// AC4 — audit demotion

describe("acceptance 4: audit penalty demotes below a semantically-equal rival", () => {
	beforeEach(() => {
		// Identical usage records for both.
		for (let i = 0; i < 3; i++) {
			seedWin("recipe:a", 0, `sa${i}`);
			seedWin("recipe:b", 0, `sb${i}`);
		}
	});

	it("without an audit, equal rivals keep semantic (input) order", () => {
		const out = tel().rerank([hit("a", 0.7), hit("b", 0.7)], noExplore);
		expect(out.map((h) => h.name)).toEqual(["a", "b"]);
	});

	it("with an audit penalty on A, B ranks above A", () => {
		tel().recordAudit({ primitive: "recipe:a", penalty: 0.5, task: "exp-bake-01" });
		const out = tel().rerank([hit("a", 0.7), hit("b", 0.7)], noExplore);
		expect(out.map((h) => h.name)).toEqual(["b", "a"]);
	});
});

// ---------------------------------------------------------------------------
// AC5 — compaction

describe("acceptance 5: compaction at the size cap preserves aggregates", () => {
	it("compacts to rollups and keeps decayed counters within 5%", () => {
		const prims = ["recipe:x", "recipe:y", "tool:z"];
		const lines: string[] = [];
		for (let i = 0; i < MAX_LINES + 100; i++) {
			const primitive = prims[i % prims.length];
			const ts = new Date(NOW.getTime() - (i % 20) * DAY_MS).toISOString();
			const kindPick = i % 4;
			if (kindPick === 0) {
				lines.push(
					JSON.stringify({ v: 1, kind: "surface", ts, session: "s", query: "q", primitive, rank: 1, score: 0.5 }),
				);
			} else if (kindPick === 1) {
				lines.push(
					JSON.stringify({ v: 1, kind: "invoke", ts, session: "s", primitive, via: "bake", surfaced: true, latency_from_surface_ms: 10 }),
				);
			} else {
				lines.push(
					JSON.stringify({ v: 1, kind: "outcome", ts, session: "s", primitive, ok: kindPick === 2, error: kindPick === 2 ? null : "step_failed:1", steps_run: 1, steps_total: 1 }),
				);
			}
		}
		writeFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

		const t = tel();
		const before = t.aggregate();
		// Append one event for an unrelated primitive — trips the line cap.
		t.recordSurface({ session: "s", query: "q", primitive: "recipe:new", rank: 1, score: 0.5 });

		const content = readFileSync(logPath, "utf-8").trim().split("\n");
		expect(content.length).toBeLessThan(200); // O(primitives × days), not O(events)
		expect(content.length).toBeGreaterThan(prims.length); // real rollups exist
		const rollups = content.map((l) => JSON.parse(l)).filter((e) => e.kind === "rollup");
		expect(rollups.length).toBeGreaterThan(0);

		const after = t.aggregate();
		for (const p of prims) {
			const b = before.get(p);
			const a = after.get(p);
			expect(b).toBeDefined();
			expect(a).toBeDefined();
			if (!b || !a) continue;
			for (const field of ["surface", "invoke", "win", "fail"] as const) {
				expect(Math.abs(a[field] - b[field]) / b[field]).toBeLessThan(0.05);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Exploration slot (spec §2)

describe("exploration slot", () => {
	beforeEach(() => {
		for (let i = 0; i < 5; i++) seedWin("recipe:a", 0, `s${i}`);
	});

	it("with rng < ε, the demoted best-by-sem primitive takes the last slot, flagged explore", () => {
		const hits = [hit("c", 1.0), hit("b", 0.5), hit("a", 0.4), hit("d", 0.0)];
		const out = tel().rerank(hits, () => 0.05);
		// Blend demotes b (sem rank 2 → blend rank 3); explore moves it to the last slot.
		expect(out.map((h) => h.name)).toEqual(["c", "a", "d", "b"]);
		expect(out[out.length - 1].explore).toBe(true);
		expect(out.slice(0, -1).every((h) => !h.explore)).toBe(true);
	});

	it("with rng ≥ ε, no explore flag appears", () => {
		const hits = [hit("c", 1.0), hit("b", 0.5), hit("a", 0.4), hit("d", 0.0)];
		const out = tel().rerank(hits, noExplore);
		expect(out.every((h) => !h.explore)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Kill switch (spec §5)

describe("kill switch", () => {
	it("enabled:false writes nothing and reranks as identity", () => {
		const t = tel({ enabled: false });
		t.recordSurface({ session: "s", query: "q", primitive: "recipe:a", rank: 1, score: 0.5 });
		t.recordInvoke({ session: "s", primitive: "recipe:a", via: "bake", surfaced: false });
		t.recordOutcome({ session: "s", primitive: "recipe:a", ok: true, error: null, stepsRun: 1, stepsTotal: 1 });
		expect(existsSync(logPath)).toBe(false);
		const hits = [hit("a", 0.9), hit("b", 0.5)];
		expect(t.rerank(hits, noExplore)).toBe(hits);
	});
});

// ---------------------------------------------------------------------------
// Integration — search → bake through the registered tools on a mock Pi

function createMockPi() {
	const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }>();
	return {
		registerTool(t: { name: string; execute: (id: string, params: Record<string, unknown>) => Promise<unknown> }) {
			tools.set(t.name, t);
		},
		registerCommand(_name: string, _opts: unknown) {},
		on(_event: string, _handler: unknown) {},
		setActiveTools(_active: string[]) {},
		sendMessage(_msg: unknown) {},
		getAllTools: () => [
			{ name: "read", description: "Read files from disk" },
			{ name: "bash", description: "Run a bash command" },
		],
		getCommands: () => [] as Array<{ name: string; description: string }>,
		_tool: (name: string) => tools.get(name),
	};
}

async function loadExtension(config: Record<string, unknown>) {
	const configPath = join(testRoot, "config.json");
	const pantryRoot = join(testRoot, "pantry");
	mkdirSync(pantryRoot, { recursive: true });
	writeFileSync(configPath, JSON.stringify({ pantry: { roots: [pantryRoot] }, ...config }));
	process.env.STRUDEL_CONFIG_PATH = configPath;
	process.env.STRUDEL_TELEMETRY_PATH = logPath;

	const toolsDir = join(testRoot, "tools");
	mkdirSync(toolsDir, { recursive: true });
	writeFileSync(
		join(toolsDir, "ok.ts"),
		"export default async function ok(_inputs: Record<string, unknown>) { return { done: true }; }\n",
	);
	setToolsDir(toolsDir);

	const pi = createMockPi();
	await strudel(pi as never);
	return pi;
}

describe("integration: search → bake hooks", () => {
	it("logs surface, invoke, and outcome events to the configured log", async () => {
		const pi = await loadExtension({});

		await pi._tool("strudel_search")?.execute("t1", { query: "read files from disk" });
		await pi._tool("strudel_bake")?.execute("t2", {
			goal: "test bake",
			layers: [{ step: 1, ingredient: "ok", inputs: {} }],
		});

		expect(existsSync(logPath)).toBe(true);
		const events = readFileSync(logPath, "utf-8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l)) as Array<Record<string, unknown>>;
		const kinds = new Set(events.map((e) => e.kind));
		expect(kinds.has("surface")).toBe(true);
		expect(kinds.has("invoke")).toBe(true);
		expect(kinds.has("outcome")).toBe(true);

		const surface = events.find((e) => e.kind === "surface");
		expect(surface?.v).toBe(1);
		expect(surface?.rank).toBe(1);
		expect(typeof surface?.session).toBe("string");

		const invoke = events.find((e) => e.kind === "invoke");
		expect(invoke?.primitive).toBe("tool:ok");
		expect(invoke?.via).toBe("bake");

		const outcome = events.find((e) => e.kind === "outcome");
		expect(outcome?.ok).toBe(true);
		expect(outcome?.error).toBeNull();
		expect(outcome?.steps_run).toBe(1);
		expect(outcome?.steps_total).toBe(1);
	});

	it("telemetry:false produces zero writes", async () => {
		const pi = await loadExtension({ telemetry: false });

		await pi._tool("strudel_search")?.execute("t1", { query: "read files from disk" });
		await pi._tool("strudel_bake")?.execute("t2", {
			goal: "test bake",
			layers: [{ step: 1, ingredient: "ok", inputs: {} }],
		});

		expect(existsSync(logPath)).toBe(false);
	});
});
