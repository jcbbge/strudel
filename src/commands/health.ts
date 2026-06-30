/**
 * /strudel-health — connectivity and configuration verification
 *
 * Checks that config exists, roots are readable, embeddings endpoint responds.
 */

import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { expandHome } from "../pantry.js";
import { getState, STRUDEL_VERSION } from "../state.js";

export function registerHealthCommand(pi: ExtensionAPI): void {
	pi.registerCommand("strudel-health", {
		description: "Check Strudel health — config, roots, embeddings, cache",
		async handler(_args, ctx) {
			const state = getState();
			const { config, fileIndex } = state;
			const issues: string[] = [];

			// Check config file
			const configPath = join(homedir(), ".strudel", "config.json");
			let configOk = false;
			try {
				await access(configPath);
				configOk = true;
			} catch {
				issues.push("Config file not found");
			}

			// Check roots
			const rootResults: string[] = [];
			for (const root of config.roots) {
				const expanded = expandHome(root);
				try {
					const s = await stat(expanded);
					if (s.isDirectory()) {
						const count = fileIndex.filter((p) =>
							p.source.startsWith(expanded),
						).length;
						rootResults.push(`  ${root} ✓ (readable, ${count} primitives)`);
					} else {
						rootResults.push(`  ${root} ✗ (not a directory)`);
						issues.push(`Root ${root} is not a directory`);
					}
				} catch {
					rootResults.push(`  ${root} ✗ ENOENT (directory does not exist)`);
					issues.push(`Root ${root} does not exist`);
				}
			}

			// Check embeddings endpoint
			let embeddingsOk = false;
			let embeddingsStatus = "";
			if (config.embeddings?.baseUrl) {
				try {
					const controller = new AbortController();
					const timeout = setTimeout(() => controller.abort(), 5000);
					const response = await fetch(
						`${config.embeddings.baseUrl}/models`,
						{ signal: controller.signal },
					);
					clearTimeout(timeout);
					if (response.ok) {
						embeddingsOk = true;
						embeddingsStatus = `  ${config.embeddings.baseUrl} ✓ (responding)
  model: ${config.embeddings.model} ✓`;
					} else {
						embeddingsStatus = `  ${config.embeddings.baseUrl} ✗ (HTTP ${response.status})`;
						issues.push(`Embeddings endpoint returned ${response.status}`);
					}
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					if (msg.includes("abort")) {
						embeddingsStatus = `  ${config.embeddings.baseUrl} ✗ TIMEOUT`;
						issues.push("Embeddings endpoint timed out");
					} else {
						embeddingsStatus = `  ${config.embeddings.baseUrl} ✗ ECONNREFUSED`;
						issues.push("Embeddings endpoint not reachable");
					}
				}
			} else {
				embeddingsStatus = "  (not configured — using lexical search)";
			}

			// Check cache
			const cachePath = join(homedir(), ".strudel", "cache", "embeddings.json");
			let cacheStatus = "";
			try {
				const s = await stat(cachePath);
				const sizeKb = Math.round(s.size / 1024);
				cacheStatus = `  ${cachePath} ✓ (${sizeKb}KB)`;
			} catch {
				cacheStatus = `  ${cachePath} (not yet created)`;
			}

			// Overall status
			let overall: string;
			if (issues.length === 0) {
				overall = "HEALTHY";
			} else if (issues.length <= 2 && embeddingsOk) {
				overall = "DEGRADED";
			} else {
				overall = issues.length > 0 ? "DEGRADED" : "HEALTHY";
			}

			const output = `Health Check — Strudel v${STRUDEL_VERSION}
══════════════════════════════════════════════════════

Config file:
  ${configPath} ${configOk ? "✓ (parsed successfully)" : "✗ (not found)"}

Pantry roots:
${rootResults.join("\n")}

Embeddings endpoint:
${embeddingsStatus}
  fallback: lexical search (L0)

Cache:
${cacheStatus}

Overall: ${overall}${issues.length > 0 ? `\n  - ${issues.join("\n  - ")}` : ""}`;

			if (ctx.mode === "tui") {
				pi.sendMessage(
					{
						customType: "strudel-health",
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
