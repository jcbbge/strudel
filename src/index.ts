/**
 * Strudel — a Pi extension that fixes primitive overload.
 *
 * Search agent primitives (skills, tools, MCP tools, commands, rules, ...) by
 * intent instead of registering all of them into the context window.
 *
 * The Pantry indexes configured roots (kind inferred from the subdirectory
 * name) + the live runtime registry. strudel_search ranks across all kinds:
 * L1 semantic when an embeddings endpoint is configured, else L0 lexical.
 * Kind-agnostic; not skills-specific.
 *
 * Run locally:  pi -e src/index.ts -p "..."
 * Config:       ~/.strudel/config.json
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	type EmbeddingConfig,
	httpEmbedder,
	semanticSearch,
} from "./embeddings.js";
import {
	type Primitive,
	type Ranked,
	indexRoots,
	lexicalSearch,
} from "./pantry.js";
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
	// Code primitives strudel has surfaced this session — kept active so the
	// agent can call them after discovering them (curate-and-run).
	const activated = new Set<string>();

	// Make strudel the default discovery path: each turn, lock the tool surface
	// to baseline + what's been surfaced, and strip Pi's dump-everything skills
	// block in favor of a pointer to strudel_search.
	pi.on("before_agent_start", async (event) => {
		const available = new Set(pi.getAllTools().map((t) => t.name));
		const active = computeActiveSurface(baseline, [...activated], available);
		pi.setActiveTools(active);
		// Lock execution (setActiveTools) AND the prompt the agent reads: strip the
		// skills dump and prune the "Available tools" list to the active set.
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
			// File-indexed kinds + live runtime kinds (tools, MCP tools, commands).
			const runtime: Primitive[] = [
				...pi.getAllTools().map((t) => ({
					name: t.name,
					kind: "tool",
					description: (t as { description?: string }).description ?? "",
					source: "runtime:tool",
				})),
				...pi.getCommands().map((c) => ({
					name: c.name,
					kind: "command",
					description: c.description ?? "",
					source: "runtime:command",
				})),
			];
			const all = [...fileIndex, ...runtime];

			let hits: Ranked[];
			let mode = "lexical";
			if (config.embeddings) {
				try {
					hits = await semanticSearch(
						all,
						params.query,
						httpEmbedder(config.embeddings),
						CACHE_PATH,
						8,
					);
					mode = "semantic";
				} catch (err) {
					// Endpoint down / error — degrade gracefully, never break search.
					console.error(
						`[strudel] embeddings failed, falling back to lexical: ${err instanceof Error ? err.message : String(err)}`,
					);
					hits = lexicalSearch(all, params.query, 8);
				}
			} else {
				hits = lexicalSearch(all, params.query, 8);
			}

			// Curate-and-run: make the code-primitive hits callable next turn.
			for (const h of hits) {
				if (h.source === "runtime:tool") activated.add(h.name);
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
