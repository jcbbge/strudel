/**
 * Shared state for Strudel extension.
 *
 * Commands and event handlers need access to the same state. This module
 * provides a holder that gets initialized once at extension load time,
 * then read by commands.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EmbeddingConfig } from "./embeddings.js";
import type { Primitive } from "./pantry.js";
import type { SurfaceMode } from "./surface.js";

export const STRUDEL_VERSION = "0.1.0";

/** Per-tool presentation overrides — how a registered tool describes itself. */
export interface ToolPresentation {
	description?: string;
	promptSnippet?: string;
}

/**
 * The presentation genome: config-loadable overrides for how strudel presents
 * itself to the model (tool descriptions/snippets + the pantry inventory line).
 * `inventoryLine: false` suppresses the line; a string replaces the default.
 */
export interface PresentationConfig {
	tools?: Record<string, ToolPresentation>;
	inventoryLine?: string | false;
}

export interface StrudelConfig {
	roots: string[];
	embeddings?: EmbeddingConfig;
	surface: SurfaceMode;
	baseline?: string[];
	presentation?: PresentationConfig;
	/** Telemetry kill switch (spec §5): false disables all writes and forces λ=0. */
	telemetry?: boolean;
}

export interface StrudelState {
	config: StrudelConfig;
	fileIndex: Primitive[];
	activated: Set<string>;
	baseline: string[];
	pi: ExtensionAPI;
}

/**
 * Module-level state holder. Initialized by the extension entry point,
 * read by commands. Undefined until extension loads.
 */
let state: StrudelState | undefined;

export function initState(s: StrudelState): void {
	state = s;
}

export function getState(): StrudelState {
	if (!state) {
		throw new Error("Strudel state not initialized — extension not loaded?");
	}
	return state;
}

export function hasState(): boolean {
	return state !== undefined;
}
