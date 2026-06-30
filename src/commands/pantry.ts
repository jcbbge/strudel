/**
 * /strudel-pantry — list the full primitive inventory
 *
 * Shows all indexed primitives grouped by kind, with optional filtering.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AMBIENT_KINDS } from "../pantry.js";
import { getState } from "../state.js";

export function registerPantryCommand(pi: ExtensionAPI): void {
	pi.registerCommand("strudel-pantry", {
		description:
			"List pantry inventory. Options: --kind <kind>, --search <query>",
		async handler(args, ctx) {
			const state = getState();
			const { fileIndex } = state;

			// Parse args
			let kindFilter: string | undefined;
			let searchFilter: string | undefined;

			const parts = args.trim().split(/\s+/);
			for (let i = 0; i < parts.length; i++) {
				if (parts[i] === "--kind" && parts[i + 1]) {
					kindFilter = parts[i + 1].toLowerCase();
					i++;
				} else if (parts[i] === "--search" && parts[i + 1]) {
					searchFilter = parts[i + 1].toLowerCase();
					i++;
				}
			}

			// Group by kind
			const byKind = new Map<string, typeof fileIndex>();
			for (const p of fileIndex) {
				const list = byKind.get(p.kind) ?? [];
				list.push(p);
				byKind.set(p.kind, list);
			}

			// Sort kinds by count descending
			const sortedKinds = [...byKind.entries()]
				.filter(([kind]) => !kindFilter || kind === kindFilter)
				.sort((a, b) => b[1].length - a[1].length);

			// Build output
			const sections: string[] = [];
			let totalShown = 0;

			for (const [kind, primitives] of sortedKinds) {
				const isAmbient = AMBIENT_KINDS.has(kind);
				const ambientNote = isAmbient ? " [ambient — not searchable]" : "";

				// Filter by search if provided
				let filtered = primitives;
				if (searchFilter) {
					filtered = primitives.filter(
						(p) =>
							p.name.toLowerCase().includes(searchFilter) ||
							p.description.toLowerCase().includes(searchFilter),
					);
				}

				if (filtered.length === 0) continue;

				const header = searchFilter
					? `${kind}/ matching "${searchFilter}" (${filtered.length} of ${primitives.length})${ambientNote}`
					: `${kind}/ (${filtered.length})${ambientNote}`;

				const items = filtered
					.sort((a, b) => a.name.localeCompare(b.name))
					.slice(0, 20) // Limit to first 20 per kind
					.map((p) => {
						const desc = p.description.slice(0, 50);
						return `  ${p.name.padEnd(28)} ${desc}${desc.length < p.description.length ? "..." : ""}`;
					});

				if (filtered.length > 20) {
					items.push(`  ... and ${filtered.length - 20} more`);
				}

				sections.push(`${header}\n${items.join("\n")}`);
				totalShown += filtered.length;
			}

			const output = `Pantry Inventory (${totalShown} primitives${searchFilter ? ` matching "${searchFilter}"` : ""})
══════════════════════════════════════════════════════

${sections.join("\n\n")}`;

			if (ctx.mode === "tui") {
				pi.sendMessage(
					{
						customType: "strudel-pantry",
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
