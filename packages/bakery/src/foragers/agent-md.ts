/**
 * Agent-instructions forager.
 *
 * Matches the family of "instructions for the agent that lives in this
 * directory" markdown files used across tools:
 *
 *   - AGENTS.md           (Amp / Pi / general)
 *   - CLAUDE.md           (Claude Code)
 *   - GEMINI.md           (Gemini Code)
 *   - .cursorrules        (Cursor)
 *   - copilot-instructions.md  (GitHub Copilot, typically under .github/)
 *
 * One candidate per file. Adapter metadata records which flavor we matched
 * so the curator can choose the right ingredient kind (usually `directive`).
 */

import path from "node:path";
import type { Forager, ForagerContext, RawCandidate } from "../forager.js";
import { fileToCandidate, walkFiles } from "./walk.js";

const FLAVOR_BY_FILENAME: Record<string, string> = {
	"agents.md": "amp-or-pi",
	"claude.md": "claude-code",
	"gemini.md": "gemini-code",
	".cursorrules": "cursor",
	"copilot-instructions.md": "github-copilot",
};

export class AgentMdForager implements Forager {
	readonly paradigm = "agent-md";
	readonly description =
		"Walks for per-directory agent instructions: AGENTS.md / CLAUDE.md / GEMINI.md / .cursorrules.";

	async *forage(ctx: ForagerContext): AsyncIterable<RawCandidate> {
		const log = ctx.log ?? (() => {});
		// .cursorrules is hidden but should still be picked up; widen accept.
		for await (const file of walkFiles(ctx.root, {
			accept: (_full, name) => name.toLowerCase() in FLAVOR_BY_FILENAME,
		})) {
			const base = path.basename(file).toLowerCase();
			const flavor = FLAVOR_BY_FILENAME[base] ?? "unknown";
			const candidate = await fileToCandidate(file, {
				paradigm: this.paradigm,
				hashPrefix: `agent-md:${file}`,
				adapterMeta: { tool_flavor: flavor, filename: path.basename(file) },
			});
			if (candidate) {
				log(`agent-md: candidate ${file} (${flavor})`);
				yield candidate;
			}
		}
	}
}
