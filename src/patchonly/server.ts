/**
 * Transport — a thin Unix-socket server speaking newline-delimited JSON.
 * One applier, many agent panes. The socket is the only door into the
 * canonical tree.
 *
 * Ops:
 *   {op:"submit",  intent:{...}} → ApplyOutcome
 *   {op:"status"}                → {ok:true, repo, branch, head}
 *   {op:"metrics"}               → PatchMetrics
 */

import { unlinkSync } from "node:fs";
import type { Server, Socket } from "node:net";
import { createServer, connect as netConnect } from "node:net";
import type { PatchApplier } from "./applier.js";
import { appendEvent, eventsPath, now } from "./log.js";
import { type PatchMetrics, loadEvents, summarize } from "./metrics.js";
import type { ApplyOutcome } from "./schema.js";

export interface PatchRequest {
	op: "submit" | "status" | "metrics" | "freshness";
	intent?: unknown;
	/** freshness op: the sha the caller reasoned against. */
	base_commit?: string;
	agent_id?: string;
}

export function serve(
	applier: PatchApplier,
	socketPath: string,
): Promise<Server> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => {
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString("utf-8");
				for (;;) {
					const nl = buffer.indexOf("\n");
					if (nl === -1) break;
					const line = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					if (line.trim().length === 0) continue;
					handleLine(applier, line)
						.then((response) => socket.write(`${JSON.stringify(response)}\n`))
						.catch((e) =>
							socket.write(
								`${JSON.stringify({ ok: false, kind: "invalid", detail: (e as Error).message })}\n`,
							),
						);
				}
			});
		});
		server.on("error", reject);
		// Stale socket from a dead daemon is stolen, never queued behind.
		try {
			unlinkSync(socketPath);
		} catch {
			// nothing to steal
		}
		server.listen(socketPath, () => resolve(server));
	});
}

async function handleLine(
	applier: PatchApplier,
	line: string,
): Promise<unknown> {
	let req: PatchRequest;
	try {
		req = JSON.parse(line) as PatchRequest;
	} catch {
		return { ok: false, kind: "invalid", detail: "request is not valid JSON" };
	}
	switch (req.op) {
		case "submit":
			return applier.applyIntent(req.intent);
		case "status":
			return { ok: true, ...(await applier.status()) };
		case "freshness": {
			// Read-only cache-coherence probe: one socket call instead of one
			// wasted reasoning pass. No lock, no intent, no event unless stale.
			const base = typeof req.base_commit === "string" ? req.base_commit : "";
			if (base.length === 0)
				return {
					ok: false,
					kind: "invalid",
					detail: "freshness requires base_commit",
				};
			const state = await applier.status();
			const fresh = state.head?.startsWith(base) === true;
			if (!fresh) {
				appendEvent({
					type: "stale_detected",
					ts: now(),
					agent_id: req.agent_id ?? "unknown",
					base_commit: base,
					head: state.head ?? "none",
				});
			}
			return { ok: true, fresh, head: state.head, branch: state.branch };
		}
		case "metrics": {
			const metrics: PatchMetrics = summarize(loadEvents(eventsPath()));
			return { ok: true, metrics };
		}
		default:
			return {
				ok: false,
				kind: "invalid",
				detail: `unknown op: ${(req as { op?: string }).op}`,
			};
	}
}

/** Client helper — one request, one response, connection closed. */
export async function request(
	socketPath: string,
	req: PatchRequest,
): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket: Socket = netConnect(socketPath, () => {
			socket.write(`${JSON.stringify(req)}\n`);
		});
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf-8");
			const nl = buffer.indexOf("\n");
			if (nl !== -1) {
				try {
					resolve(JSON.parse(buffer.slice(0, nl)));
				} catch (e) {
					reject(e);
				}
				socket.end();
			}
		});
		socket.on("error", reject);
	});
}

export async function submitIntent(
	socketPath: string,
	intent: unknown,
): Promise<ApplyOutcome> {
	return request(socketPath, { op: "submit", intent }) as Promise<ApplyOutcome>;
}
