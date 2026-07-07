/**
 * Surface-control unit tests — zero infrastructure. Pure functions only.
 */

import { describe, expect, it } from "vitest";
import {
	GATEWAY_TOOL,
	baselineTools,
	computeActiveSurface,
	evictOverCap,
	pruneToolsSection,
	stripSkillsBlock,
	touchActivated,
} from "../src/surface.js";

describe("baselineTools", () => {
	it("pragmatic keeps the file tools + infrastructure", () => {
		expect(baselineTools("pragmatic")).toEqual([
			"read",
			"write",
			"edit",
			"bash",
			"subagent",
			"strudel_prep",
			"strudel_bake",
		]);
	});
	it("strict keeps the bare minimum + infrastructure", () => {
		expect(baselineTools("strict")).toEqual(["read", "subagent", "strudel_prep", "strudel_bake"]);
	});
	it("an explicit override wins", () => {
		expect(baselineTools("pragmatic", ["read", "grep"])).toEqual([
			"read",
			"grep",
		]);
	});
});

describe("computeActiveSurface", () => {
	const available = new Set([
		"read",
		"write",
		"edit",
		"bash",
		"grep",
		"alembic_create_shard",
		GATEWAY_TOOL,
	]);

	it("locks to gateway + baseline, dropping everything else", () => {
		const active = computeActiveSurface(
			["read", "write", "edit", "bash"],
			[],
			available,
		);
		expect(new Set(active)).toEqual(
			new Set([GATEWAY_TOOL, "read", "write", "edit", "bash"]),
		);
		expect(active).not.toContain("alembic_create_shard");
	});

	it("includes session-activated primitives", () => {
		const active = computeActiveSurface(
			["read"],
			["alembic_create_shard"],
			available,
		);
		expect(active).toContain("alembic_create_shard");
		expect(active).toContain(GATEWAY_TOOL);
	});

	it("always includes the gateway, even if not in available", () => {
		expect(computeActiveSurface([], [], new Set())).toEqual([GATEWAY_TOOL]);
	});

	it("drops baseline names that aren't registered", () => {
		const active = computeActiveSurface(["read", "nonexistent"], [], available);
		expect(active).toContain("read");
		expect(active).not.toContain("nonexistent");
	});
});

describe("LRU activation (touchActivated + evictOverCap)", () => {
	it("a tool activated first but touched most recently survives eviction; the untouched middle tool is evicted", () => {
		const activated = new Set(["first", "middle", "last"]);
		// "first" was activated earliest, but is re-used (touched) most recently
		touchActivated(activated, "first");
		evictOverCap(activated, 2);
		expect(activated.has("middle")).toBe(false); // least-recently-used
		expect(activated.has("first")).toBe(true); // oldest insertion, freshest use
		expect(activated.has("last")).toBe(true);
	});

	it("without a touch, eviction falls back to insertion order (oldest first)", () => {
		const activated = new Set(["a", "b", "c"]);
		evictOverCap(activated, 2);
		expect([...activated]).toEqual(["b", "c"]);
	});

	it("touchActivated is a no-op for names that aren't activated", () => {
		const activated = new Set(["a", "b"]);
		touchActivated(activated, "nope");
		expect([...activated]).toEqual(["a", "b"]);
	});

	it("evictOverCap evicts repeatedly until the set fits the cap", () => {
		const activated = new Set(["a", "b", "c", "d", "e"]);
		touchActivated(activated, "b");
		evictOverCap(activated, 2);
		expect([...activated]).toEqual(["e", "b"]);
	});

	it("evictOverCap leaves a set at/under the cap untouched", () => {
		const activated = new Set(["a", "b"]);
		evictOverCap(activated, 2);
		expect([...activated]).toEqual(["a", "b"]);
	});
});

describe("stripSkillsBlock", () => {
	it("removes the available_skills dump and adds the pointer", () => {
		const prompt =
			"You are an agent.\n\n<available_skills>\n  <skill><name>a</name></skill>\n  <skill><name>b</name></skill>\n</available_skills>\n\nCurrent date: today";
		const out = stripSkillsBlock(prompt);
		expect(out).not.toContain("<available_skills>");
		expect(out).not.toContain("<skill>");
		expect(out).toContain("Call the `strudel_search` tool");
		expect(out).toContain("You are an agent.");
		expect(out).toContain("Current date: today");
	});

	it("adds the pointer even when there is no skills block", () => {
		expect(stripSkillsBlock("just a prompt")).toContain(
			"Call the `strudel_search` tool",
		);
	});

	it("is idempotent — no duplicate pointer", () => {
		const once = stripSkillsBlock("p");
		const twice = stripSkillsBlock(once);
		expect(twice.match(/Call the `strudel_search` tool/g)).toHaveLength(1);
	});
});

describe("pruneToolsSection", () => {
	const prompt = [
		"You are an agent.",
		"",
		"Available tools:",
		"- read: read a file",
		"- bash: run a command",
		"- alembic_create_shard: write a memory",
		"- strudel_search: find primitives",
		"",
		"Current date: today",
	].join("\n");

	it("keeps only the active tools and drops the rest", () => {
		const out = pruneToolsSection(
			prompt,
			new Set(["read", "bash", "strudel_search"]),
		);
		expect(out).toContain("- read: read a file");
		expect(out).toContain("- bash: run a command");
		expect(out).toContain("- strudel_search: find primitives");
		expect(out).not.toContain("alembic_create_shard");
		expect(out).toContain("call strudel_search to find them");
		// surrounding prompt is preserved
		expect(out).toContain("You are an agent.");
		expect(out).toContain("Current date: today");
	});

	it("leaves a prompt without a tools section unchanged", () => {
		const p = "no tools section here";
		expect(pruneToolsSection(p, new Set(["read"]))).toBe(p);
	});
});
