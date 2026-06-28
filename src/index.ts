/**
 * Strudel — a Pi extension that fixes primitive overload.
 *
 * Search agent primitives (skills, tools, MCP tools, commands, rules, ...) by
 * intent instead of registering all of them into the context window.
 *
 * The Pantry indexes configured roots (kind inferred from the subdirectory
 * name) + the live runtime registry. strudel_search ranks across all kinds:
 * L1 semantic when an embeddings endpoint is configured, else L0 lexical. Each
 * turn the agent's tool surface is locked to a baseline (everything else is
 * discovered via the gateway) and Pi's dump-everything prompt sections are pruned.
 *
 * Run locally:  pi -e src/index.ts -p "..."
 * Config:       ~/.strudel/config.json
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { EmbeddingConfig } from "./embeddings.js";
import { type Primitive, indexRoots } from "./pantry.js";
import { search } from "./search.js";
import {
	type SurfaceMode,
	baselineTools,
	computeActiveSurface,
	pruneToolsSection,
	stripSkillsBlock,
} from "./surface.js";

const STRUDEL_VERSION = "0.0.0";
const DEFAULT_ROOTS = ["~/.pi/agent"];
const CACHE_PATH = join(homedir(), ".strudel", "cache", "embeddings.json");
const MAX_ACTIVATED = 24; // bound the session surface so it can't slowly re-bloat

interface StrudelConfig {
	roots: string[];
	embeddings?: EmbeddingConfig;
	surface: SurfaceMode;
	baseline?: string[];
}

async function loadConfig(): Promise<StrudelConfig> {
	const cfgPath = join(homedir(), ".strudel", "config.json");
	try {
		const parsed = JSON.parse(await readFile(cfgPath, "utf-8")) as {
			pantry?: { roots?: string[] };
			embeddings?: EmbeddingConfig;
			surface?: SurfaceMode;
			baseline?: string[];
		};
		const roots = parsed.pantry?.roots;
		return {
			roots: Array.isArray(roots) && roots.length > 0 ? roots : DEFAULT_ROOTS,
			embeddings: parsed.embeddings,
			surface: parsed.surface === "strict" ? "strict" : "pragmatic",
			baseline: parsed.baseline,
		};
	} catch {
		return { roots: DEFAULT_ROOTS, surface: "pragmatic" };
	}
}

/** The code-resident primitives Pi already has: tools + slash-commands. */
function runtimePrimitives(pi: ExtensionAPI): Primitive[] {
	return [
		...pi.getAllTools().map((t) => ({
			name: t.name,
			kind: "tool",
			description: t.description ?? "",
			source: "runtime:tool",
		})),
		...pi.getCommands().map((c) => ({
			name: c.name,
			kind: "command",
			description: c.description ?? "",
			source: "runtime:command",
		})),
	];
}

export default async function strudel(pi: ExtensionAPI): Promise<void> {
	const config = await loadConfig();
	const fileIndex = await indexRoots(config.roots);

	const byKind = new Map<string, number>();
	for (const p of fileIndex) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
	const kindSummary = [...byKind.entries()]
		.map(([k, n]) => `${k}:${n}`)
		.join(" ");
	const searchMode = config.embeddings
		? `semantic (${config.embeddings.model})`
		: "lexical";
	console.error(
		`[strudel ${STRUDEL_VERSION}] pantry: ${fileIndex.length} file-primitives from ${config.roots.length} roots (${kindSummary}) | search: ${searchMode} | surface: ${config.surface}`,
	);

	const baseline = baselineTools(config.surface, config.baseline);
	// Code primitives strudel has surfaced this session — kept active (bounded) so
	// the agent can call them after discovering them (curate-and-run).
	const activated = new Set<string>();
	let warnedFormat = false;

	// Make strudel the default discovery path: each turn, lock the tool surface to
	// baseline + what's been surfaced, and prune Pi's dump-everything prompt
	// sections (skills + tools) down to that surface.
	pi.on("before_agent_start", async (event) => {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		const active = computeActiveSurface(baseline, [...activated], available);
		pi.setActiveTools(active);

		// Suppression relies on Pi's prompt markers; warn once if they're gone
		// (a Pi format change), rather than silently leaking. See ROADMAP — the
		// clean fix is an upstream prompt-control hook.
		if (
			!warnedFormat &&
			!event.systemPrompt.includes("Available tools:") &&
			!event.systemPrompt.includes("<available_skills>")
		) {
			warnedFormat = true;
			console.error(
				"[strudel] warning: Pi prompt markers not found — format may have changed; surface suppression may be ineffective.",
			);
		}

		const systemPrompt = pruneToolsSection(
			stripSkillsBlock(event.systemPrompt),
			new Set(active),
		);
		return { systemPrompt };
	});

	pi.registerTool({
		name: "strudel_search",
		label: "Search the Pantry",
		description:
			"Search agent primitives (skills, tools, MCP tools, commands, rules, ...) by intent " +
			"across the Pantry. Returns the most relevant few rather than the whole catalog.",
		promptSnippet:
			"strudel_search: find primitives by intent across the Pantry.",
		parameters: Type.Object({
			query: Type.String({
				description: "What you're trying to do, in plain language.",
			}),
		}),
		async execute(_toolCallId, params) {
			const all = [...fileIndex, ...runtimePrimitives(pi)];
			const { hits, mode } = await search(all, params.query, {
				embeddings: config.embeddings,
				cachePath: CACHE_PATH,
			});

			// Curate-and-run: make surfaced code primitives callable next turn, bounded.
			for (const h of hits) {
				if (h.source === "runtime:tool") activated.add(h.name);
			}
			while (activated.size > MAX_ACTIVATED) {
				const oldest = activated.values().next().value;
				if (oldest === undefined) break;
				activated.delete(oldest);
			}

			const fmtScore = (s: number): string =>
				mode === "semantic" ? s.toFixed(3) : String(s);
			const lines = hits
				.map(
					(h) =>
						`  [${h.kind}] ${h.name}  (${fmtScore(h.score)})\n      ${h.description.slice(0, 90)}\n      ${h.source}`,
				)
				.join("\n");
			const text =
				hits.length === 0
					? `No primitives matched "${params.query}" across ${all.length} indexed.`
					: `Top ${hits.length} of ${all.length} primitives for "${params.query}" (${mode}):\n${lines}`;

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					total: all.length,
					hits: hits.length,
					mode,
				},
			};
		},
	});
}
