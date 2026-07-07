/**
 * Surface control — make strudel the default discovery path, not an extra tool.
 *
 * On every turn (before_agent_start) strudel locks the agent's tool surface to a
 * small baseline plus whatever it has surfaced this session, and strips Pi's
 * dump-everything `<available_skills>` block from the system prompt — replacing
 * it with a pointer to strudel_search.
 *
 * Pure functions here so the behavior is unit-tested without Pi.
 */

export const GATEWAY_TOOL = "strudel_search";

/** Pragmatic (B): the always-needed file tools. Strict (A): bare minimum. */
const PRAGMATIC_BASELINE = ["read", "write", "edit", "bash", "subagent", "strudel_prep", "strudel_bake"];
const STRICT_BASELINE = ["read", "subagent", "strudel_prep", "strudel_bake"];

export type SurfaceMode = "pragmatic" | "strict";

/**
 * The baseline tool names for a surface mode. `override` (config.baseline) wins
 * when provided, so power users can tune exactly what stays always-on.
 */
export function baselineTools(
	mode: SurfaceMode,
	override?: string[],
): string[] {
	if (override && override.length > 0) return override;
	return mode === "strict" ? STRICT_BASELINE : PRAGMATIC_BASELINE;
}

/**
 * The active tool surface for a turn: the gateway + baseline + session-activated
 * primitives, intersected with what's actually registered. The gateway is always
 * present (without it the agent can't discover anything).
 */
export function computeActiveSurface(
	baseline: string[],
	activated: string[],
	available: Set<string>,
): string[] {
	const want = new Set<string>([GATEWAY_TOOL, ...baseline, ...activated]);
	return [...want].filter((n) => n === GATEWAY_TOOL || available.has(n));
}

/**
 * Refresh recency for an activated tool. `activated` is a Set used as an LRU:
 * insertion order = recency order, so touching = delete + re-add (moves the
 * name to the back). No-op if the name isn't activated.
 */
export function touchActivated(activated: Set<string>, name: string): void {
	if (!activated.has(name)) return;
	activated.delete(name);
	activated.add(name);
}

/**
 * Evict least-recently-USED entries until the set fits under `max`. Assumes
 * recency is maintained via touchActivated, so the front of the Set is the
 * least recently used.
 */
export function evictOverCap(activated: Set<string>, max: number): void {
	while (activated.size > max) {
		const lru = activated.values().next().value;
		if (lru === undefined) break;
		activated.delete(lru);
	}
}

const POINTER =
	"Capability discovery: this prompt does not list every skill, tool, MCP, or command available. " +
	"Call the `strudel_search` tool with your intent to find the right ones, then use them.";

/** Remove Pi's `<available_skills>` dump and point the agent at strudel_search. */
export function stripSkillsBlock(systemPrompt: string): string {
	let p = systemPrompt.replace(
		/\n*<available_skills>[\s\S]*?<\/available_skills>\n*/g,
		"\n",
	);
	if (!p.includes("Call the `strudel_search` tool")) {
		p = `${p.trimEnd()}\n\n${POINTER}\n`;
	}
	return p;
}

/**
 * Pi's system prompt is built with the full active tool set BEFORE before_agent_start
 * fires, so its "Available tools:" section advertises everything even after we
 * lock the executable surface. Prune that section to only the kept tools so the
 * prompt the agent reads matches what it can actually call.
 *
 * The section is `Available tools:\n` followed by `- name: snippet` lines.
 */
export function pruneToolsSection(
	systemPrompt: string,
	keep: Set<string>,
): string {
	return systemPrompt.replace(
		/(Available tools:\n)((?:-[^\n]*\n?)+)/,
		(_full, header: string, body: string) => {
			const kept = body.split("\n").filter((line) => {
				const m = line.match(/^- ([^:]+):/);
				return m ? keep.has(m[1].trim()) : false;
			});
			const list = kept.length > 0 ? `${kept.join("\n")}\n` : "";
			return `${header}${list}(Other capabilities are not listed — call strudel_search to find them.)\n`;
		},
	);
}
