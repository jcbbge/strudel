/**
 * Findability self-test — intent extraction, recall check, and /health section.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type FindabilityHit,
	formatFindability,
	intentsFor,
	runFindabilityCheck,
	syntheticIntents,
} from "../src/findability.js";
import { type Primitive, indexRoots } from "../src/pantry.js";
import { type StrudelConfig, initState } from "../src/state.js";

let testRoot: string;

beforeEach(() => {
	testRoot = join(tmpdir(), `strudel-findability-test-${Date.now()}`);
	mkdirSync(join(testRoot, "skills"), { recursive: true });
	mkdirSync(join(testRoot, "rules"), { recursive: true });
});

afterEach(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

const prim = (over: Partial<Primitive>): Primitive => ({
	name: "p",
	kind: "skill",
	description: "",
	source: "/x/p.md",
	...over,
});

describe("intent extraction from frontmatter", () => {
	it("parses a YAML list of intents", async () => {
		writeFileSync(
			join(testRoot, "skills", "pdf-render.md"),
			`---
name: pdf-render
description: Render HTML to PDF.
intents:
  - convert html to pdf
  - generate a pdf report
---
Content`,
		);
		const [p] = await indexRoots([testRoot]);
		expect(p.intents).toEqual(["convert html to pdf", "generate a pdf report"]);
	});

	it("parses inline comma-separated intents", async () => {
		writeFileSync(
			join(testRoot, "skills", "csv.md"),
			`---
name: csv
description: CSV tools.
intents: parse a csv file, "export data as csv"
---
Content`,
		);
		const [p] = await indexRoots([testRoot]);
		expect(p.intents).toEqual(["parse a csv file", "export data as csv"]);
	});

	it("omits intents when frontmatter has none", async () => {
		writeFileSync(
			join(testRoot, "skills", "plain.md"),
			"---\nname: plain\ndescription: No intents here.\n---\nContent",
		);
		const [p] = await indexRoots([testRoot]);
		expect(p.intents).toBeUndefined();
	});
});

describe("syntheticIntents", () => {
	it("derives first sentence + name expansion", () => {
		const p = prim({
			name: "debug-hypothesis",
			description: "Scientific debugging loop. Use for flaky tests.",
		});
		expect(syntheticIntents(p)).toEqual([
			"Scientific debugging loop",
			"debug hypothesis",
		]);
	});

	it("caps at 2 and handles empty description", () => {
		const p = prim({ name: "solo_tool", description: "" });
		const intents = syntheticIntents(p);
		expect(intents).toEqual(["solo tool"]);
		expect(intents.length).toBeLessThanOrEqual(2);
	});

	it("intentsFor prefers authored intents", () => {
		const p = prim({ description: "Something.", intents: ["authored intent"] });
		expect(intentsFor(p)).toEqual(["authored intent"]);
	});
});

describe("runFindabilityCheck", () => {
	const pantry: Primitive[] = [
		prim({ name: "alpha", intents: ["find alpha"] }),
		prim({ name: "beta", intents: ["find beta", "second beta intent"] }),
		prim({ name: "ambient-rule", kind: "rule", intents: ["a rule"] }),
	];

	// Stub: only "find alpha" surfaces alpha; nothing surfaces beta.
	const stubSearch = (query: string): FindabilityHit[] =>
		query === "find alpha" ? [{ name: "alpha", kind: "skill" }] : [];

	it("computes recall@k and the DARK list", async () => {
		const report = await runFindabilityCheck(pantry, stubSearch, { k: 5 });
		expect(report.results).toHaveLength(2); // ambient rule excluded
		expect(report.searches).toBe(3);
		expect(report.recallAtK).toBeCloseTo(1 / 3);
		expect(report.dark.map((d) => d.name)).toEqual(["beta"]);
		expect(report.sampled).toBe(false);
	});

	it("respects top-k cutoff", async () => {
		const deepSearch = (): FindabilityHit[] => [
			{ name: "x1", kind: "skill" },
			{ name: "x2", kind: "skill" },
			{ name: "alpha", kind: "skill" },
		];
		const one = await runFindabilityCheck([pantry[0]], deepSearch, { k: 2 });
		expect(one.dark).toHaveLength(1); // alpha is rank 3, k=2 misses it
		const three = await runFindabilityCheck([pantry[0]], deepSearch, { k: 3 });
		expect(three.dark).toHaveLength(0);
	});

	it("caps total searches and marks the run as sampled", async () => {
		const big: Primitive[] = Array.from({ length: 400 }, (_, i) =>
			prim({ name: `p${i}`, intents: [`intent ${i}`] }),
		);
		let calls = 0;
		const report = await runFindabilityCheck(big, () => {
			calls++;
			return [];
		});
		expect(calls).toBeLessThanOrEqual(300);
		expect(report.searches).toBeLessThanOrEqual(300);
		expect(report.sampled).toBe(true);
	});
});

describe("formatFindability", () => {
	it("renders recall, dark count, and verdict", async () => {
		const report = await runFindabilityCheck(
			[prim({ name: "alpha", intents: ["find alpha"] })],
			() => [{ name: "alpha", kind: "skill" }],
		);
		const out = formatFindability(report);
		expect(out).toContain("recall@5: 100.0%");
		expect(out).toContain("dark primitives: 0");
		expect(out).toContain("verdict: healthy");
	});

	it("lists dark primitives capped at 10", async () => {
		const pantry = Array.from({ length: 12 }, (_, i) =>
			prim({ name: `dark${i}`, intents: [`intent ${i}`] }),
		);
		const report = await runFindabilityCheck(pantry, () => []);
		const out = formatFindability(report);
		expect(out).toContain("dark primitives: 12");
		expect(out).toContain("skill/dark0");
		expect(out).toContain("… and 2 more");
		expect(out).not.toContain("skill/dark11");
	});
});

describe("/health findability section (lexical mode)", () => {
	function createMockPi() {
		const commands: Array<{ name: string; handler: Function }> = [];
		return {
			registerCommand(name: string, opts: { handler: Function }) {
				commands.push({ name, handler: opts.handler });
			},
			sendMessage() {},
			_findCommand: (name: string) => commands.find((c) => c.name === name),
		};
	}

	it("renders the section without embeddings configured", async () => {
		writeFileSync(
			join(testRoot, "skills", "found-skill.md"),
			`---
name: found-skill
description: A findable skill.
intents:
  - found skill
---
Content`,
		);
		writeFileSync(
			join(testRoot, "skills", "zzz-unfindable.md"),
			`---
name: zzz-unfindable
description: qqqq
intents:
  - completely unrelated wording xyzzy
---
Content`,
		);

		const fileIndex = await indexRoots([testRoot]);
		const config: StrudelConfig = { roots: [testRoot], surface: "pragmatic" };
		const mockPi = createMockPi();
		initState({
			config,
			fileIndex,
			activated: new Set<string>(),
			baseline: [],
			pi: mockPi as any,
		});

		const { registerHealthCommand } = await import("../src/commands/health.js");
		registerHealthCommand(mockPi as any);
		const cmd = mockPi._findCommand("strudel-health");

		const output: string[] = [];
		const originalLog = console.log;
		console.log = (msg: string) => output.push(msg);
		await cmd!.handler("", { mode: "print", ui: { notify: vi.fn() } });
		console.log = originalLog;

		const text = output.join("\n");
		expect(text).toContain("Findability (self-test");
		expect(text).toContain("recall@5:");
		expect(text).toContain("dark primitives: 1");
		expect(text).toContain("skill/zzz-unfindable");
		expect(text).toContain("verdict:");
	});
});
