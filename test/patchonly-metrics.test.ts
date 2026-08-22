/**
 * Metrics rollup — the experiment's scoreboard must be honest before the
 * experiment runs. Synthetic logs, exact expected rollups.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PatchEvent } from "../src/patchonly/log.js";
import { loadEvents, summarize } from "../src/patchonly/metrics.js";

function ev(
	partial: Partial<PatchEvent> & { type: PatchEvent["type"] },
): PatchEvent {
	return { ts: 1, intent_id: "i", agent_id: "a", ...partial } as PatchEvent;
}

describe("summarize", () => {
	it("returns zeros on an empty log", () => {
		const m = summarize([]);
		expect(m).toMatchObject({
			intents: 0,
			applied: 0,
			rejected: 0,
			conflictRate: 0,
			testFailureRate: 0,
		});
	});

	it("computes conflict rate over all received intents", () => {
		const events: PatchEvent[] = [];
		for (let i = 0; i < 4; i++) {
			events.push(ev({ type: "intent_received", intent_id: `i${i}` }));
		}
		events.push(
			ev({
				type: "intent_applied",
				intent_id: "i0",
				commit: "c",
				ms: 100,
				lock_wait_ms: 5,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
		);
		events.push(
			ev({
				type: "intent_rejected",
				intent_id: "i1",
				kind: "conflict",
				detail: "d",
				ms: 10,
				lock_wait_ms: 0,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
		);
		events.push(
			ev({
				type: "intent_rejected",
				intent_id: "i2",
				kind: "stale_base",
				detail: "d",
				ms: 10,
				lock_wait_ms: 0,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
		);
		const m = summarize(events);
		expect(m.intents).toBe(4);
		expect(m.applied).toBe(1);
		expect(m.byKind.conflict).toBe(1);
		expect(m.byKind.stale_base).toBe(1);
		expect(m.conflictRate).toBe(0.25);
	});

	it("computes test-failure rate over intents that reached verification, not all intents", () => {
		const events: PatchEvent[] = [
			ev({ type: "intent_received", intent_id: "a" }),
			ev({ type: "intent_received", intent_id: "b" }),
			ev({ type: "intent_received", intent_id: "c" }),
			// a: failed tests, then succeeded on revision (2 attempts, 1 failure, 1 apply)
			ev({
				type: "intent_rejected",
				intent_id: "a",
				kind: "test_failure",
				detail: "d",
				ms: 1,
				lock_wait_ms: 0,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
			ev({
				type: "intent_applied",
				intent_id: "a",
				commit: "c",
				ms: 10,
				lock_wait_ms: 0,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
			// b: applied clean
			ev({
				type: "intent_applied",
				intent_id: "b",
				commit: "c",
				ms: 20,
				lock_wait_ms: 0,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
			// c: rejected on conflict — never reached tests, must not dilute the rate
			ev({
				type: "intent_rejected",
				intent_id: "c",
				kind: "conflict",
				detail: "d",
				ms: 1,
				lock_wait_ms: 0,
				isolation_cost: { files_copied: 0, bytes_copied: 0 },
			}),
		];
		const m = summarize(events);
		// Reached tests: {a, b} → 1 failure / 2 = 0.5
		expect(m.testFailureRate).toBe(0.5);
		expect(m.conflictRate).toBeCloseTo(1 / 3);
	});

	it("reports latency percentiles and zero isolation bytes (C3 is structural)", () => {
		const events: PatchEvent[] = [];
		for (let i = 1; i <= 100; i++) {
			events.push(ev({ type: "intent_received", intent_id: `i${i}` }));
			events.push(
				ev({
					type: "intent_applied",
					intent_id: `i${i}`,
					commit: "c",
					ms: i,
					lock_wait_ms: i,
					isolation_cost: { files_copied: 0, bytes_copied: 0 },
				}),
			);
		}
		const m = summarize(events);
		expect(m.latencyMsP50).toBe(50);
		expect(m.latencyMsP95).toBe(95);
		expect(m.lockWaitMsP95).toBe(95);
		expect(m.isolationBytesCopied).toBe(0);
	});

	it("loads a real JSONL file from disk", () => {
		// round-trips through the same format appendEvent writes
		const dir = mkdtempSync(join(tmpdir(), "patchonly-metrics-"));
		const path = join(dir, "events.jsonl");
		const line = `${JSON.stringify({
			type: "intent_received",
			ts: 1,
			intent_id: "x",
			agent_id: "a",
			edits: 1,
		})}\n`;
		writeFileSync(path, line);
		expect(loadEvents(path)).toHaveLength(1);
		rmSync(dir, { recursive: true, force: true });
	});
});
