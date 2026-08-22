/**
 * Harness restriction shim for pi — the agent-side half of the Patch-Only
 * protocol (docs/PATCH-ONLY.md §Manifest).
 *
 * Three layers, strongest first:
 *   1. setActiveTools removes edit/write from the surface entirely.
 *   2. A tool_call hook blocks them anyway (belt-and-suspenders against
 *      re-enablement) and redirects the model to submit_edit_intent.
 *   3. submit_edit_intent forwards a validated intent to the applier socket.
 *
 * The agent's cognitive loop is unchanged — it reads, reasons, proposes.
 * Only the final mutation path moves from local writes to the applier.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { validateIntent } from "./schema.js";
import { submitIntent } from "./server.js";

export const DEFAULT_BLOCKED_TOOLS = ["edit", "write"];

export interface PatchOnlyOptions {
	socketPath?: string;
	blockedTools?: string[];
}

export function defaultSocketPath(): string {
	return (
		process.env.PATCHONLY_SOCKET ??
		join(homedir(), ".patchonly", "applier.sock")
	);
}

export default function patchOnly(
	pi: ExtensionAPI,
	options?: PatchOnlyOptions,
): void {
	const blocked = options?.blockedTools ?? DEFAULT_BLOCKED_TOOLS;
	const socketPath = options?.socketPath ?? defaultSocketPath();

	// Layer 1: remove mutating tools from the active surface.
	const active = pi.getActiveTools().filter((name) => !blocked.includes(name));
	pi.setActiveTools(active);

	// Layer 2: block anyway if something re-enables them; the block reason is
	// the redirect instruction the model re-reasons against.
	pi.on("tool_call", (event) => {
		if (blocked.includes(event.toolName)) {
			return {
				block: true,
				reason:
					"Patch-Only protocol: direct file mutation is disabled in this session. " +
					"Call submit_edit_intent with your change as an Edit Intent instead.",
			};
		}
	});

	// Layer 3: the only legal mutation door.
	pi.registerTool({
		name: "submit_edit_intent",
		label: "Submit Edit Intent",
		description:
			"Propose code changes under the Patch-Only experiment. You never edit files directly; " +
			"you submit an Edit Intent (search_replace / unified_diff / full_file edits reasoned " +
			"against base_commit). The central applier validates, verifies, and either commits to " +
			"a branch or returns structured conflict/test output. Treat every rejection as new " +
			"context and resubmit a revised intent.",
		promptSnippet:
			"submit_edit_intent: the only way to change code here — propose an Edit Intent to the central applier.",
		promptGuidelines: [
			"You have no direct file editing tools. All changes go through submit_edit_intent.",
			"Reason against the current commit (base_commit); if rejected as stale_base, re-read the file and re-reason.",
			"On rejection, treat the conflict markers or test output as new context and revise the intent.",
		],
		parameters: Type.Object({
			intent_id: Type.String({
				description: "Unique id you generate for this proposal.",
			}),
			base_commit: Type.String({
				description: "The HEAD sha you reasoned against.",
			}),
			branch: Type.Optional(
				Type.String({
					description:
						"Target branch; defaults to the applier's current branch.",
				}),
			),
			edits: Type.Array(
				Type.Object({
					file: Type.String({ description: "Repo-relative file path." }),
					type: Type.Union([
						Type.Literal("search_replace"),
						Type.Literal("unified_diff"),
						Type.Literal("full_file"),
					]),
					search: Type.Optional(
						Type.String({
							description:
								"search_replace: exact text, must occur exactly once.",
						}),
					),
					replace: Type.Optional(
						Type.String({ description: "search_replace: replacement text." }),
					),
					diff: Type.Optional(
						Type.String({
							description: "unified_diff: standard @@ hunks with context.",
						}),
					),
					content: Type.Optional(
						Type.String({
							description: "full_file: complete new file content.",
						}),
					),
				}),
				{ minItems: 1 },
			),
			test_commands: Type.Optional(
				Type.Array(Type.String(), {
					description: "Commands the applier runs before committing.",
				}),
			),
			rationale: Type.Optional(
				Type.String({ description: "One line; lands in the commit message." }),
			),
		}),
		async execute(_toolCallId, params) {
			const intent = {
				intent_id: params.intent_id,
				agent_id: process.env.PATCHONLY_AGENT_ID ?? `pi-${process.pid}`,
				base_commit: params.base_commit,
				branch: params.branch,
				edits: params.edits,
				test_commands: params.test_commands,
				rationale: params.rationale,
			};
			const invalid = validateIntent(intent);
			if (invalid !== null) {
				return {
					content: [
						{ type: "text", text: `Intent rejected (invalid): ${invalid}` },
					],
					isError: true,
					details: undefined,
				};
			}
			try {
				const outcome = await submitIntent(socketPath, intent);
				return {
					content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
					isError: !outcome.ok,
					details: outcome,
				};
			} catch (e) {
				return {
					content: [
						{
							type: "text",
							text: `Applier unreachable at ${socketPath}: ${(e as Error).message}`,
						},
					],
					isError: true,
					details: undefined,
				};
			}
		},
	});
}
