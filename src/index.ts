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

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadConfig } from "./config.js";
import {
	type Recipe,
	type RecipeLayer,
	bake,
	listTools,
	prep,
} from "./oven.js";
import { type Primitive, indexRoots, isOnDemand } from "./pantry.js";
import {
	defaultInventoryLine,
	presentTool,
	resolveInventoryLine,
} from "./presentation.js";
import { checkParams, expandParams, findRecipe, loadRecipe } from "./recipe.js";
import { search } from "./search.js";
import { STRUDEL_VERSION, initState } from "./state.js";
import {
	baselineTools,
	computeActiveSurface,
	evictOverCap,
	pruneToolsSection,
	stripSkillsBlock,
	touchActivated,
} from "./surface.js";
import { Telemetry, primitiveKey } from "./telemetry.js";

import { registerHealthCommand } from "./commands/health.js";
import { registerPantryCommand } from "./commands/pantry.js";
import { registerSearchCommand } from "./commands/search.js";
// Commands — each registers itself when imported
import { registerStatusCommand } from "./commands/status.js";
import { registerSurfaceCommand } from "./commands/surface.js";

const CACHE_PATH = join(homedir(), ".strudel", "cache", "embeddings.json");
const MAX_ACTIVATED = 24; // bound the session surface so it can't slowly re-bloat

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

	// Telemetry bandit — event log + usage prior (kill switch: config.telemetry
	// === false disables all writes and forces pure semantic ranking, λ=0).
	const telemetry = new Telemetry({
		logPath:
			process.env.STRUDEL_TELEMETRY_PATH ??
			join(homedir(), ".strudel", "telemetry.jsonl"),
		enabled: config.telemetry !== false,
	});
	const sessionId = `pi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	// First-surface timestamps this session — links the invoke funnel
	// (`surfaced` flag + latency_from_surface_ms).
	const surfacedAt = new Map<string, number>();

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

		let systemPrompt = pruneToolsSection(
			stripSkillsBlock(event.systemPrompt),
			new Set(active),
		);

		// Announce the pantry inventory right after the pruned tools section so
		// the model knows its visible tools are a cache, not the full catalog.
		const inventory = resolveInventoryLine(
			config.presentation,
			defaultInventoryLine(fileIndex.length, byKind),
		);
		if (inventory) {
			systemPrompt = `${systemPrompt.trimEnd()}\n\n${inventory}\n`;
		}
		return { systemPrompt };
	});

	// Register the strudel_search tool
	pi.registerTool({
		name: "strudel_search",
		label: "Search the Pantry",
		// Presentation genome: config.presentation.tools may override per-field.
		...presentTool(config.presentation, "strudel_search", {
			description:
				"Search agent primitives (skills, tools, MCP tools, commands, rules, ...) by intent " +
				"across the Pantry. Returns the most relevant few rather than the whole catalog.",
			promptSnippet:
				"strudel_search: find primitives by intent across the Pantry.",
		}),
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
				bandit: telemetry,
			});

			// Telemetry hook: log a surface event per returned hit (rank + score).
			hits.forEach((h, i) => {
				const key = primitiveKey(h);
				telemetry.recordSurface({
					session: sessionId,
					query: params.query,
					primitive: key,
					rank: i + 1,
					score: h.score,
					explore: h.explore,
				});
				if (!surfacedAt.has(key)) surfacedAt.set(key, telemetry.nowMs());
			});

			// Curate-and-run: make surfaced code primitives callable THIS turn, bounded.
			// The activated Set is an LRU: re-surfacing a tool refreshes its recency,
			// so eviction removes the least-recently-USED, not the first-inserted.
			let surfaceChanged = false;
			for (const h of hits) {
				if (h.source === "runtime:tool") {
					if (activated.has(h.name)) {
						touchActivated(activated, h.name);
					} else {
						activated.add(h.name);
						surfaceChanged = true;
					}
				}
				// Agent definitions (both kinds) require the subagent tool to invoke
				if (h.kind === "agent" || h.kind === "subagent") {
					if (activated.has("subagent")) {
						touchActivated(activated, "subagent");
					} else {
						activated.add("subagent");
						surfaceChanged = true;
					}
				}
			}
			evictOverCap(activated, MAX_ACTIVATED);

			// Immediately update the active surface so tools are callable THIS turn
			if (surfaceChanged) {
				const available = new Set(pi.getAllTools().map((t) => t.name));
				const active = computeActiveSurface(
					baseline,
					[...activated],
					available,
				);
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
		label: "Compose a Recipe",
		...presentTool(config.presentation, "strudel_prep", {
			description:
				"Compose a recipe. The middle verb of the triad: search → prep → bake. " +
				"Takes a goal + a sketch of layers (or a named recipe from the Pantry + params), " +
				"returns a validated recipe with all tools resolved and $N.field bindings checked. " +
				"Always call before bake on any multi-step work. On success the response includes " +
				"a copy-pasteable strudel_bake invocation.",
			promptSnippet:
				"strudel_prep: compose a recipe (search → prep → bake). Returns a validated recipe + ready-to-paste bake call.",
		}),
		parameters: Type.Object({
			goal: Type.String({ description: "What the recipe accomplishes" }),
			layers: Type.Optional(
				Type.Array(
					Type.Object({
						step: Type.Number({
							description: "Step number (1-indexed, execution order)",
						}),
						ingredient: Type.String({
							description: "Tool name, e.g. 'tool.read' or 'read'",
						}),
						inputs: Type.Record(Type.String(), Type.Unknown(), {
							description:
								"Tool inputs. Use $N.field to reference output from step N.",
						}),
					}),
					{
						description:
							"Recipe steps (ad-hoc composition). Omit if using `recipe` + `params`.",
					},
				),
			),
			recipe: Type.Optional(
				Type.String({
					description:
						"Named recipe from the Pantry (e.g. 'bench.load'). Omit if providing raw `layers`.",
				}),
			),
			params: Type.Optional(
				Type.Record(Type.String(), Type.Unknown(), {
					description:
						"Params to substitute into the recipe's {token} placeholders.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			let effectiveLayers: RecipeLayer[];
			let recipeExpansionNote = "";
			let recipePrimitiveKey: string | undefined;

			// Named-recipe path: look up in the Pantry, substitute params, expand.
			if (params.recipe) {
				if (params.layers && params.layers.length > 0) {
					return {
						content: [
							{
								type: "text",
								text: "Provide either `recipe` or `layers`, not both.",
							},
						],
						details: {
							valid: false,
							errors: ["both recipe and layers provided"],
							missing: [] as string[],
						},
					};
				}
				const primitive = findRecipe(fileIndex, params.recipe);
				if (!primitive) {
					return {
						content: [
							{
								type: "text",
								text: `Unknown recipe: "${params.recipe}". Run \`strudel_search\` to see what recipes are indexed.`,
							},
						],
						details: {
							valid: false,
							errors: [`unknown recipe: ${params.recipe}`],
							missing: [] as string[],
						},
					};
				}
				let loaded: Awaited<ReturnType<typeof loadRecipe>>;
				try {
					loaded = await loadRecipe(primitive.source);
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [
							{
								type: "text",
								text: `Failed to load recipe "${params.recipe}": ${msg}`,
							},
						],
						details: { valid: false, errors: [msg], missing: [] as string[] },
					};
				}
				const check = checkParams(loaded, params.params ?? {});
				if (!check.ok) {
					return {
						content: [
							{
								type: "text",
								text:
									`Recipe "${params.recipe}" is missing params: ${check.missing.join(", ")}\n` +
									`Declared params: ${loaded.params.join(", ") || "(none)"}`,
							},
						],
						details: {
							valid: false,
							missing: check.missing,
							errors: [`missing params: ${check.missing.join(", ")}`],
						},
					};
				}
				effectiveLayers = expandParams(loaded.layers, params.params ?? {});
				const extraNote =
					check.extra.length > 0
						? ` (unused params ignored: ${check.extra.join(", ")})`
						: "";
				recipeExpansionNote = `Expanded from recipe \`${params.recipe}\`${extraNote}.\n`;

				// Telemetry hook: the agent invoked this recipe via prep.
				recipePrimitiveKey = primitiveKey(primitive);
				const surfacedMs = surfacedAt.get(recipePrimitiveKey);
				telemetry.recordInvoke({
					session: sessionId,
					primitive: recipePrimitiveKey,
					via: "prep",
					surfaced: surfacedMs !== undefined,
					latencyFromSurfaceMs:
						surfacedMs !== undefined ? telemetry.nowMs() - surfacedMs : null,
				});
			} else if (params.layers && params.layers.length > 0) {
				effectiveLayers = params.layers as RecipeLayer[];
			} else {
				return {
					content: [
						{
							type: "text",
							text: "Provide either `recipe` (a Pantry recipe name) or `layers` (raw layer array).",
						},
					],
					details: {
						valid: false,
						errors: ["no recipe or layers provided"],
						missing: [] as string[],
					},
				};
			}

			const recipe: Recipe = {
				goal: params.goal,
				layers: effectiveLayers,
			};

			const result = await prep(recipe);
			const available = listTools();

			// Mark this recipe shape as prepped so a subsequent bake doesn't warn.
			if (result.valid) {
				const key = recipeKey(params.goal, effectiveLayers);
				preppedRecipes.add(key);
				// Remember which Pantry recipe produced these layers so bake can
				// attribute its outcome to the recipe primitive too.
				if (recipePrimitiveKey) preppedRecipeNames.set(key, recipePrimitiveKey);
			}

			let text = `Recipe: ${params.goal}\n`;
			text += `Valid: ${result.valid ? "✓" : "✗"}\n\n`;

			text += `Tools (${result.tools.length}):\n`;
			for (const t of result.tools) {
				text += `  ${t.found ? "✓" : "✗"} ${t.name}\n`;
			}

			if (result.bindings.length > 0) {
				text += "\nBindings:\n";
				for (const b of result.bindings) {
					text += `  ${b.valid ? "✓" : "✗"} Step ${b.step}: ${b.binding}`;
					if (b.reason) text += ` — ${b.reason}`;
					text += "\n";
				}
			}

			if (result.errors.length > 0) {
				text += "\nErrors:\n";
				for (const e of result.errors) {
					text += `  • ${e}\n`;
				}
			}

			text += `\nAvailable tools: ${available.join(", ")}`;

			// On success, emit a copy-pasteable bake call so the agent can advance
			// in one motion (prep → bake without retyping the recipe).
			if (result.valid) {
				const bakeCall = {
					goal: params.goal,
					layers: effectiveLayers,
				};
				text = `${
					recipeExpansionNote + text
				}\n\n--- Ready to bake ---\nRecipe validated. Next call:\n\nstrudel_bake(${JSON.stringify(bakeCall, null, 2)})\n`;
			}

			return {
				content: [{ type: "text", text }],
				details: { ...result, prepped: result.valid } as unknown as Record<
					string,
					unknown
				>,
			};
		},
	});

	// Track which recipes have been prepped to enable bake "unprepped" warnings.
	// Keyed by a stable hash of (goal + layer ingredients) so identical recipes
	// composed via prep are recognized by bake.
	const preppedRecipes = new Set<string>();
	const preppedRecipeNames = new Map<string, string>();
	const recipeKey = (
		goal: string,
		layers: Array<{ step: number; ingredient: string }>,
	): string =>
		`${goal}§${layers.map((l) => `${l.step}:${l.ingredient}`).join("|")}`;

	// Register the strudel_bake tool
	pi.registerTool({
		name: "strudel_bake",
		label: "Bake a Recipe",
		...presentTool(config.presentation, "strudel_bake", {
			description:
				"Execute a recipe — the final verb of the triad: search → prep → bake. " +
				"Runs the sequence of tool calls with $N.field bindings between steps. " +
				"Tools are loaded from ~/.strudel/tools/. For multi-step recipes, call " +
				"strudel_prep first to validate — bake will warn (not fail) when run unprepped.",
			promptSnippet:
				"strudel_bake: execute a recipe (final verb of search → prep → bake).",
		}),
		parameters: Type.Object({
			goal: Type.String({ description: "What the recipe accomplishes" }),
			layers: Type.Array(
				Type.Object({
					step: Type.Number({
						description: "Step number (1-indexed, execution order)",
					}),
					ingredient: Type.String({
						description: "Tool name, e.g. 'tool.read' or 'read'",
					}),
					inputs: Type.Record(Type.String(), Type.Unknown(), {
						description:
							"Tool inputs. Use $N.field to reference output from step N.",
					}),
				}),
				{ description: "Recipe steps" },
			),
		}),
		async execute(_toolCallId, params) {
			const recipe: Recipe = {
				goal: params.goal,
				layers: params.layers as RecipeLayer[],
			};

			// Soft-warn when a multi-step recipe is baked without a prior prep.
			// This teaches the search → prep → bake discipline without blocking work.
			const key = recipeKey(params.goal, params.layers);
			const wasPrepped = preppedRecipes.has(key);
			const isMultiStep = params.layers.length > 1;
			const showPrepWarning = isMultiStep && !wasPrepped;

			// Telemetry hook: invoke events for the baked primitives — each distinct
			// ingredient tool, plus the Pantry recipe these layers were prepped from.
			const bakedPrimitives = new Set<string>(
				params.layers.map((l) => `tool:${l.ingredient}`),
			);
			const preppedFrom = preppedRecipeNames.get(key);
			if (preppedFrom) bakedPrimitives.add(preppedFrom);
			for (const p of bakedPrimitives) {
				const surfacedMs = surfacedAt.get(p);
				telemetry.recordInvoke({
					session: sessionId,
					primitive: p,
					via: "bake",
					surfaced: surfacedMs !== undefined,
					latencyFromSurfaceMs:
						surfacedMs !== undefined ? telemetry.nowMs() - surfacedMs : null,
				});
			}

			const result = await bake(recipe);

			// Telemetry hook: terminal outcome of the bake.
			const failedStep = result.steps.find((s) => s.error)?.step;
			const outcomeError = result.success
				? null
				: failedStep !== undefined
					? `step_failed:${failedStep}`
					: "bake_failed";
			const stepsRun = result.steps.filter((s) => !s.error).length;
			for (const p of bakedPrimitives) {
				telemetry.recordOutcome({
					session: sessionId,
					primitive: p,
					ok: result.success,
					error: outcomeError,
					stepsRun,
					stepsTotal: params.layers.length,
				});
			}

			// After a successful bake we no longer need the prep flag for this recipe.
			preppedRecipes.delete(key);
			preppedRecipeNames.delete(key);

			let text = `Recipe: ${params.goal}\n`;
			text += `Status: ${result.success ? "✓ Success" : "✗ Failed"}\n`;
			text += `Duration: ${result.totalDurationMs}ms\n`;
			if (showPrepWarning) {
				text +=
					"⚠  Baked without prep. The triad is search → prep → bake — " +
					"run strudel_prep first on multi-step recipes to validate tools and bindings before execution.\n";
			}
			text += "\n";

			text += "Steps:\n";
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
				text += "\n--- Final Output ---\n";
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
					steps: result.steps.map((s) => ({
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
