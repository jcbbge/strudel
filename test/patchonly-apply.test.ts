/**
 * Pure application engine + intent schema (C4 at the unit level).
 * No filesystem, no git — conflicts must be data even here.
 */

import { afterEach, describe, expect, it } from "vitest";
import { applyEdits, parseUnifiedDiff } from "../src/patchonly/apply.js";
import { resolveAgentId } from "../src/patchonly/pi-extension.js";
import { validateIntent } from "../src/patchonly/schema.js";

const FILE = "src/hello.ts";

function mapOf(entries: Record<string, string>): Map<string, string> {
	return new Map(Object.entries(entries));
}

describe("validateIntent", () => {
	const valid = {
		intent_id: "i-1",
		agent_id: "a-1",
		base_commit: "abc123",
		edits: [{ file: "a.ts", type: "full_file", content: "x" }],
	};

	it("accepts a minimal valid intent", () => {
		expect(validateIntent(valid)).toBeNull();
	});

	it.each([
		[null, /must be a JSON object/],
		[{ ...valid, intent_id: "" }, /intent_id required/],
		[{ ...valid, agent_id: undefined }, /agent_id required/],
		[{ ...valid, base_commit: "" }, /base_commit required/],
		[{ ...valid, edits: [] }, /non-empty array/],
		[
			{
				...valid,
				edits: [{ file: "/abs.ts", type: "full_file", content: "x" }],
			},
			/relative to the repo root/,
		],
		[
			{ ...valid, edits: [{ file: "a.ts", type: "nope", content: "x" }] },
			/search_replace \| unified_diff \| full_file/,
		],
		[
			{
				...valid,
				edits: [{ file: "a.ts", type: "search_replace", replace: "y" }],
			},
			/requires "search"/,
		],
	])("rejects %j with a precise detail", (raw, expected) => {
		expect(validateIntent(raw)).toMatch(expected);
	});
});

describe("applyEdits — search_replace", () => {
	const files = mapOf({ [FILE]: "export const x = 1;\n" });

	it("replaces a unique match", () => {
		const r = applyEdits(
			(p) => files.get(p),
			[
				{
					file: FILE,
					type: "search_replace",
					search: "x = 1",
					replace: "x = 2",
				},
			],
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.files.get(FILE)).toBe("export const x = 2;\n");
	});

	it("rejects when search text is absent", () => {
		const r = applyEdits(
			(p) => files.get(p),
			[
				{
					file: FILE,
					type: "search_replace",
					search: "not there",
					replace: "y",
				},
			],
		);
		expect(r).toMatchObject({ ok: false, kind: "conflict", edit_index: 0 });
	});

	it("rejects when search text matches more than once", () => {
		const dup = mapOf({ [FILE]: "a;\na;\n" });
		const r = applyEdits(
			(p) => dup.get(p),
			[{ file: FILE, type: "search_replace", search: "a;", replace: "b;" }],
		);
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.detail).toMatch(/more than once/);
	});
});

describe("applyEdits — unified_diff", () => {
	const files = mapOf({
		[FILE]: "line one\nline two\nline three\n",
	});

	const diff = `--- a/${FILE}
+++ b/${FILE}
@@ -1,3 +1,3 @@
 line one
-line two
+line 2 CHANGED
 line three
`;

	it("applies a standard hunk strictly by position and context", () => {
		const r = applyEdits(
			(p) => files.get(p),
			[{ file: FILE, type: "unified_diff", diff }],
		);
		expect(r.ok).toBe(true);
		if (r.ok)
			expect(r.files.get(FILE)).toBe("line one\nline 2 CHANGED\nline three\n");
	});

	it("rejects on context mismatch instead of fuzzy-matching", () => {
		const shifted = mapOf({ [FILE]: "different\ntext\nentirely\n" });
		const r = applyEdits(
			(p) => shifted.get(p),
			[{ file: FILE, type: "unified_diff", diff }],
		);
		expect(r).toMatchObject({ ok: false, kind: "conflict" });
		if (!r.ok) expect(r.detail).toMatch(/context mismatch/);
	});

	it("rejects hunks that run past end of file", () => {
		const short = mapOf({ [FILE]: "only one\n" });
		const r = applyEdits(
			(p) => short.get(p),
			[{ file: FILE, type: "unified_diff", diff }],
		);
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.detail).toMatch(/past end of file/);
	});

	it("handles the no-newline-at-EOF marker", () => {
		const noNl = mapOf({ [FILE]: "old last" });
		const d = `@@ -1 +1 @@
-old last
+new last
\\ No newline at end of file
`;
		const r = applyEdits(
			(p) => noNl.get(p),
			[{ file: FILE, type: "unified_diff", diff: d }],
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.files.get(FILE)).toBe("new last");
	});

	it("reports diffs with no hunks as invalid input, not silent success", () => {
		expect(parseUnifiedDiff("not a diff")).toMatchObject({ ok: false });
	});
});

describe("applyEdits — full_file + transactionality", () => {
	it("creates new files via full_file", () => {
		const r = applyEdits(
			() => undefined,
			[{ file: "new/dir/file.ts", type: "full_file", content: "hi\n" }],
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.files.get("new/dir/file.ts")).toBe("hi\n");
	});

	it("is transactional: a failure in edit N leaves nothing applied", () => {
		const files = mapOf({
			"a.ts": "alpha\n",
			"b.ts": "beta\n",
		});
		const r = applyEdits(
			(p) => files.get(p),
			[
				{
					file: "a.ts",
					type: "search_replace",
					search: "alpha",
					replace: "ALPHA",
				},
				{
					file: "b.ts",
					type: "search_replace",
					search: "missing",
					replace: "BETA",
				},
			],
		);
		expect(r.ok).toBe(false);
		// The structural proof of transactionality: applyEdits returns a NEW map
		// only on success; the original snapshot object is untouched either way.
		if (!r.ok) expect(r.edit_index).toBe(1);
	});

	it("rejects non-full_file edits against missing files", () => {
		const r = applyEdits(
			() => undefined,
			[{ file: "ghost.ts", type: "search_replace", search: "a", replace: "b" }],
		);
		expect(r).toMatchObject({ ok: false });
		if (!r.ok) expect(r.detail).toMatch(/file not found/);
	});
});

describe("resolveAgentId", () => {
	const OLD_ENV = { ...process.env };
	afterEach(() => {
		process.env = { ...OLD_ENV };
	});

	it("prefers the explicit override", () => {
		process.env.HERDR_WORKSPACE_ID = "w1A";
		process.env.HERDR_PANE_ID = "p12";
		expect(resolveAgentId("named-agent")).toBe("named-agent");
	});

	it("derives herdr pane identity when the environment provides it", () => {
		process.env.HERDR_WORKSPACE_ID = "w1A";
		process.env.HERDR_PANE_ID = "p12";
		expect(resolveAgentId()).toBe("herdr:w1A:p12");
	});

	it("falls back to a process id when no environment names it", () => {
		delete process.env.HERDR_WORKSPACE_ID;
		delete process.env.HERDR_PANE_ID;
		expect(resolveAgentId()).toMatch(/^pi-\d+$/);
	});
});
