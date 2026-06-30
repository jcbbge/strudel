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

export interface StrudelConfig {
	roots: string[];
	embeddings?: EmbeddingConfig;
	surface: SurfaceMode;
	baseline?: string[];
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
