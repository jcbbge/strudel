/**
 * forageDirectory — Phase ① orchestrator.
 *
 * Walks a root path with a configurable set of foragers (default: every
 * built-in adapter), stashes every yielded RawCandidate into the Cupboard,
 * and returns a per-paradigm summary. Nothing here is LLM-bound; it's safe
 * to run on a fresh machine without a model server.
 */

import path from "node:path";
import type { Cupboard, StashSummary } from "./cupboard.js";
import type { Forager, ForagerContext, SourceParadigm } from "./forager.js";
import { PiExtensionForager } from "./foragers/pi-extension.js";

export interface ForageOptions {
	/** Root directory to scan. Required — no implicit default. */
	root: string;
	/** Foragers to run. Default: all built-in adapters. */
	foragers?: Forager[];
	/** Optional logger for progress / problems. */
	log?: (message: string) => void;
}

export interface ForageResult extends StashSummary {
	root: string;
	/** Paradigms that ran (after `match()` filtering). */
	ran: SourceParadigm[];
	/** Per-forager errors that did not abort the run. */
	errors: Array<{ paradigm: SourceParadigm; message: string }>;
}

/** Default foragers shipped with the bakery. */
export function defaultForagers(): Forager[] {
	return [new PiExtensionForager()];
}

export async function forageDirectory(cupboard: Cupboard, options: ForageOptions): Promise<ForageResult> {
	const root = path.resolve(options.root);
	const log = options.log ?? (() => {});
	const foragers = options.foragers ?? defaultForagers();

	const result: ForageResult = {
		root,
		ran: [],
		inserted: 0,
		updated: 0,
		by_paradigm: {},
		errors: [],
	};

	const ctx: ForagerContext = { root, log };

	for (const forager of foragers) {
		try {
			if (forager.match && !(await forager.match(ctx))) {
				log(`forage: skip ${forager.paradigm} (match() returned false)`);
				continue;
			}
			result.ran.push(forager.paradigm);
			for await (const candidate of forager.forage(ctx)) {
				try {
					const { inserted } = await cupboard.stash(candidate);
					if (inserted) result.inserted += 1;
					else result.updated += 1;
					result.by_paradigm[candidate.source_paradigm] = (result.by_paradigm[candidate.source_paradigm] ?? 0) + 1;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					result.errors.push({ paradigm: forager.paradigm, message: `stash failed: ${message}` });
					log(`forage: stash failed for ${candidate.source_path}: ${message}`);
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result.errors.push({ paradigm: forager.paradigm, message });
			log(`forage: ${forager.paradigm} aborted: ${message}`);
		}
	}

	return result;
}
