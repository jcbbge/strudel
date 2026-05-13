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
				log(`claude-skill: candidate ${file}`);
				yield candidate;
			}
		}
	}
}
