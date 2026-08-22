/**
 * Patch-Only event log — append-only JSONL, the experiment's measurement
 * substrate. Same discipline as telemetry.ts: injected directory + clock,
 * so tests never touch real state and every timestamp is deterministic.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RejectionKind } from "./schema.js";

export interface IntentReceivedEvent {
	type: "intent_received";
	ts: number;
	intent_id: string;
	agent_id: string;
	edits: number;
}

export interface IntentAppliedEvent {
	type: "intent_applied";
	ts: number;
	intent_id: string;
	agent_id: string;
	commit: string;
	branch: string;
	ms: number;
	lock_wait_ms: number;
	isolation_cost: { files_copied: 0; bytes_copied: 0 };
}

export interface IntentRejectedEvent {
	type: "intent_rejected";
	ts: number;
	intent_id: string;
	agent_id: string;
	kind: RejectionKind;
	edit_index?: number;
	detail: string;
	ms: number;
	lock_wait_ms: number;
	isolation_cost: { files_copied: 0; bytes_copied: 0 };
}

export type PatchEvent =
	| IntentReceivedEvent
	| IntentAppliedEvent
	| IntentRejectedEvent;

let eventsDir = join(homedir(), ".patchonly");

/** Swap the log directory (tests inject a tmpdir). */
export function setEventsDir(dir: string): void {
	eventsDir = dir;
}

export function resetEventsDir(): void {
	eventsDir = join(homedir(), ".patchonly");
}

let clock: () => number = () => Date.now();

export function setClock(fn: () => number): void {
	clock = fn;
}

export function resetClock(): void {
	clock = () => Date.now();
}

export function eventsPath(): string {
	return join(eventsDir, "events.jsonl");
}

export function appendEvent(event: PatchEvent): void {
	mkdirSync(eventsDir, { recursive: true });
	appendFileSync(eventsPath(), `${JSON.stringify(event)}\n`, "utf-8");
}

export function now(): number {
	return clock();
}
