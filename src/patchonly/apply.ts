/**
 * Pure application engine — no filesystem, no git, no I/O. Takes an in-memory
 * file map plus validated edit inputs, returns a new map or a precise
 * conflict. Transactionality is structural: the input map is never mutated,
 * so a failed multi-edit intent writes nothing.
 *
 * Every claim here is a hypothesis with a test (C4: conflicts become data).
 */

import type { EditInput } from "./schema.js";

export interface ApplyOk {
	ok: true;
	files: Map<string, string>;
}

export interface ApplyConflict {
	ok: false;
	kind: "conflict";
	detail: string;
	edit_index: number;
}

export type ApplyResult = ApplyOk | ApplyConflict;

function conflict(editIndex: number, detail: string): ApplyConflict {
	return { ok: false, kind: "conflict", detail, edit_index: editIndex };
}

/** search_replace: the search text must occur exactly once. */
function applySearchReplace(
	content: string,
	edit: EditInput,
): { ok: true; content: string } | { ok: false; detail: string } {
	const search = edit.search as string;
	const first = content.indexOf(search);
	if (first === -1)
		return { ok: false, detail: "search text not found in file" };
	const second = content.indexOf(search, first + 1);
	if (second !== -1)
		return {
			ok: false,
			detail: "search text matches more than once; it must be unique",
		};
	return {
		ok: true,
		content:
			content.slice(0, first) +
			edit.replace +
			content.slice(first + search.length),
	};
}

// --- unified diff -----------------------------------------------------------
// Minimal but honest: standard @@ hunks with ' ', '-', '+' lines and
// "\ No newline at end of file" markers. Strict position matching — no fuzzy
// context search. Anything we cannot apply exactly is a conflict, never a
// guess.

interface Hunk {
	oldStart: number; // 1-based line in the old file
	oldLines: string[]; // context + deletions, in order
	newLines: string[]; // context + insertions, in order
	noNewlineOld: boolean;
	noNewlineNew: boolean;
}

export function parseUnifiedDiff(
	diff: string,
): { ok: true; hunks: Hunk[] } | { ok: false; detail: string } {
	const lines = diff.split("\n");
	const hunks: Hunk[] = [];
	let i = 0;
	while (i < lines.length) {
		const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]);
		if (!m) {
			i++;
			continue;
		}
		const hunk: Hunk = {
			oldStart: Number(m[1]),
			oldLines: [],
			newLines: [],
			noNewlineOld: false,
			noNewlineNew: false,
		};
		i++;
		let seen = 0;
		const oldCount = m[2] === undefined ? 1 : Number(m[2]);
		const newCount = m[4] === undefined ? 1 : Number(m[4]);
		let lastWasAdd = false;
		while (i < lines.length && seen < oldCount + newCount) {
			const line = lines[i];
			if (line.startsWith("\\ No newline at end of file")) {
				// The marker annotates the immediately preceding line: '+' → new
				// side; context or '-' → old side.
				if (lastWasAdd) hunk.noNewlineNew = true;
				else hunk.noNewlineOld = true;
				i++;
				continue;
			}
			if (line.startsWith(" ") || line === "") {
				hunk.oldLines.push(line.slice(1));
				hunk.newLines.push(line.slice(1));
				lastWasAdd = false;
				seen++;
			} else if (line.startsWith("-")) {
				hunk.oldLines.push(line.slice(1));
				lastWasAdd = false;
				seen++;
			} else if (line.startsWith("+")) {
				hunk.newLines.push(line.slice(1));
				lastWasAdd = true;
				seen++;
			} else {
				return {
					ok: false,
					detail: `unsupported diff line at ${i}: ${JSON.stringify(line.slice(0, 40))}`,
				};
			}
			i++;
		}
		// A trailing "\ No newline" marker can arrive after the hunk's counts
		// are satisfied — consume it here too.
		if (
			i < lines.length &&
			lines[i].startsWith("\\ No newline at end of file")
		) {
			if (lastWasAdd) hunk.noNewlineNew = true;
			else hunk.noNewlineOld = true;
			i++;
		}
		hunks.push(hunk);
	}
	if (hunks.length === 0)
		return { ok: false, detail: "no @@ hunks found in diff" };
	return { ok: true, hunks };
}

function applyHunks(
	content: string,
	hunks: Hunk[],
): { ok: true; content: string } | { ok: false; detail: string } {
	// Ghost-line representation: "a\nb\n".split("\n") → ["a","b",""] — the
	// trailing "" marks a newline-terminated file.
	const work = content.split("\n");
	let offset = 0;
	for (const hunk of hunks) {
		const start = hunk.oldStart - 1 + offset;
		if (start < 0 || start + hunk.oldLines.length > work.length) {
			return {
				ok: false,
				detail: `hunk @${hunk.oldStart} extends past end of file`,
			};
		}
		for (let j = 0; j < hunk.oldLines.length; j++) {
			if (work[start + j] !== hunk.oldLines[j]) {
				return {
					ok: false,
					detail: `hunk @${hunk.oldStart} context mismatch at old line ${hunk.oldStart + j}: expected ${JSON.stringify(hunk.oldLines[j])}, found ${JSON.stringify(work[start + j])}`,
				};
			}
		}
		work.splice(start, hunk.oldLines.length, ...hunk.newLines);
		offset += hunk.newLines.length - hunk.oldLines.length;
	}
	let result = work.join("\n");
	if (
		hunks.length > 0 &&
		hunks[hunks.length - 1].noNewlineNew &&
		result.endsWith("\n")
	) {
		result = result.slice(0, -1);
	}
	return { ok: true, content: result };
}

function applyUnifiedDiff(
	content: string,
	edit: EditInput,
): { ok: true; content: string } | { ok: false; detail: string } {
	const parsed = parseUnifiedDiff(edit.diff as string);
	if (!parsed.ok) return parsed;
	return applyHunks(content, parsed.hunks);
}

/**
 * Apply all edits transactionally against a snapshot of the working files.
 * `readAll` lets the caller decide where bytes come from (canonical tree,
 * fixture map); missing files are only legal for full_file (file creation).
 */
export function applyEdits(
	readFile: (path: string) => string | undefined,
	edits: EditInput[],
): ApplyResult {
	const files = new Map<string, string>();
	for (let i = 0; i < edits.length; i++) {
		const edit = edits[i];
		const existing = readFile(edit.file);
		if (edit.type !== "full_file" && existing === undefined) {
			return conflict(i, `file not found in tree: ${edit.file}`);
		}
		let result: { ok: true; content: string } | { ok: false; detail: string };
		switch (edit.type) {
			case "search_replace":
				result = applySearchReplace(existing as string, edit);
				break;
			case "unified_diff":
				result = applyUnifiedDiff(existing as string, edit);
				break;
			case "full_file":
				result = { ok: true, content: edit.content as string };
				break;
		}
		if (!result.ok) return conflict(i, `${edit.file}: ${result.detail}`);
		files.set(edit.file, result.content);
	}
	return { ok: true, files };
}
