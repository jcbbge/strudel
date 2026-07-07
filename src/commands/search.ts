/**
 * /strudel-search <query> — run search directly without LLM
 *
 * Executes a search and shows raw scores for debugging/verification.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runtimePrimitives } from "../index.js";
import { isOnDemand } from "../pantry.js";
import { search } from "../search.js";
import { getState } from "../state.js";

const CACHE_PATH = join(homedir(), ".strudel", "cache", "embeddings.json");

export function registerSearchCommand(pi: ExtensionAPI): void {
	pi.registerCommand("strudel-search", {
		description: "Run a search directly. Usage: /strudel-search <query>",
		async handler(args, ctx) {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify("Usage: /strudel-search <query>", "error");
				return;
			}

			const state = getState();
			const { config, fileIndex } = state;

			// Combine file index with runtime primitives
			const all = [...fileIndex, ...runtimePrimitives(pi)];
			const searchable = all.filter(isOnDemand);

			// Run search
			const startTime = Date.now();
			const { hits, mode } = await search(searchable, query, {
				embeddings: config.embeddings,
				cachePath: CACHE_PATH,
			});
			const elapsed = Date.now() - startTime;

			// Format results
			const fmtScore = (s: number): string =>
				mode === "semantic" ? s.toFixed(3) : String(s);

			const header = " #  Score   Kind        Name                    Source";
			const divider = "─".repeat(70);

			const rows = hits.map((h, i) => {
				const num = String(i + 1).padStart(2);
				const score = fmtScore(h.score).padStart(6);
				const kind = h.kind.padEnd(10);
				const name = h.name.slice(0, 22).padEnd(22);
				const source =
					h.source.length > 30 ? `...${h.source.slice(-27)}` : h.source;
				return `${num}  ${score}   ${kind}  ${name}  ${source}`;
			});

			const output = `Search: "${query}" (${mode})
══════════════════════════════════════════════════════

${header}
${divider}
${rows.length > 0 ? rows.join("\n") : "(no results)"}

Search time: ${elapsed}ms (${searchable.length} searchable, ${all.length} indexed)
Mode: ${mode}${mode === "lexical" ? " (embeddings not configured or unreachable)" : ""}`;

			if (ctx.mode === "tui") {
				pi.sendMessage(
					{
						customType: "strudel-search-result",
						content: output,
						display: true,
					},
					{ triggerTurn: false },
				);
			} else {
				console.log(output);
			}
		},
	});
}
