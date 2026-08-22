/**
 * Metrics rollup over the event log — the experiment's scoreboard.
 * Conflict rate, test-failure rate, latency percentiles, lock contention,
 * and the isolation-economics counters (C3).
 */

import { readFileSync } from "node:fs";
import type {
	IntentAppliedEvent,
	IntentRejectedEvent,
	PatchEvent,
} from "./log.js";
import type { RejectionKind } from "./schema.js";

export interface PatchMetrics {
	intents: number;
	applied: number;
	rejected: number;
	byKind: Record<RejectionKind, number>;
	conflictRate: number;
	testFailureRate: number;
	latencyMsP50: number;
	latencyMsP95: number;
	lockWaitMsP95: number;
	isolationBytesCopied: 0;
}

export function summarize(events: PatchEvent[]): PatchMetrics {
	const byKind = {
		invalid: 0,
		conflict: 0,
		test_failure: 0,
		stale_base: 0,
		busy: 0,
		dirty_tree: 0,
	} as Record<RejectionKind, number>;
	const appliedEvents: IntentAppliedEvent[] = [];
	const rejectedEvents: IntentRejectedEvent[] = [];
	let received = 0;

	for (const e of events) {
		if (e.type === "intent_received") received++;
		else if (e.type === "intent_applied") appliedEvents.push(e);
		else if (e.type === "intent_rejected") {
			rejectedEvents.push(e);
			byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
		}
	}

	const appliedSet = new Set(appliedEvents.map((e) => e.intent_id));

	// Spec §6: test-failure rate is measured after clean application —
	// failures / attempts that reached the verification stage. A rejected
	// intent never reached tests, so it does not dilute this rate. An intent
	// that failed tests then succeeded on revision counts once as failure
	// (the attempt happened) and its success still counts as applied.
	const intentsThatReachedTests = new Set(appliedSet);
	for (const r of rejectedEvents)
		if (r.kind === "test_failure") intentsThatReachedTests.add(r.intent_id);
	const testFailures = byKind.test_failure;

	return {
		intents: received,
		applied: appliedEvents.length,
		rejected: rejectedEvents.length,
		byKind,
		conflictRate:
			received === 0
				? 0
				: round2(
						rejectedEvents.filter((r) => r.kind === "conflict").length /
							received,
					),
		testFailureRate:
			intentsThatReachedTests.size === 0
				? 0
				: round2(testFailures / intentsThatReachedTests.size),
		latencyMsP50: percentile(
			appliedEvents.map((e) => e.ms),
			0.5,
		),
		latencyMsP95: percentile(
			appliedEvents.map((e) => e.ms),
			0.95,
		),
		lockWaitMsP95: percentile(
			[
				...appliedEvents.map((e) => e.lock_wait_ms),
				...rejectedEvents
					.filter((r) => r.kind !== "busy")
					.map((e) => e.lock_wait_ms),
			],
			0.95,
		),
		isolationBytesCopied: 0,
	};
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
}

function round2(n: number): number {
	return Math.round(n * 100) / 100;
}

export function loadEvents(path: string): PatchEvent[] {
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as PatchEvent);
}
