/**
 * Config loading — ~/.strudel/config.json by default, or the file named by
 * the STRUDEL_CONFIG_PATH env var (the hook that lets a harness swap in a
 * different presentation genome without touching the home directory).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EmbeddingConfig } from "./embeddings.js";
import type { PresentationConfig, StrudelConfig } from "./state.js";
import type { SurfaceMode } from "./surface.js";

export const DEFAULT_ROOTS = ["~/.pi/agent", "~/.strudel"];

/** The config file path: STRUDEL_CONFIG_PATH wins, else ~/.strudel/config.json. */
export function configPath(): string {
	const env = process.env.STRUDEL_CONFIG_PATH;
	if (env && env.length > 0) return env;
	return join(homedir(), ".strudel", "config.json");
}

export async function loadConfig(): Promise<StrudelConfig> {
	const cfgPath = configPath();
	try {
		const parsed = JSON.parse(await readFile(cfgPath, "utf-8")) as {
			pantry?: { roots?: string[] };
			embeddings?: EmbeddingConfig;
			surface?: SurfaceMode;
			baseline?: string[];
			presentation?: PresentationConfig;
			telemetry?: boolean;
		};
		const roots = parsed.pantry?.roots;
		return {
			roots: Array.isArray(roots) && roots.length > 0 ? roots : DEFAULT_ROOTS,
			embeddings: parsed.embeddings,
			surface: parsed.surface === "strict" ? "strict" : "pragmatic",
			baseline: parsed.baseline,
			presentation: parsed.presentation,
			telemetry: parsed.telemetry,
		};
	} catch {
		return { roots: DEFAULT_ROOTS, surface: "pragmatic" };
	}
}
