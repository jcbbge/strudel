/**
 * @strudel/bakery
 *
 * The Strudel bakery extension. Adds the two Oven primitives — `strudel_search`
 * and `strudel_bake` — that the Master Baker uses to discover and execute
 * ingredients (skills, tools, MCPs, sub-agents, hooks, …).
 *
 * The Pantry is backed by SurrealDB (default: http://127.0.0.1:6000, ns=strudel,
 * db=bakery) and optionally enriched by a local OpenAI-compatible LLM
 * (default: MLX server at http://127.0.0.1:8080/v1) for auto-tagging and
 * embedding-driven search.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { LocalLlm } from "./llm.js";
import { Pantry } from "./pantry.js";
import { registerFromDirectory } from "./registry.js";
import { SurrealClient } from "./surreal.js";
import type { IngredientKind, PantrySearchHit } from "./types.js";

interface PantrySearchToolDetails {
	hits: PantrySearchHit[];
	query: string;
	error?: string;
}

export { LocalLlm } from "./llm.js";
export type { PantryOptions, RegisterInput, SearchOptions } from "./pantry.js";
export { Pantry } from "./pantry.js";
export type { RegisterFromDirOptions, RegisterFromDirResult } from "./registry.js";
export { registerFromDirectory } from "./registry.js";
export type { SurrealClientOptions } from "./surreal.js";
export { SurrealClient } from "./surreal.js";
export type {
	BakeHistoryEntry,
	IngredientKind,
	IngredientManifest,
	IngredientStage,
	PantrySearchHit,
	ShelfLocation,
	UsageStats,
} from "./types.js";

const SEARCH_PARAMS = Type.Object({
	query: Type.String({
		description:
			"Free-text query against the Pantry. Returns a ranked slice of ingredients (skills, tools, MCPs, sub-agents, hooks, …) that match the desired flavor.",
	}),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 50,
			description: "Maximum ingredients to return. Default 10.",
		}),
	),
	kind: Type.Optional(
		Type.Union(
			[
				Type.Literal("directive"),
				Type.Literal("command"),
				Type.Literal("skill"),
				Type.Literal("hook"),
				Type.Literal("tool"),
				Type.Literal("mcp"),
				Type.Literal("plugin"),
				Type.Literal("agent"),
				Type.Literal("subagent"),
			],
			{ description: "Restrict results to one of the nine ingredient kinds." },
		),
	),
});

const BAKE_PARAMS = Type.Object({
	payload: Type.String({
		description:
			"The baking payload. Either a code-mode TypeScript snippet or a structured ingredient invocation. The Oven mixes, layers, and executes it in a sandboxed environment.",
	}),
});

const MASTER_BAKER_IDENTITY = `# Identity: Master Baker, Test Kitchen

You are the Master Baker working in your own test kitchen. This is not a generic
agent harness — it is your personal workshop. You have agency here, and the
kitchen becomes uniquely yours one bake at a time.

## The Pantry
Your Pantry holds every primitive you have access to: directives, commands,
skills, hooks, tools, MCP servers, plugins, agents, and sub-agents. Nothing is
built in; everything you can do lives in the Pantry as a named, versioned,
reviewable ingredient. If something is not in the Pantry, you cannot do it
(yet) — you can search for it, register a new one, or ask the user to stock it.

## The Loop
1. **Search the Pantry first** with \`strudel_search\` whenever you do not
   already know which ingredients to use. Treat the Pantry as your first
   reference, not your last.
2. **Plan a recipe** before reaching for the oven on non-trivial tasks.
   Summarize the goal, name the ingredients, sketch the layers.
3. **Bake** with \`strudel_bake\`. Prefer composing a few small ingredients over
   one giant one.
4. **Annotate the margins.** Every bake is recorded — successes, failures,
   tasting notes. Future you will thank present you for the notes.
5. **Refine.** When a recipe fails, do not retry blindly — diagnose, refine,
   and consider registering a better version of the ingredient.

## The Posture
Treat this kitchen as yours. Annotate the recipe cards. Mark the books. Write
in the margins. Customize this in such a way that it is uniquely your own. The
Pantry, the Oven, and the bake history are extensions of your own capability —
use them like a craftsman uses a familiar set of tools.
`;

export default function bakeryExtension(pi: ExtensionAPI): void {
	const surreal = new SurrealClient();
	const llm = new LocalLlm();
	const pantry = new Pantry({ surreal, llm });

	pi.on("before_agent_start", (event) => {
		return { systemPrompt: `${MASTER_BAKER_IDENTITY}\n\n${event.systemPrompt}` };
	});

	pi.registerTool({
		name: "strudel_search",
		label: "Search the Pantry",
		description:
			"Browse the Pantry for ingredients (skills, tools, MCP suppliers, sub-agents, hooks, plugins, commands, directives) whose flavor matches the query. Use this before reaching for strudel_bake to discover what is on the shelves.",
		promptSnippet: "strudel_search: hybrid search over the Pantry to find the right ingredients before baking.",
		promptGuidelines: [
			"Always search the Pantry first when you do not already know which ingredients to use.",
			"Prefer narrow, specific queries; the Pantry is hybrid (semantic + lexical).",
		],
		parameters: SEARCH_PARAMS,
		async execute(_toolCallId, params) {
			try {
				const hits = await pantry.search(params.query, { limit: params.limit ?? 10, kind: params.kind });
				if (hits.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No ingredients found in the Pantry for "${params.query}". The shelves may be empty — try /strudel pantry list to see what is on hand.`,
							},
						],
						details: { hits: [], query: params.query, error: undefined } as PantrySearchToolDetails,
					};
				}
				const lines = hits.map((hit, i) => {
					const tags = hit.manifest.tags?.length ? ` [${hit.manifest.tags.join(", ")}]` : "";
					return `${i + 1}. ${hit.manifest.name} (${hit.manifest.kind}, score ${hit.score.toFixed(2)} via ${hit.via})${tags}\n   ${hit.manifest.flavor}`;
				});
				return {
					content: [{ type: "text", text: lines.join("\n\n") }],
					details: { hits, query: params.query, error: undefined } as PantrySearchToolDetails,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `[bakery] Pantry search failed: ${message}` }],
					details: { hits: [], query: params.query, error: message } as PantrySearchToolDetails,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "strudel_bake",
		label: "Bake in the Oven",
		description:
			"Execute a baking payload in the Oven. The payload may be a code-mode TypeScript snippet or a structured ingredient invocation. The Oven mixes, layers, and runs it in a sandboxed environment with full Code Mode support.",
		promptSnippet: "strudel_bake: the unified execution oven; runs code or layered ingredient calls.",
		promptGuidelines: [
			"Plan the recipe before baking; favor compact code-mode payloads that compose multiple ingredients.",
			"Bake in small layers when the recipe is uncertain; observe the result before adding the next layer.",
		],
		parameters: BAKE_PARAMS,
		async execute(_toolCallId, params) {
			return {
				content: [
					{
						type: "text",
						text: `[bakery v0] Oven received payload (${params.payload.length} chars) — the sandboxed Oven arrives in a later step. No baking performed.`,
					},
				],
				details: { stub: true, payloadLength: params.payload.length },
			};
		},
	});

	pi.registerCommand("strudel", {
		description:
			"Strudel bakery introspection: /strudel status | /strudel pantry list [kind] | /strudel pantry reset | /strudel pantry sync [path]",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const sub = tokens[0] ?? "status";
			try {
				if (sub === "status") {
					const llmAvailable = await llm.isAvailable();
					const surrealMs = await surreal.ping().catch((e) => `unreachable (${(e as Error).message})`);
					const info = pantry.info;
					const lines = [
						`Surreal: ${info.surreal.url} ns=${info.surreal.namespace} db=${info.surreal.database} — ${typeof surrealMs === "number" ? `${surrealMs}ms` : surrealMs}`,
						`LLM:     ${info.llm?.baseUrl ?? "(disabled)"} chat=${info.llm?.chatModel ?? "-"} embed=${info.llm?.embeddingModel ?? "-"} — ${llmAvailable ? "available" : "unreachable"}`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				if (sub === "pantry") {
					const action = tokens[1] ?? "list";
					if (action === "list") {
						const kind = tokens[2] as IngredientKind | undefined;
						const items = await pantry.list({ kind, limit: 100 });
						if (items.length === 0) {
							ctx.ui.notify("Pantry is empty.", "info");
							return;
						}
						const lines = items.map(
							(m) => `- ${m.name} (${m.kind}, shelf=${m.shelf}, bakes=${m.usage_stats.bakes})\n    ${m.flavor}`,
						);
						ctx.ui.notify(
							`Pantry (${items.length} ingredient${items.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
							"info",
						);
						return;
					}
					if (action === "reset") {
						await pantry.reset();
						ctx.ui.notify("Pantry wiped clean.", "info");
						return;
					}
					if (action === "sync") {
						const root = tokens[2];
						const summary = await registerFromDirectory(pantry, root ? { root } : {});
						const breakdown = Object.entries(summary.byKind)
							.map(([k, n]) => `${k}=${n}`)
							.join(", ");
						const lines = [
							`Synced ${summary.registered.length} ingredient${summary.registered.length === 1 ? "" : "s"} from ${summary.root}`,
							breakdown ? `  by kind: ${breakdown}` : "",
							summary.skipped.length
								? `  skipped: ${summary.skipped.length} (first: ${summary.skipped[0].path} — ${summary.skipped[0].reason})`
								: "",
						].filter(Boolean);
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					ctx.ui.notify(`Unknown pantry action: ${action}. Try: list, reset, sync.`, "warning");
					return;
				}
				ctx.ui.notify(`Unknown /strudel subcommand: ${sub}. Try: status, pantry.`, "warning");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`/strudel ${sub} failed: ${message}`, "error");
			}
		},
	});
}
