/**
 * Strudel — a Pi extension that fixes primitive overload.
 *
 * Search agent primitives (skills, tools, MCP tools, commands, rules, ...) by
 * intent instead of registering all of them into the context window.
 *
 * Milestone 2: the Pantry indexes configured roots (kind inferred from the
 * subdirectory name) + the live runtime registry, and strudel_search ranks
 * across all kinds. Kind-agnostic; not skills-specific.
 *
 * Run locally:  pi -e src/index.ts -p "..."
 * Config:       ~/.strudel/config.json  →  { "pantry": { "roots": [ ... ] } }
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type Primitive, indexRoots, lexicalSearch } from "./pantry.js";

const STRUDEL_VERSION = "0.0.0";
const DEFAULT_ROOTS = ["~/.pi/agent"];

async function loadRoots(): Promise<string[]> {
	const cfg = join(homedir(), ".strudel", "config.json");
	try {
		const parsed = JSON.parse(await readFile(cfg, "utf-8")) as {
			pantry?: { roots?: string[] };
		};
		const roots = parsed.pantry?.roots;
		if (Array.isArray(roots) && roots.length > 0) return roots;
	} catch {
		// no config — fall back to defaults
	}
	return DEFAULT_ROOTS;
}

export default async function strudel(pi: ExtensionAPI): Promise<void> {
	const roots = await loadRoots();
	const fileIndex = await indexRoots(roots);

	const byKind = new Map<string, number>();
	for (const p of fileIndex) byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
	const kindSummary = [...byKind.entries()]
		.map(([k, n]) => `${k}:${n}`)
		.join(" ");
	console.error(
		`[strudel ${STRUDEL_VERSION}] pantry: ${fileIndex.length} file-primitives from ${roots.length} roots (${kindSummary})`,
	);

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
			const hits = lexicalSearch(all, params.query, 8);

			const lines = hits
				.map(
					(h) =>
						`  [${h.kind}] ${h.name}  (score ${h.score})\n      ${h.description.slice(0, 90)}\n      ${h.source}`,
				)
				.join("\n");
			const text =
				hits.length === 0
					? `No primitives matched "${params.query}" across ${all.length} indexed (${fileIndex.length} file + ${runtime.length} runtime).`
					: `Top ${hits.length} of ${all.length} primitives for "${params.query}":\n${lines}`;

			return {
				content: [{ type: "text", text }],
				details: { query: params.query, total: all.length, hits: hits.length },
			};
		},
	});
}
