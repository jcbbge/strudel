import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRoots } from "../src/pantry.js";

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "strudel-metadata-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});
function write(file: string, content: string) {
	const target = join(root, file);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content);
}

describe("pantry metadata", () => {
	it("folds actual build-skill frontmatter instead of indexing its marker", async () => {
		// Source: ~/.pi/agent/skills/build-skill/SKILL.md, acquired 2026-09-18.
		write(
			"skills/build-skill/SKILL.md",
			`---
name: build-skill
description: >
  Compile a skill/prompt/artifact into a more activating version of itself, measured
  not by a judge's taste but by a held-out activation suite. Use when you want to
  make a skill 10x better at firing a model into high-quality operation — "break
  this down with the perspicuity of Karpathy," not "rephrase this." Scaffolds a
  multi-agent matrix (diverse free OpenRouter families) + a neutral-task
  attractor suite + an optional grounding hook. NOT a prose-polishing service.
metadata:
  author: jrg
---
# Build-Skill`,
		);
		const [item] = await indexRoots([root]);
		expect(item.description).toContain("measured not by a judge's taste");
		expect(item.description).toContain("NOT a prose-polishing service.");
		expect(item.description).not.toContain("author:");
	});

	it("joins actual Galley plain-scalar continuation lines", async () => {
		// Source: ~/agent-core/primitives/skills/galley-api.md, acquired 2026-09-18.
		write(
			"skills/galley-api.md",
			`---
name: galley-api
description: Galley GraphQL API reference — authentication, pagination, common queries
  (recipeConnection, menuConnection) and mutations (upsertRecipe, bulkAddCategoryValueItems).
  Use when building or debugging the Arc Galley integration client.
---
# Galley`,
		);
		const [item] = await indexRoots([root]);
		expect(item.description).toContain(
			"mutations (upsertRecipe, bulkAddCategoryValueItems).",
		);
		expect(item.description).toContain("Use when building or debugging");
	});

	it.each([">", ">-", ">+", "|", "|-", "|+"])(
		"supports block style %s and CRLF",
		async (style) => {
			write(
				"skills/block.md",
				`---\nname: block\ndescription: ${style}\n  First line.\n  Second line.\n---\nBody`.replaceAll(
					"\n",
					"\r\n",
				),
			);
			const [item] = await indexRoots([root]);
			expect(item.description).toBe(
				style.startsWith("|")
					? "First line.\nSecond line."
					: "First line. Second line.",
			);
		},
	);

	it("accepts quoted punctuation and both intent list forms", async () => {
		write(
			"skills/list.md",
			`---\nname: list\ndescription: "Match: a # literal"\nintents: ["one, with comma", two]\n---\nBody`,
		);
		write("skills/legacy.md", "---\nintents: one, two\n---\nBody");
		const items = await indexRoots([root]);
		expect(items.find((p) => p.name === "list")?.intents).toEqual([
			"one, with comma",
			"two",
		]);
		expect(items.find((p) => p.name === "list")?.description).toBe(
			"Match: a # literal",
		);
		expect(items.find((p) => p.name === "legacy")?.intents).toEqual([
			"one",
			"two",
		]);
	});

	it.each([
		"name: [oops",
		"name: 42\ndescription: [not, text]\nintents: [42, valid]",
		"- sequence",
	])("tolerates invalid or non-string metadata: %s", async (metadata) => {
		write(
			"skills/fallback.md",
			`---\n${metadata}\n---\n# Heading\nActual body.`,
		);
		const [item] = await indexRoots([root]);
		expect(item.name).toBe("fallback");
		expect(item.description).toBe("Actual body.");
	});

	it("excludes collection READMEs but preserves README-backed bundles", async () => {
		for (const kind of ["skills", "tools", "plugins"]) {
			write(`${kind}/README.md`, "Collection documentation");
			write(`${kind}/readme.MD`, "Other casing");
			write(`${kind}/real/README.md`, "A real selectable bundle");
		}
		const items = await indexRoots([root]);
		expect(items).toHaveLength(3);
		expect(
			items.every(
				(item) =>
					item.name === "real" &&
					item.description === "A real selectable bundle",
			),
		).toBe(true);
	});
});
