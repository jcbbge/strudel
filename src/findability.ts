/**
 * Findability self-test — strudel's immune system for retrieval quality.
 *
 * Every on-demand primitive carries intents ("what an agent would say when it
 * needs me"), either authored in frontmatter or synthesized from its name and
 * description. `runFindabilityCheck` replays every intent against a search
 * function and reports recall@k plus the DARK list — primitives that none of
 * their own intents can surface.
 */

import { type Primitive, isOnDemand } from "./pantry.js";

/** Hard ceiling on search calls per self-test run — sample primitives if exceeded. */
export const MAX_SEARCHES = 300;

/**
 * Derive up to 2 fallback intents for a primitive with no authored intents:
 * the first sentence of its description, and a name expansion (dashes and
 * underscores read as spaces).
 */
export function syntheticIntents(p: Primitive): string[] {
	const out: string[] = [];
	const firstSentence = p.description
		.split(/(?<=[.!?])\s+/)[0]
		?.trim()
		.replace(/[.!?]+$/, "");
	if (firstSentence) out.push(firstSentence.slice(0, 200));
	const expanded = p.name.replace(/[-_]+/g, " ").trim();
	if (expanded && expanded.toLowerCase() !== firstSentence?.toLowerCase()) {
		out.push(expanded);
	}
	return out.slice(0, 2);
}

/** Authored intents when present, synthetic fallbacks otherwise. */
export function intentsFor(p: Primitive): string[] {
	return p.intents?.length ? p.intents : syntheticIntents(p);
}

/** Minimal hit shape the check needs — any search result with name + kind works. */
export interface FindabilityHit {
	name: string;
	kind: string;
}

export type SearchFn = (
	query: string,
) => Promise<FindabilityHit[]> | FindabilityHit[];

export interface IntentResult {
	intent: string;
	found: boolean;
}

export interface PrimitiveFindability {
	name: string;
	kind: string;
	intents: IntentResult[];
	/** True when at least one of its intents surfaced it in the top-k. */
	found: boolean;
}

export interface FindabilityReport {
	/** Per-primitive results, in check order. */
	results: PrimitiveFindability[];
	/** Fraction of (primitive, intent) pairs where the primitive landed in top-k. */
	recallAtK: number;
	k: number;
	/** Primitives found by zero of their intents. */
	dark: PrimitiveFindability[];
	/** Total search calls made (capped at MAX_SEARCHES). */
	searches: number;
	/** True when the pantry was too large and only a sample was checked. */
	sampled: boolean;
}

export interface FindabilityOptions {
	k?: number;
	maxSearches?: number;
}

/**
 * Replay every on-demand primitive's intents against `searchFn` and record
 * whether the primitive appears in the top-k hits. Pure — the caller supplies
 * the search function, so this runs identically in lexical or semantic mode.
 */
export async function runFindabilityCheck(
	primitives: Primitive[],
	searchFn: SearchFn,
	opts: FindabilityOptions = {},
): Promise<FindabilityReport> {
	const k = opts.k ?? 5;
	const maxSearches = opts.maxSearches ?? MAX_SEARCHES;

	const candidates = primitives
		.filter(isOnDemand)
		.map((p) => ({ p, intents: intentsFor(p) }))
		.filter((c) => c.intents.length > 0);

	// Bound total searches: keep whole primitives (all their intents) until the
	// next one would blow the budget.
	let budget = maxSearches;
	const checked: typeof candidates = [];
	for (const c of candidates) {
		if (c.intents.length > budget) break;
		budget -= c.intents.length;
		checked.push(c);
	}
	const sampled = checked.length < candidates.length;

	const results: PrimitiveFindability[] = [];
	let searches = 0;
	let intentHits = 0;
	let intentTotal = 0;

	for (const { p, intents } of checked) {
		const intentResults: IntentResult[] = [];
		for (const intent of intents) {
			const hits = await searchFn(intent);
			searches++;
			const found = hits
				.slice(0, k)
				.some((h) => h.name === p.name && h.kind === p.kind);
			if (found) intentHits++;
			intentTotal++;
			intentResults.push({ intent, found });
		}
		results.push({
			name: p.name,
			kind: p.kind,
			intents: intentResults,
			found: intentResults.some((r) => r.found),
		});
	}

	return {
		results,
		recallAtK: intentTotal > 0 ? intentHits / intentTotal : 0,
		k,
		dark: results.filter((r) => !r.found),
		searches,
		sampled,
	};
}

/** Render the /health findability section from a report. */
export function formatFindability(report: FindabilityReport): string {
	const pct = (report.recallAtK * 100).toFixed(1);
	const darkNames = report.dark.slice(0, 10).map((d) => `${d.kind}/${d.name}`);
	const darkList =
		report.dark.length === 0
			? "  (none — every checked primitive is findable)"
			: darkNames.map((n) => `  ${n}`).join("\n") +
				(report.dark.length > 10
					? `\n  … and ${report.dark.length - 10} more`
					: "");

	let verdict: string;
	if (report.results.length === 0) {
		verdict = "no on-demand primitives with intents to check";
	} else if (report.dark.length === 0 && report.recallAtK >= 0.9) {
		verdict = "healthy — search surfaces the pantry reliably";
	} else if (report.dark.length > 0) {
		verdict = `${report.dark.length} primitive(s) are invisible to their own intents — fix descriptions or author intents`;
	} else {
		verdict = "findable but weak — consider authoring intents for low scorers";
	}

	return `Findability (self-test, ${report.searches} searches${report.sampled ? ", sampled" : ""}):
  recall@${report.k}: ${pct}% (${report.results.length} primitives checked)
  dark primitives: ${report.dark.length}
${darkList}
  verdict: ${verdict}`;
}
