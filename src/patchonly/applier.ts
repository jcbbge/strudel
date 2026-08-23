/**
 * The Applier — the only process in the world allowed to mutate the
 * canonical working tree (docs/PATCH-ONLY.md §Contract).
 *
 * Sequence per intent:
 *   validate → lock → dirty-tree guard → base check → branch setup →
 *   read → apply (transactional, in memory) → write → verify (tests) →
 *   commit | structured reject → restore → unlock
 *
 * Every rejection is data. The canonical tree is returned to its pre-intent
 * state on every failure path.
 */

import { execFile } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { applyEdits } from "./apply.js";
import { appendEvent, now } from "./log.js";
import {
	type ApplyOutcome,
	type EditIntent,
	type Rejection,
	validateIntent,
} from "./schema.js";

const execFileP = promisify(execFile);

export interface ApplierOptions {
	repoPath: string;
	/** Commands run when an intent supplies no test_commands. */
	defaultTestCommands?: string[];
	testTimeoutMs?: number;
	lockTimeoutMs?: number;
	/** Injected for tests; defaults to <repo>/.git/patchonly. */
	stateDir?: string;
	gitBin?: string;
	/**
	 * Age after which a held lock is presumed dead and stolen. Deliberately
	 * independent of lockTimeoutMs: a legitimate apply can hold the lock far
	 * longer than a caller is willing to wait, and must not be robbed.
	 */
	staleLockMs?: number;
}

export class PatchApplier {
	private readonly repo: string;
	private readonly defaultTestCommands: string[];
	private readonly testTimeoutMs: number;
	private readonly lockTimeoutMs: number;
	private readonly staleLockMs: number;
	private readonly stateDir: string;
	private readonly gitBin: string;

	constructor(options: ApplierOptions) {
		this.repo = options.repoPath;
		this.defaultTestCommands = options.defaultTestCommands ?? [];
		this.testTimeoutMs = options.testTimeoutMs ?? 120_000;
		this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
		this.staleLockMs = options.staleLockMs ?? 60_000;
		this.stateDir = options.stateDir ?? join(this.repo, ".git", "patchonly");
		this.gitBin = options.gitBin ?? "git";
	}

	// --- git helpers ---------------------------------------------------------

	private async git(args: string[], timeoutMs = 30_000): Promise<string> {
		const { stdout } = await execFileP(this.gitBin, args, {
			cwd: this.repo,
			timeout: timeoutMs,
			maxBuffer: 16 * 1024 * 1024,
		});
		return stdout.trim();
	}

	private async head(): Promise<string | null> {
		try {
			return await this.git(["rev-parse", "HEAD"]);
		} catch {
			return null; // repo with no commits yet
		}
	}

	private async currentBranch(): Promise<string> {
		try {
			const name = await this.git(["rev-parse", "--abbrev-ref", "HEAD"]);
			return name === "HEAD" ? "(detached)" : name;
		} catch {
			return "(unknown)";
		}
	}

	private async isDirty(): Promise<boolean> {
		const status = await this.git(["status", "--porcelain"]);
		return status.length > 0;
	}

	// --- lock ----------------------------------------------------------------

	private lockPath(): string {
		return join(this.stateDir, "lock");
	}

	/**
	 * Exclusive lock via O_EXCL create. Stale locks (older than 2× the
	 * timeout — a dead applier) are stolen. Waiting is bounded: past
	 * lockTimeoutMs we reject with `busy` rather than queue silently.
	 */
	private async acquireLock(): Promise<number> {
		mkdirSync(this.stateDir, { recursive: true });
		const path = this.lockPath();
		// Wall-clock on purpose: the injected event clock is for deterministic
		// timestamps, but a lock timeout that never elapses (constant clock)
		// would turn `busy` into an unbounded wait. Real time governs contention.
		const start = Date.now();
		for (;;) {
			try {
				const fd = openSync(path, "wx");
				writeSync(
					fd,
					JSON.stringify({ pid: process.pid, acquired_at: Date.now() }),
				);
				closeSync(fd);
				return Date.now() - start;
			} catch {
				try {
					const age = Date.now() - statSync(path).mtimeMs;
					if (age > this.staleLockMs) {
						unlinkSync(path); // steal stale lock
						continue;
					}
				} catch {
					continue; // vanished; retry
				}
				if (Date.now() - start > this.lockTimeoutMs)
					throw new BusyError(Date.now() - start);
				await new Promise((r) => setTimeout(r, 25));
			}
		}
	}

	private releaseLock(): void {
		try {
			unlinkSync(this.lockPath());
		} catch {
			// already gone
		}
	}

	// --- status --------------------------------------------------------------

	/** Read-only state for the `status` op — never touches the event log. */
	async status(): Promise<{
		repo: string;
		branch: string;
		head: string | null;
		dirty: boolean;
	}> {
		return {
			repo: this.repo,
			branch: await this.currentBranch(),
			head: await this.head(),
			dirty: existsSync(join(this.repo, ".git")) ? await this.isDirty() : false,
		};
	}

	// --- apply ---------------------------------------------------------------

	/**
	 * The single mutation entry point. Never throws for protocol-level
	 * outcomes — those come back as structured rejections.
	 */
	async applyIntent(raw: unknown): Promise<ApplyOutcome> {
		const t0 = now();
		const invalid = validateIntent(raw);
		if (invalid !== null)
			return this.reject(
				raw as { intent_id?: string; agent_id?: string } | null,
				{ ok: false, kind: "invalid", detail: invalid },
				t0,
				0,
			);
		const intent = raw as EditIntent;

		let lockWaitMs = 0;
		try {
			lockWaitMs = await this.acquireLock();
		} catch (e) {
			if (e instanceof BusyError) {
				return this.reject(
					intent,
					{
						ok: false,
						kind: "busy",
						detail: `applier lock held; waited ${e.waitedMs}ms`,
					},
					t0,
					e.waitedMs,
				);
			}
			throw e;
		}

		try {
			return await this.applyLocked(intent, t0, lockWaitMs);
		} finally {
			this.releaseLock();
		}
	}

	private async applyLocked(
		intent: EditIntent,
		t0: number,
		lockWaitMs: number,
	): Promise<ApplyOutcome> {
		this.logReceived(intent);

		// Invariant: the canonical tree is clean — mutations enter only via intents.
		if (await this.isDirty()) {
			return this.reject(
				intent,
				{
					ok: false,
					kind: "dirty_tree",
					detail:
						"canonical tree has uncommitted changes; refusing to apply on top",
				},
				t0,
				lockWaitMs,
			);
		}

		// Partition guard: briefs say "touch only your partition"; here that is
		// enforced by a program instead of noticed by a coordinator. Matching
		// rule (v1, dead simple): an entry matches the file exactly, or matches
		// it as a directory prefix when the entry ends with "/".
		if (intent.partition !== undefined) {
			const partition: readonly string[] = intent.partition;
			const inPartition = (file: string): boolean =>
				partition.some((entry) => {
					const prefix = entry.endsWith("/") ? entry : `${entry}/`;
					return file === entry || file.startsWith(prefix);
				});
			const violator = intent.edits.find((e) => !inPartition(e.file));
			if (violator !== undefined) {
				return this.reject(
					intent,
					{
						ok: false,
						kind: "partition_violation",
						detail: `edit touches ${violator.file}, outside the declared partition [${intent.partition.join(", ")}]`,
					},
					t0,
					lockWaitMs,
				);
			}
		}

		// Stale-base guard: the agent reasons against a snapshot; if the tree
		// moved since, the intent is re-reasoned, never merged.
		const head = await this.head();
		if (head === null) {
			return this.reject(
				intent,
				{
					ok: false,
					kind: "stale_base",
					detail: "repository has no commits; commit a baseline first",
				},
				t0,
				lockWaitMs,
			);
		}
		if (!head.startsWith(intent.base_commit)) {
			return this.reject(
				intent,
				{
					ok: false,
					kind: "stale_base",
					detail: `base_commit ${intent.base_commit} is not HEAD (${head.slice(0, 12)}); re-reason against current tree`,
				},
				t0,
				lockWaitMs,
			);
		}

		const originalBranch = await this.currentBranch();
		const targetBranch = intent.branch ?? originalBranch;

		// Read the touched files, apply everything in memory first.
		const contents = new Map<string, string>();
		const existedBefore = new Map<string, boolean>();
		for (const edit of intent.edits) {
			const abs = join(this.repo, edit.file);
			const exists = existsSync(abs);
			existedBefore.set(edit.file, exists);
			if (exists) contents.set(edit.file, readFileSync(abs, "utf-8"));
		}
		const applied = applyEdits((path) => contents.get(path), intent.edits);
		if (!applied.ok) {
			return this.reject(
				intent,
				{
					ok: false,
					kind: "conflict",
					detail: applied.detail,
					edit_index: applied.edit_index,
				},
				t0,
				lockWaitMs,
			);
		}

		// Branch setup (after validation — never switch for an intent that will fail).
		const targetBranchName =
			typeof intent.branch === "string" ? intent.branch : undefined;
		const switched =
			targetBranchName !== undefined && targetBranchName !== originalBranch;
		if (targetBranchName !== undefined && switched) {
			await this.git(["checkout", "-q", "-B", targetBranchName]);
		}

		// Write + stage.
		try {
			for (const [file, content] of applied.files) {
				const abs = join(this.repo, file);
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, content, "utf-8");
			}
			await this.git(["add", "--", ...applied.files.keys()]);
		} catch (e) {
			await this.rollback(
				applied.files,
				existedBefore,
				originalBranch,
				switched,
			);
			return this.reject(
				intent,
				{
					ok: false,
					kind: "conflict",
					detail: `failed to write edits: ${(e as Error).message}`,
				},
				t0,
				lockWaitMs,
			);
		}

		// Verify: run the intent's tests (or the project defaults) with output captured.
		const commands = intent.test_commands ?? this.defaultTestCommands;
		if (commands.length > 0) {
			const outputs: NonNullable<Rejection["command_output"]> = [];
			for (const command of commands) {
				const output = await this.runCommand(command);
				outputs.push(output);
				if (output.exit_code !== 0) {
					await this.rollback(
						applied.files,
						existedBefore,
						originalBranch,
						switched,
					);
					return this.reject(
						intent,
						{
							ok: false,
							kind: "test_failure",
							detail: `verification failed: "${command}" exited ${output.exit_code}`,
							command_output: outputs,
						},
						t0,
						lockWaitMs,
					);
				}
			}
		}

		// No-op detection: an intent that stages zero delta is information,
		// not a conflict — tell the agent its proposal changes nothing.
		const stagedEmpty = await this.git(["diff", "--cached", "--quiet"]).then(
			() => true,
			(e) => {
				if ((e as { code?: number }).code === 1) return false; // 1 = delta exists
				throw e;
			},
		);
		if (stagedEmpty) {
			await this.rollback(
				applied.files,
				existedBefore,
				originalBranch,
				switched,
			);
			return this.reject(
				intent,
				{
					ok: false,
					kind: "no_change",
					detail: "proposal produces zero delta against HEAD",
				},
				t0,
				lockWaitMs,
			);
		}

		// Commit.
		const message =
			`patch(${intent.intent_id}) by ${intent.agent_id}: ${intent.rationale ?? "no rationale given"}\n\n` +
			`Edit-Intent: ${intent.intent_id}\nAgent: ${intent.agent_id}\nBase: ${intent.base_commit}`;
		try {
			await this.git([
				"-c",
				"user.name=patch-applier",
				"-c",
				"user.email=applier@patchonly.local",
				"commit",
				"-q",
				"-m",
				message,
			]);
		} catch (e) {
			await this.rollback(
				applied.files,
				existedBefore,
				originalBranch,
				switched,
			);
			return this.reject(
				intent,
				{
					ok: false,
					kind: "conflict",
					detail: `git commit failed: ${(e as Error).message}`,
				},
				t0,
				lockWaitMs,
			);
		}
		const commit = await this.head();

		// Return the canonical tree to its default branch; the work lives on targetBranch.
		if (switched && originalBranch !== "(detached)") {
			await this.git(["checkout", "-q", originalBranch]);
		}

		const ms = now() - t0;
		appendEvent({
			type: "intent_applied",
			ts: now(),
			intent_id: intent.intent_id,
			agent_id: intent.agent_id,
			commit: commit ?? "unknown",
			branch: targetBranch,
			ms,
			lock_wait_ms: lockWaitMs,
			isolation_cost: { files_copied: 0, bytes_copied: 0 },
		});
		return {
			ok: true,
			intent_id: intent.intent_id,
			agent_id: intent.agent_id,
			branch: targetBranch,
			commit: commit ?? "unknown",
			ms,
			lock_wait_ms: lockWaitMs,
			isolation_cost: { files_copied: 0, bytes_copied: 0 },
		};
	}

	private async runCommand(command: string): Promise<{
		command: string;
		exit_code: number;
		stdout: string;
		stderr: string;
	}> {
		try {
			const { stdout, stderr } = await execFileP("/bin/sh", ["-c", command], {
				cwd: this.repo,
				timeout: this.testTimeoutMs,
				maxBuffer: 16 * 1024 * 1024,
			});
			return {
				command,
				exit_code: 0,
				stdout: truncate(stdout),
				stderr: truncate(stderr),
			};
		} catch (e) {
			const err = e as {
				code?: number;
				stdout?: string;
				stderr?: string;
				killed?: boolean;
			};
			return {
				command,
				exit_code: err.code ?? (err.killed ? 124 : 1),
				stdout: truncate(err.stdout ?? ""),
				stderr: truncate(err.stderr ?? (err.killed ? "timed out" : "")),
			};
		}
	}

	/**
	 * Put the tree back exactly as the intent found it: unstage first (a
	 * `checkout -- file` against a dirty index would restore the edited
	 * content - the bug this method exists to prevent), then restore or
	 * delete, then return to the original branch if one was created.
	 */
	private async rollback(
		files: Map<string, string>,
		existedBefore: Map<string, boolean>,
		originalBranch?: string,
		switchedBranch = false,
	): Promise<void> {
		const touched = [...existedBefore.keys()];
		if (touched.length > 0) {
			await this.git(["reset", "-q", "--", ...touched]).catch(() => {});
		}
		for (const [file, existed] of existedBefore) {
			const abs = join(this.repo, file);
			if (!existed) {
				rmSync(abs, { force: true });
			} else {
				await this.git(["checkout", "-q", "--", file]).catch(() => {
					writeFileSync(abs, files.get(file) ?? "", "utf-8");
				});
			}
		}
		if (switchedBranch && originalBranch && originalBranch !== "(detached)") {
			await this.git(["checkout", "-q", originalBranch]).catch(() => {});
		}
	}

	private reject(
		intent: { intent_id?: string; agent_id?: string } | null,
		rejection: Rejection,
		t0: number,
		lockWaitMs: number,
	): ApplyOutcome {
		appendEvent({
			type: "intent_rejected",
			ts: now(),
			intent_id: intent?.intent_id ?? "unknown",
			agent_id: intent?.agent_id ?? "unknown",
			kind: rejection.kind,
			edit_index: rejection.edit_index,
			detail: rejection.detail,
			ms: now() - t0,
			lock_wait_ms: lockWaitMs,
			isolation_cost: { files_copied: 0, bytes_copied: 0 },
		});
		return rejection;
	}

	private logReceived(intent: EditIntent): void {
		appendEvent({
			type: "intent_received",
			ts: now(),
			intent_id: intent.intent_id,
			agent_id: intent.agent_id,
			edits: intent.edits.length,
		});
	}
}

class BusyError extends Error {
	waitedMs: number;
	constructor(waitedMs: number) {
		super(`lock busy after ${waitedMs}ms`);
		this.waitedMs = waitedMs;
	}
}

function truncate(s: string, max = 4000): string {
	return s.length > max
		? `${s.slice(0, max)}\n...[truncated ${s.length - max} bytes]`
		: s;
}
