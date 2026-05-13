/**
 * Raw-markdown forager.
 *
 * Catch-all for markdown files that aren't already claimed by a more
 * specific paradigm. The cupboard-curator decides whether each candidate
 * deserves to be promoted to a `directive` / `command` / `skill` / etc.,
 * or stays parked as raw notes.
 *
 * Skipped filenames (claimed by sibling foragers or treated as docs):
 *   SKILL.md                 — claude-skill
 *   AGENTS.md / CLAUDE.md / GEMINI.md / copilot-instructions.md  — agent-md
 *   README.md / LICENSE.md / CHANGELOG.md / CONTRIBUTING.md     — project docs
 */

import path from "node:path";
import type { Forager, ForagerContext, RawCandidate } from "../forager.js";
import { fileToCandidate, walkFiles } from "./walk.js";

const CLAIMED_BY_OTHERS = new Set(["skill.md", "agents.md", "claude.md", "gemini.md", "copilot-instructions.md"]);

const PROJECT_DOC_NAMES = new Set([
	"readme.md",
	"license.md",
	"changelog.md",
	"contributing.md",
	"code_of_conduct.md",
	"security.md",
]);

const MARKDOWN_EXTS = new Set([".md", ".mdx", ".markdown"]);

export class RawMarkdownForager implements Forager {
	readonly paradigm = "raw-markdown";
	readonly description =
		"Walks for free-form markdown files not claimed by a more specific paradigm (skill/agent-md/project-docs).";

	async *forage(ctx: ForagerContext): AsyncIterable<RawCandidate> {
		const log = ctx.log ?? (() => {});
		for await (const file of walkFiles(ctx.root, {
			accept: (_full, name) => {
				const lower = name.toLowerCase();
				const ext = path.extname(lower);
				if (!MARKDOWN_EXTS.has(ext)) return false;
				if (CLAIMED_BY_OTHERS.has(lower)) return false;
				if (PROJECT_DOC_NAMES.has(lower)) return false;
				return true;
			},
		})) {
			const candidate = await fileToCandidate(file, {
				paradigm: this.paradigm,
				hashPrefix: `raw-markdown:${file}`,
				adapterMeta: { filename: path.basename(file) },
			});
			if (candidate) {
				log(`raw-markdown: candidate ${file}`);
				yield candidate;
			}
		}
	}
}
