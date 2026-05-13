#!/usr/bin/env node
/**
 * Strudel CLI.
 *
 * A thin wrapper around the Pi coding agent that always preloads the
 * `@strudel/bakery` extension. Mirrors `packages/coding-agent/src/cli.ts` so
 * that running `strudel` is equivalent to `pi -e <path-to-bakery>` with the
 * process branded as `strudel`.
 *
 * Install for local dog-fooding:
 *   npm run build && cd packages/strudel && npm link
 *
 * After that, every subsequent `npm run build` at the repo root refreshes the
 * binary in place — no re-link required.
 */

// MUST be the first import — sets PI_APP_NAME / PI_APP_TITLE / process.title
// before the coding-agent module graph evaluates.
import "./brand.js";
import { createRequire } from "node:module";
import path from "node:path";
import { main } from "@earendil-works/pi-coding-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const require = createRequire(import.meta.url);

process.env.PI_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

// See coding-agent/src/cli.ts — disable undici timeouts so long local-LLM
// stalls don't abort SSE streams; provider SDKs enforce their own deadlines.
setGlobalDispatcher(new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }));

const bakeryPackageJson = require.resolve("@strudel/bakery/package.json");
const bakeryDir = path.dirname(bakeryPackageJson);

const userArgs = process.argv.slice(2);
const args = injectBakeryExtension(userArgs, bakeryDir);

await main(args);

/** Add `-e <bakeryDir>` once, unless the user already pointed at our bakery. */
function injectBakeryExtension(args: string[], bakeryDir: string): string[] {
	const bakeryAbs = path.resolve(bakeryDir);
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if ((a === "-e" || a === "--extension") && i + 1 < args.length) {
			if (path.resolve(args[i + 1]) === bakeryAbs) return args;
		}
	}
	return ["-e", bakeryDir, ...args];
}
