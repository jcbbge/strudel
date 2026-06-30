/**
 * Pantry unit tests — zero infrastructure (temp dirs only), so "it works" is
 * reproducible without Pi or any live environment.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexRoots, isOnDemand, lexicalSearch, expandHome } from "../src/pantry.js";

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

describe("code-file primitives", () => {
	it("indexes a plugin dir via package.json", async () => {
		write(
			"10_plugins/alembic/package.json",
			JSON.stringify({
				name: "alembic",
				description: "memory substrate extension",
			}),
		);
		write("10_plugins/alembic/index.ts", "export default () => {};");

		const p = (await indexRoots([root])).find((i) => i.name === "alembic");
		expect(p?.kind).toBe("plugin");
		expect(p?.description).toBe("memory substrate extension");
	});

	it("indexes a .ts plugin via its JSDoc header (skipping imports)", async () => {
		write(
			"10_plugins/composto.ts",
			"import x from 'y';\n\n/**\n * composto — code-to-IR compression.\n */\nexport default 1;",
		);
		const items = await indexRoots([root]);
		expect(items.find((i) => i.name === "composto")?.description).toBe(
			"composto — code-to-IR compression.",
		);
	});

	it("indexes an .mjs hook via its first line comment", async () => {
		write(
			"04_hooks/surface.mjs",
			"#!/usr/bin/env bun\n// SessionStart hook — surface unmerged work.\nconsole.log(1);",
		);
		expect(
			(await indexRoots([root])).find((i) => i.name === "surface")?.description,
		).toBe("SessionStart hook — surface unmerged work.");
	});

	it("indexes a .sh hook by name even with no usable description", async () => {
		write("04_hooks/session-start.sh", "#!/bin/bash\nexit 0\n");
		const h = (await indexRoots([root])).find(
			(i) => i.name === "session-start",
		);
		expect(h?.kind).toBe("hook");
		expect(h?.description).toBe("");
	});
});

describe("isOnDemand", () => {
	it("excludes ambient kinds", () => {
		for (const kind of ["rule", "hook", "directive", "provider"]) {
			expect(
				isOnDemand({ name: "x", kind, description: "", source: "s" }),
			).toBe(false);
		}
	});
	it("includes on-demand kinds", () => {
		for (const kind of [
			"skill",
			"tool",
			"mcp",
			"command",
			"plugin",
			"subagent",
			"agent",
		]) {
			expect(
				isOnDemand({ name: "x", kind, description: "", source: "s" }),
			).toBe(true);
		}
	});
});

describe("expandHome", () => {
	it("expands ~ to home directory", () => {
		const result = expandHome("~/foo/bar");
		expect(result).not.toContain("~");
		expect(result).toContain("foo/bar");
	});

	it("leaves absolute paths unchanged", () => {
		expect(expandHome("/absolute/path")).toBe("/absolute/path");
	});

	it("leaves relative paths unchanged", () => {
		expect(expandHome("relative/path")).toBe("relative/path");
	});
});

describe("agent vs subagent kinds", () => {
	it("maps agents/ directory to agent kind", async () => {
		write(
			"agents/worker.md",
			"---\nname: worker\ndescription: a worker agent\n---\nbody",
		);
		const items = await indexRoots([root]);
		const worker = items.find((i) => i.name === "worker");
		expect(worker?.kind).toBe("agent");
	});

	it("maps subagents/ directory to subagent kind", async () => {
		write(
			"subagents/coder.md",
			"---\nname: coder\ndescription: a coder subagent\n---\nbody",
		);
		const items = await indexRoots([root]);
		const coder = items.find((i) => i.name === "coder");
		expect(coder?.kind).toBe("subagent");
	});

	it("maps 08_subagents/ with prefix to subagent kind", async () => {
		write(
			"08_subagents/scout.md",
			"---\nname: scout\ndescription: a scout\n---\nbody",
		);
		const items = await indexRoots([root]);
		const scout = items.find((i) => i.name === "scout");
		expect(scout?.kind).toBe("subagent");
	});
});
