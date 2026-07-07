/**
 * Presentation genome — pure helpers that decide how strudel presents itself
 * to the model: tool descriptions/promptSnippets and the pantry inventory line.
 * All overridable from config (`presentation` section) so an eval harness can
 * treat the presentation as the genome under optimization.
 */

import type { PresentationConfig, ToolPresentation } from "./state.js";

/**
 * Resolve a tool's presentation: config override wins per-field, defaults fill
 * the rest.
 */
export function presentTool(
	presentation: PresentationConfig | undefined,
	name: string,
	defaults: Required<ToolPresentation>,
): Required<ToolPresentation> {
	const override = presentation?.tools?.[name];
	return {
		description: override?.description ?? defaults.description,
		promptSnippet: override?.promptSnippet ?? defaults.promptSnippet,
	};
}

/** The default one-line pantry inventory announcement for the system prompt. */
export function defaultInventoryLine(
	total: number,
	byKind: Map<string, number>,
): string {
	const kindSummary = [...byKind.entries()]
		.map(([k, n]) => `${k}:${n}`)
		.join(" ");
	return (
		`Pantry: ${total} indexed capabilities (${kindSummary}). ` +
		`Your visible tools are a cache, not your inventory — strudel_search finds the rest.`
	);
}

/**
 * The inventory line to inject, honoring the config override:
 * `false` suppresses it, a string replaces it, absent means the default.
 */
export function resolveInventoryLine(
	presentation: PresentationConfig | undefined,
	defaultLine: string,
): string | undefined {
	const override = presentation?.inventoryLine;
	if (override === false) return undefined;
	if (typeof override === "string") return override;
	return defaultLine;
}
