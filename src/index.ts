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
import { type Primitive, indexRoots, isOnDemand } from "./pantry.js";
import { search } from "./search.js";
import {
	type SurfaceMode,
	baselineTools,
	computeActiveSurface,
	pruneToolsSection,
	stripSkillsBlock,
} from "./surface.js";
import {
	type StrudelConfig,
	STRUDEL_VERSION,
	initState,
} from "./state.js";
import { bake, prep, listTools, type Recipe, type RecipeLayer } from "./oven.js";

// Commands — each registers itself when imported
import { registerStatusCommand } from "./commands/status.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerPantryCommand } from "./commands/pantry.js";
import { registerSurfaceCommand } from "./commands/surface.js";
import { registerSearchCommand } from "./commands/search.js";

const DEFAULT_ROOTS = ["~/.pi/agent"];
const CACHE_PATH = join(homedir(), ".strudel", "cache", "embeddings.json");
const MAX_ACTIVATED = 24; // bound the session surface so it can't slowly re-bloat

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
export function runtimePrimitives(pi: ExtensionAPI): Primitive[] {
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
	const baseline = baselineTools(config.surface, config.baseline);
	const activated = new Set<string>();

	// Initialize shared state for commands
	initState({ config, fileIndex, activated, baseline, pi });

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

	// Register the strudel_search tool
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
			// Ambient kinds (rules/hooks/directives) live in the inventory but are
			// auto-invoked, not selectable — exclude them from search ranking.
			const searchable = all.filter(isOnDemand);
			const { hits, mode } = await search(searchable, params.query, {
				embeddings: config.embeddings,
				cachePath: CACHE_PATH,
			});

			// Curate-and-run: make surfaced code primitives callable THIS turn, bounded.
			let surfaceChanged = false;
			for (const h of hits) {
				if (h.source === "runtime:tool" && !activated.has(h.name)) {
					activated.add(h.name);
					surfaceChanged = true;
				}
				// Agent definitions (both kinds) require the subagent tool to invoke
				if ((h.kind === "agent" || h.kind === "subagent") && !activated.has("subagent")) {
					activated.add("subagent");
					surfaceChanged = true;
				}
			}
			while (activated.size > MAX_ACTIVATED) {
				const oldest = activated.values().next().value;
				if (oldest === undefined) break;
				activated.delete(oldest);
			}

			// Immediately update the active surface so tools are callable THIS turn
			if (surfaceChanged) {
				const available = new Set(pi.getAllTools().map((t) => t.name));
				const active = computeActiveSurface(baseline, [...activated], available);
				pi.setActiveTools(active);
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
					? `No primitives matched "${params.query}" across ${searchable.length} searchable (${all.length} indexed).`
					: `Top ${hits.length} of ${searchable.length} searchable primitives for "${params.query}" (${mode}):\n${lines}`;

			return {
				content: [{ type: "text", text }],
				details: {
					query: params.query,
					searchable: searchable.length,
					indexed: all.length,
					hits: hits.length,
					mode,
				},
			};
		},
	});

	// Register the strudel_prep tool
	pi.registerTool({
		name: "strudel_prep",
		label: "Prep a Recipe",
		description:
			"Validate a recipe before baking. Checks that all tools exist and bindings are valid. " +
			"Use this to verify a recipe will work before executing it.",
		promptSnippet:
			"strudel_prep: validate a recipe (tools exist, bindings valid) before baking.",
		parameters: Type.Object({
			goal: Type.String({ description: "What the recipe accomplishes" }),
			layers: Type.Array(
				Type.Object({
					step: Type.Number({ description: "Step number (1-indexed, execution order)" }),
					ingredient: Type.String({ description: "Tool name, e.g. 'tool.read' or 'read'" }),
					inputs: Type.Record(Type.String(), Type.Unknown(), {
						description: "Tool inputs. Use $N.field to reference output from step N.",
					}),
				}),
				{ description: "Recipe steps" }
			),
		}),
		async execute(_toolCallId, params) {
			const recipe: Recipe = {
				goal: params.goal,
				layers: params.layers as RecipeLayer[],
			};

			const result = await prep(recipe);
			const available = listTools();

			let text = `Recipe: ${params.goal}\n`;
			text += `Valid: ${result.valid ? "✓" : "✗"}\n\n`;

			text += `Tools (${result.tools.length}):\n`;
			for (const t of result.tools) {
				text += `  ${t.found ? "✓" : "✗"} ${t.name}\n`;
			}

			if (result.bindings.length > 0) {
				text += `\nBindings:\n`;
				for (const b of result.bindings) {
					text += `  ${b.valid ? "✓" : "✗"} Step ${b.step}: ${b.binding}`;
					if (b.reason) text += ` — ${b.reason}`;
					text += "\n";
				}
			}

			if (result.errors.length > 0) {
				text += `\nErrors:\n`;
				for (const e of result.errors) {
					text += `  • ${e}\n`;
				}
			}

			text += `\nAvailable tools: ${available.join(", ")}`;

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});

	// Register the strudel_bake tool
	pi.registerTool({
		name: "strudel_bake",
		label: "Bake a Recipe",
		description:
			"Execute a recipe — a sequence of tool calls with bindings. Each layer specifies a tool " +
			"and its inputs. Use $N.field syntax to pass output from step N to later steps. " +
			"Tools are loaded from ~/.strudel/tools/.",
		promptSnippet:
			"strudel_bake: execute a recipe (tool sequence with $N.field bindings).",
		parameters: Type.Object({
			goal: Type.String({ description: "What the recipe accomplishes" }),
			layers: Type.Array(
				Type.Object({
					step: Type.Number({ description: "Step number (1-indexed, execution order)" }),
					ingredient: Type.String({ description: "Tool name, e.g. 'tool.read' or 'read'" }),
					inputs: Type.Record(Type.String(), Type.Unknown(), {
						description: "Tool inputs. Use $N.field to reference output from step N.",
					}),
				}),
				{ description: "Recipe steps" }
			),
		}),
		async execute(_toolCallId, params) {
			const recipe: Recipe = {
				goal: params.goal,
				layers: params.layers as RecipeLayer[],
			};

			const result = await bake(recipe);

			let text = `Recipe: ${params.goal}\n`;
			text += `Status: ${result.success ? "✓ Success" : "✗ Failed"}\n`;
			text += `Duration: ${result.totalDurationMs}ms\n\n`;

			text += `Steps:\n`;
			for (const step of result.steps) {
				const status = step.error ? "✗" : "✓";
				text += `  ${status} Step ${step.step}: ${step.ingredient} (${step.durationMs}ms)\n`;
				if (step.error) {
					text += `      Error: ${step.error}\n`;
				}
			}

			if (result.error) {
				text += `\nError: ${result.error}\n`;
			}

			// Format final output
			if (result.finalOutput !== null && result.finalOutput !== undefined) {
				text += `\n--- Final Output ---\n`;
				if (typeof result.finalOutput === "object") {
					// For objects, show a summary or the content field if present
					const out = result.finalOutput as Record<string, unknown>;
					if ("content" in out && typeof out.content === "string") {
						text += out.content;
					} else {
						text += JSON.stringify(result.finalOutput, null, 2);
					}
				} else {
					text += String(result.finalOutput);
				}
			}

			return {
				content: [{ type: "text", text }],
				details: {
					success: result.success,
					steps: result.steps.map(s => ({
						step: s.step,
						ingredient: s.ingredient,
						durationMs: s.durationMs,
						error: s.error,
					})),
					totalDurationMs: result.totalDurationMs,
				},
			};
		},
	});

	// Register introspection commands
	registerStatusCommand(pi);
	registerHealthCommand(pi);
	registerPantryCommand(pi);
	registerSurfaceCommand(pi);
	registerSearchCommand(pi);
}
