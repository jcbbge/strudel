/**
 * Pantry unit tests — zero infrastructure (temp dirs only), so "it works" is
 * reproducible without Pi or any live environment.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRoots, lexicalSearch } from "../src/pantry.js";

let root: string;

beforeEach(() => {
	root = join(
		tmpdir(),
		`strudel-pantry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
	const full = join(root, rel);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, content, "utf8");
}

describe("indexRoots — kind inferred from subdir name", () => {
	it("indexes multiple kinds, not just skills", async () => {
		write(
			"skills/debug/SKILL.md",
			"---\nname: debug\ndescription: find bugs\n---\nbody",
		);
		write(
			"rules/no-prod.md",
			"---\nname: no-prod\ndescription: never touch production\n---\nbody",
		);
		write(
			"prompts/standup.md",
			"---\nname: standup\ndescription: daily standup template\n---\nbody",
		);

		const items = await indexRoots([root]);
		const kinds = new Set(items.map((i) => i.kind));

		expect(kinds).toEqual(new Set(["skill", "rule", "prompt"]));
		expect(items.find((i) => i.name === "debug")?.kind).toBe("skill");
		expect(items.find((i) => i.name === "no-prod")?.description).toBe(
			"never touch production",
		);
	});

	it("tolerates numeric ordering prefixes on kind dirs (e.g. 03_skills)", async () => {
		write(
			"03_skills/foo/SKILL.md",
			"---\nname: foo\ndescription: a skill\n---\nx",
		);
		write("06_rules/bar.md", "---\nname: bar\ndescription: a rule\n---\nx");
		write("10-plugins/baz.md", "---\nname: baz\n---\nx");

		const items = await indexRoots([root]);
		expect(items.find((i) => i.name === "foo")?.kind).toBe("skill");
		expect(items.find((i) => i.name === "bar")?.kind).toBe("rule");
		expect(items.find((i) => i.name === "baz")?.kind).toBe("plugin");
	});

	it("derives name from filename/dirname when frontmatter omits it", async () => {
		write("skills/from-dir/SKILL.md", "no frontmatter here\njust prose");
		write("rules/from-file.md", "plain rule text");

		const items = await indexRoots([root]);
		expect(items.map((i) => i.name).sort()).toEqual(["from-dir", "from-file"]);
		// first prose line becomes the description fallback
		expect(items.find((i) => i.name === "from-file")?.description).toBe(
			"plain rule text",
		);
	});

	it("ignores unknown subdirs and dot/underscore entries", async () => {
		write("skills/real.md", "---\nname: real\n---\nx");
		write("skills/.hidden.md", "skip");
		write("skills/_lib.md", "skip");
		write("not-a-kind/thing.md", "skip");

		const items = await indexRoots([root]);
		expect(items.map((i) => i.name)).toEqual(["real"]);
	});

	it("dedupes by kind/name across roots (first root wins)", async () => {
		const root2 = `${root}-b`;
		write("skills/dup.md", "---\nname: dup\ndescription: from A\n---\nx");
		mkdirSync(join(root2, "skills"), { recursive: true });
		writeFileSync(
			join(root2, "skills", "dup.md"),
			"---\nname: dup\ndescription: from B\n---\nx",
		);

		const items = await indexRoots([root, root2]);
		const dups = items.filter((i) => i.name === "dup");
		expect(dups).toHaveLength(1);
		expect(dups[0].description).toBe("from A");
		rmSync(root2, { recursive: true, force: true });
	});

	it("skips absent roots without throwing", async () => {
		const items = await indexRoots(["/no/such/dir/anywhere", root]);
		expect(items).toEqual([]);
	});
});

describe("lexicalSearch — L0", () => {
	const items = [
		{
			name: "micro-animation-director",
			kind: "skill",
			description: "motion for HTML presentations",
			source: "a",
		},
		{
			name: "galley-api",
			kind: "skill",
			description: "graphql recipe queries",
			source: "b",
		},
		{
			name: "debug-hypothesis",
			kind: "skill",
			description: "scientific method for bugs",
			source: "c",
		},
	];

	it("ranks the relevant primitive on top", () => {
		const hits = lexicalSearch(items, "animate an HTML presentation");
		expect(hits[0].name).toBe("micro-animation-director");
	});

	it("returns nothing for an empty query", () => {
		expect(lexicalSearch(items, "   ")).toEqual([]);
	});

	it("only returns scoring matches", () => {
		const hits = lexicalSearch(items, "quantum tunneling");
		expect(hits).toEqual([]);
	});
});
