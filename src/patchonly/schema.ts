/**
 * Edit Intent schema — the only legal mutation output an agent may produce
 * under the Patch-Only protocol (docs/PATCH-ONLY.md §Schema).
 *
 * v1 is deliberately dead simple: three edit types, one branch hint, optional
 * test commands. Extend only if validation demands it.
 */

import { type Static, Type } from "typebox";

export const EditType = Type.Union([
	Type.Literal("search_replace"),
	Type.Literal("unified_diff"),
	Type.Literal("full_file"),
]);

export const EditInputSchema = Type.Object({
	file: Type.String({ description: "Path relative to the repo root." }),
	type: EditType,
	search: Type.Optional(Type.String()),
	replace: Type.Optional(Type.String()),
	diff: Type.Optional(Type.String()),
	content: Type.Optional(Type.String()),
});

export const EditIntentSchema = Type.Object({
	intent_id: Type.String({ minLength: 1 }),
	agent_id: Type.String({ minLength: 1 }),
	base_commit: Type.String({ minLength: 1 }),
	branch: Type.Optional(Type.String()),
	edits: Type.Array(EditInputSchema, { minItems: 1 }),
	test_commands: Type.Optional(Type.Array(Type.String())),
	rationale: Type.Optional(Type.String()),
});

export type EditInput = Static<typeof EditInputSchema>;
export type EditIntent = Static<typeof EditIntentSchema>;

/** Structured rejection — conflicts become data, not filesystem corruption. */
export type RejectionKind =
	| "invalid"
	| "conflict"
	| "test_failure"
	| "stale_base"
	| "busy"
	| "dirty_tree";

export interface Rejection {
	ok: false;
	kind: RejectionKind;
	detail: string;
	edit_index?: number;
	command_output?: Array<{
		command: string;
		exit_code: number;
		stdout: string;
		stderr: string;
	}>;
}

export interface Application {
	ok: true;
	intent_id: string;
	agent_id: string;
	branch: string;
	commit: string;
	ms: number;
	lock_wait_ms: number;
	isolation_cost: { files_copied: 0; bytes_copied: 0 };
}

export type ApplyOutcome = Application | Rejection;

const EDIT_TYPE_FIELDS: Record<EditInput["type"], string> = {
	search_replace: "search",
	unified_diff: "diff",
	full_file: "content",
};

/**
 * Structural validation with precise errors — the applier must never guess.
 * Returns null when valid, else a detail string.
 */
export function validateIntent(raw: unknown): string | null {
	if (raw === null || typeof raw !== "object")
		return "intent must be a JSON object";
	const intent = raw as Record<string, unknown>;
	if (typeof intent.intent_id !== "string" || intent.intent_id.length === 0)
		return "intent_id required";
	if (typeof intent.agent_id !== "string" || intent.agent_id.length === 0)
		return "agent_id required";
	if (typeof intent.base_commit !== "string" || intent.base_commit.length === 0)
		return "base_commit required";
	if (!Array.isArray(intent.edits) || intent.edits.length === 0)
		return "edits must be a non-empty array";
	for (let i = 0; i < intent.edits.length; i++) {
		const e = intent.edits[i] as Record<string, unknown>;
		if (typeof e.file !== "string" || e.file.length === 0)
			return `edits[${i}].file required`;
		if (e.file.startsWith("/"))
			return `edits[${i}].file must be relative to the repo root`;
		const field = EDIT_TYPE_FIELDS[e.type as EditInput["type"]];
		if (!field)
			return `edits[${i}].type must be search_replace | unified_diff | full_file`;
		if (typeof e[field] !== "string" || (e[field] as string).length === 0)
			return `edits[${i}] of type ${e.type} requires "${field}"`;
	}
	return null;
}
