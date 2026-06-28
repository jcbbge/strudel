/**
 * Strudel — a Pi extension that fixes primitive overload.
 *
 * Search agent primitives (skills, tools, MCP tools, commands) by intent
 * instead of registering all of them into the context window.
 *
 * Milestone 1 (scaffold): prove Pi loads the extension and the gateway tool
 * registers. The Pantry index + real search land next.
 *
 * Run locally:  pi -e src/index.ts -p "..."
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STRUDEL_VERSION = "0.0.0";

export default async function strudel(pi: ExtensionAPI): Promise<void> {
	// Load signal — proves the extension was discovered, loaded, and run.
	console.error(`[strudel ${STRUDEL_VERSION}] extension loaded`);

	pi.registerTool({
		name: "strudel_search",
		label: "Search the Pantry",
		description:
			"Search agent primitives (skills, tools, MCP tools, commands) by intent. " +
			"Returns the most relevant few rather than the whole catalog.",
		promptSnippet:
			"strudel_search: find primitives by intent across the Pantry.",
		parameters: Type.Object({
			query: Type.String({
				description: "What you're trying to do, in plain language.",
			}),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [
					{
						type: "text",
						text: `[strudel] pantry search for "${params.query}" — gateway online; indexing not yet implemented (milestone 1).`,
					},
				],
				details: { query: params.query },
			};
		},
	});
}
