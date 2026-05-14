/**
 * Claude-skill forager.
 *
 * Claude Code (and Anthropic's Skills format) represents a skill as a
 * directory containing a `SKILL.md` file. The file usually starts with a
 * YAML frontmatter block carrying `name` and `description`. The forager
 * matches on filename only and stashes the SKILL.md verbatim — the
 * cupboard-curator does the parsing.
 *
 * Detection is case-insensitive (`SKILL.md`, `skill.md`, `Skill.MD`).
 */

import path from "node:path";
import type { Forager, ForagerContext, RawCandidate } from "../forager.js";
import { fileToCandidate, walkFiles } from "./walk.js";

export class ClaudeSkillForager implements Forager {
	readonly paradigm = "claude-skill";
	readonly description = "Walks for Claude Code / Anthropic Skills (directories containing a SKILL.md file).";

	async *forage(ctx: ForagerContext): AsyncIterable<RawCandidate> {
		const log = ctx.log ?? (() => {});
		for await (const file of walkFiles(ctx.root, { accept: (_full, name) => name.toLowerCase() === "skill.md" })) {
			const skillDir = path.dirname(file);
			const candidate = await fileToCandidate(file, {
				paradigm: this.paradigm,
				hashPrefix: `claude-skill:${skillDir}`,
				adapterMeta: { skill_dir: skillDir, manifest_filename: path.basename(file) },
			});
			if (candidate) {
				const frontmatter = parseFrontmatter(candidate.raw_content);
				if (frontmatter.name || frontmatter.description) {
					candidate.adapter_meta = {
						...candidate.adapter_meta,
						frontmatter_name: frontmatter.name,
						frontmatter_description: frontmatter.description,
					};
				}
				log(`claude-skill: candidate ${file}`);
				yield candidate;
			}
		}
	}
}

/**
 * Minimal YAML frontmatter parser: pulls top-level `name:` and `description:`
 * scalars from the leading `---`-delimited block. Quoted, unquoted, and
 * single-line folded-to-single values all work; nested keys and multi-line
 * values are intentionally ignored — the curator gets the body too.
 */
function parseFrontmatter(content: string | undefined): { name?: string; description?: string } {
	if (!content) return {};
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const block = match[1];
	const out: { name?: string; description?: string } = {};
	for (const line of block.split("\n")) {
		const m = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
		if (!m) continue;
		const key = m[1].toLowerCase();
		if (key !== "name" && key !== "description") continue;
		let value = m[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (value.length > 0) out[key as "name" | "description"] = value;
	}
	return out;
}
