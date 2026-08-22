#!/usr/bin/env node
/**
 * strudel-applier — Patch-Only lab equipment CLI.
 *
 *   strudel-applier serve --repo <path> [--socket <path>] [--test "<cmd>" ...]
 *   strudel-applier submit --socket <path> --file <intent.json>
 *   strudel-applier status  --socket <path>
 *   strudel-applier metrics [--socket <path>]
 *
 * The applier owns exactly one canonical tree. Agents never receive write
 * credentials to it — only this socket.
 */

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const { PatchApplier } = await import(`${here}/dist/patchonly/applier.js`);
const { serve, request } = await import(`${here}/dist/patchonly/server.js`);
const { loadEvents, summarize } = await import(
	`${here}/dist/patchonly/metrics.js`
);
const { eventsPath } = await import(`${here}/dist/patchonly/log.js`);

function arg(name, fallback) {
	const i = process.argv.indexOf(name);
	return i !== -1 && process.argv[i + 1] !== undefined
		? process.argv[i + 1]
		: fallback;
}

const [op] = process.argv.slice(2);

if (op === "serve") {
	const repo = arg("--repo", process.cwd());
	const socket = arg("--socket", join(homedir(), ".patchonly", "applier.sock"));
	const tests = [];
	const t = process.argv.indexOf("--test");
	if (t !== -1)
		for (
			let i = t + 1;
			i < process.argv.length && !process.argv[i].startsWith("--");
			i++
		)
			tests.push(process.argv[i]);
	mkdirSync(join(homedir(), ".patchonly"), { recursive: true });
	const applier = new PatchApplier({
		repoPath: repo,
		defaultTestCommands: tests,
	});
	await serve(applier, socket);
	console.log(
		`applier listening on ${socket} (repo: ${repo}, default tests: ${tests.length || "none"})`,
	);
	// Serve until the socket file is removed or the process is killed.
	setInterval(() => {}, 60_000);
} else if (op === "submit" || op === "status" || op === "metrics") {
	const socket = arg("--socket", join(homedir(), ".patchonly", "applier.sock"));
	if (op === "submit") {
		const file = arg("--file");
		if (!file) {
			console.error("submit requires --file <intent.json>");
			process.exit(2);
		}
		const { readFileSync } = await import("node:fs");
		const intent = JSON.parse(readFileSync(file, "utf-8"));
		const response = await request(socket, { op: "submit", intent });
		console.log(JSON.stringify(response, null, 2));
		process.exit(response.ok === true ? 0 : 1);
	}
	if (op === "status") {
		console.log(
			JSON.stringify(await request(socket, { op: "status" }), null, 2),
		);
	} else {
		try {
			console.log(JSON.stringify(summarize(loadEvents(eventsPath())), null, 2));
		} catch {
			console.log(
				JSON.stringify(await request(socket, { op: "metrics" }), null, 2),
			);
		}
	}
} else {
	console.error(`usage: strudel-applier serve|submit|status|metrics [options]

  serve   --repo <path> [--socket <path>] [--test "<cmd>"]
  submit  --socket <path> --file <intent.json>
  status  --socket <path>
  metrics [--socket <path>]`);
	process.exit(op === undefined ? 0 : 2);
}
