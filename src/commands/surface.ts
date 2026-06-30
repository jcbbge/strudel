/**
 * /strudel-surface — show surface control state
 *
 * Shows what's active, what's baseline, what got suppressed this turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getState } from "../state.js";

export function registerSurfaceCommand(pi: ExtensionAPI): void {
	pi.registerCommand("strudel-surface", {
		description: "Show surface control state — baseline, activated, suppressed",
		async handler(_args, ctx) {
			const state = getState();
			const { config, activated, baseline } = state;

			// Get all runtime tools
			const allTools = pi.getAllTools();
			const allToolNames = new Set(allTools.map((t) => t.name));

			// Calculate active and suppressed
			const activeSet = new Set([...baseline, ...activated]);
			const suppressed = allTools.filter((t) => !activeSet.has(t.name));

			// Format baseline
			const baselineList = baseline.join(", ");

			// Format activated
			const activatedList =
				activated.size > 0 ? [...activated].join(", ") : "(none yet)";

			// Format suppressed (first 10)
			const suppressedNames = suppressed.map((t) => t.name);
			const suppressedList =
				suppressedNames.length > 0
					? suppressedNames.slice(0, 10).join(", ") +
						(suppressedNames.length > 10
							? `, ... (${suppressedNames.length - 10} more)`
							: "")
					: "(none)";

			const output = `Surface Control (${config.surface} mode)
══════════════════════════════════════════════════════

Baseline tools (always active):
  ${baselineList}

Activated this session (via strudel_search):
  ${activatedList}

Runtime tools available (from Pi registry):
  ${allTools.length} total — ${suppressed.length} suppressed, ${activeSet.size} active

Suppressed tools (would be in prompt without strudel):
  ${suppressedList}

Prompt sections:
  <available_skills> block: STRIPPED (skills discovered via strudel_search)
  Available tools: section: PRUNED to active tools only`;

			if (ctx.mode === "tui") {
				pi.sendMessage(
					{
						customType: "strudel-surface",
						content: output,
						display: true,
					},
					{ triggerTurn: false },
				);
			} else {
				console.log(output);
			}
		},
	});
}
