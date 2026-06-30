/**
 * /strudel — main command with subcommand routing
 *
 * /strudel (no args) → status overview
 * /strudel status    → same as no args
 * /strudel <other>   → routed to strudel-<other> command
 */

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AMBIENT_KINDS, expandHome } from "../pantry.js";
import { getState, STRUDEL_VERSION } from "../state.js";

export function registerStatusCommand(pi: ExtensionAPI): void {
	pi.registerCommand("strudel", {
		description:
			"Strudel introspection — status (default), pantry, surface, search, health",
		async handler(args, ctx) {
			const trimmed = args.trim();
			const [subcommand, ...rest] = trimmed.split(/\s+/);

			// Route to subcommands
			if (subcommand && subcommand !== "status") {
				const subArgs = rest.join(" ");
				// Find and invoke the subcommand
				const commands = pi.getCommands();
				const target = commands.find(
					(c) => c.name === `strudel-${subcommand}`,
				);
				if (target) {
					// Invoke the subcommand handler directly
					// We need to get the actual handler, which isn't exposed via getCommands()
					// So we use a workaround: notify user to use the full command
					ctx.ui.notify(
						`Use /strudel-${subcommand} ${subArgs}`.trim(),
						"info",
					);
					return;
				}
				ctx.ui.notify(
					`Unknown subcommand: ${subcommand}. Available: status, pantry, surface, search, health`,
					"error",
				);
				return;
			}

			// Default: show status
			const state = getState();
			const { config, fileIndex, activated, baseline } = state;

			// Check config file
			const configPath = join(homedir(), ".strudel", "config.json");
			let configExists = false;
			try {
				await access(configPath);
				configExists = true;
			} catch {
				// doesn't exist
			}

			// Check roots
			const rootStatus: { path: string; exists: boolean; count: number }[] = [];
			for (const root of config.roots) {
				const expanded = expandHome(root);
				let exists = false;
				try {
					await access(expanded);
					exists = true;
				} catch {
					// doesn't exist
				}
				const count = fileIndex.filter((p) => p.source.startsWith(expanded))
					.length;
				rootStatus.push({ path: root, exists, count });
			}

			// Count by kind
			const byKind = new Map<string, number>();
			for (const p of fileIndex) {
				byKind.set(p.kind, (byKind.get(p.kind) ?? 0) + 1);
			}
			const kindRows = [...byKind.entries()]
				.sort((a, b) => b[1] - a[1])
				.map(([kind, count]) => {
					const ambient = AMBIENT_KINDS.has(kind) ? " (ambient)" : "";
					return `  ${kind.padEnd(12)} ${String(count).padStart(4)}${ambient}`;
				})
				.join("\n");

			// Search mode
			const searchMode = config.embeddings
				? `semantic (L1)\n        model: ${config.embeddings.model}\n        endpoint: ${config.embeddings.baseUrl}`
				: "lexical (L0)";

			// Surface info
			const allTools = pi.getAllTools();
			const activeCount = baseline.length + activated.size;

			const output = `Strudel v${STRUDEL_VERSION}
══════════════════════════════════════════════════════

Config: ${configPath} ${configExists ? "✓" : "✗ (not found)"}
Roots:${rootStatus.map((r) => `\n  ${r.path} ${r.exists ? "✓" : "✗"} (${r.count} primitives)`).join("")}

Pantry: ${fileIndex.length} primitives indexed
${kindRows}

Search: ${searchMode}

Surface: ${config.surface}
         baseline: ${baseline.length} tools (${baseline.slice(0, 4).join(", ")}${baseline.length > 4 ? ", ..." : ""})
         activated this session: ${activated.size}
         total runtime tools: ${allTools.length}
         active: ${activeCount}, suppressed: ${allTools.length - activeCount}`;

			// Output: use console for print mode, sendMessage for TUI
			if (ctx.mode === "tui") {
				pi.sendMessage(
					{
						customType: "strudel-status",
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
