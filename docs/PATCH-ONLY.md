# Patch-Only Agent Architecture — Experiment Spine

> Status: **Experimental**. This document is the spine; it exists before the
> code, per ARCHITECTURE.md law. Strudel is the **laboratory**, not the
> subject: the code here is repo-agnostic lab equipment. The subject under
> test is the worktree paradigm — per-agent mutable environments — as the
> root cause of multi-agent isolation pain.

Provenance: Grok conversation (X share `32bd7006285a4eb0a829b88b091bfab4`),
compiled from an X thread on cloud-agent friction into an experimental
protocol. Full protocol text archived in the session transcript.

## Thesis (the claim family)

**C0 (root claim).** Most isolation pain — worktrees, per-task VMs, setup
scripts, dependency thrashing — is an artifact of giving agents full mutable
environments, not an inherent requirement of parallel agent work.

Falsifying C0 removes the reason for everything below. Sub-claims:

| # | Claim | Testable at build time? |
|---|---|---|
| C1 | Agents can operate productively emitting only structured Edit Intents | Partially — loop mechanics yes; productivity = live |
| C2 | One canonical tree + central applier restores clone+branch simplicity | Partially — mechanics yes; ergonomics = live |
| C3 | Isolation overhead collapses to ~zero per additional agent | Yes — measured structurally (no copy occurs) |
| C4 | Conflicts become data, not filesystem corruption | Yes — rejection path proven |
| C5 | The edit→test→edit loop survives without local mutation | No — live only |

## Architecture

```
agent pane (pi)                      applier (this repo)
┌─────────────────────┐   UDS       ┌──────────────────────────┐
│ edit/write tools     │  JSONL      │ lock → base check →      │
│   BLOCKED by shim ───┼────────────►│ apply → verify → commit  │
│ submit_edit_intent   │             │   ↓                   ↑  │
└─────────────────────┘             │   rejection (structured) ┘  │
                                    └──────────────────────────┘
                                             │
                                      events.jsonl (metrics)
```

### Components

| Path | Role |
|---|---|
| `src/patchonly/schema.ts` | Edit Intent schema (typebox) + validation |
| `src/patchonly/apply.ts` | Pure application engine: search_replace / unified_diff / full_file, transactional |
| `src/patchonly/applier.ts` | Locking applier core over a git repo: base-check, apply, verify (`test_commands`), commit or structured reject |
| `src/patchonly/log.ts` | Append-only JSONL event log (telemetry conventions: injected dir + clock) |
| `src/patchonly/metrics.ts` | Rollups: conflict rate, test-failure rate, latency percentiles, isolation-economics counters |
| `src/patchonly/server.ts` | Unix-socket transport, newline-delimited JSON requests/responses |
| `src/patchonly/pi-extension.ts` | pi harness shim: registers `submit_edit_intent`; blocks mutating tools via `tool_call` hook with redirect guidance |
| `bin/strudel-applier.mjs` | CLI: serve a repo, submit intents, print metrics |

### Edit Intent schema (v1 — dead simple, extend only if validation demands)

```jsonc
{
  "intent_id":  "client-generated uuid",
  "agent_id":   "opaque string",
  "base_commit": "sha the agent reasoned against",
  "branch":     "optional target branch; default patch/<intent_id>",
  "edits": [{
    "file":    "relative/path",
    "type":    "search_replace" | "unified_diff" | "full_file",
    "search":  "...",   // search_replace: must match exactly once
    "replace": "...",
    "diff":    "...",   // unified_diff: standard @@ hunks w/ context
    "content": "..."    // full_file
  }],
  "test_commands": ["optional; default = project config"],
  "rationale":    "one line, lands in the commit message"
}
```

### Applier contract

1. Acquire exclusive repo lock (timeout → structured `busy` reject; never queue silently).
2. `base_commit` ≠ HEAD → structured `stale_base` reject (agent re-reasons; no merge machinery in v1).
3. Validate + apply ALL edits transactionally in memory; any failure → `conflict` reject naming file/edit index/marker. Nothing written.
4. Write tree, run `test_commands` (captured stdout/stderr, timeout).
5. Success → commit on target branch, message carries `intent_id`, `agent_id`, `rationale`. Failure → `test_failure` reject carrying output.
6. Every transition appends to `events.jsonl`.

### Structured rejection shape

`{ ok:false, kind:"conflict"|"test_failure"|"stale_base"|"busy"|"invalid", detail, edit_index?, command_output? }`

### Isolation economics (the worktree comparison)

Every applied intent logs `isolation_cost: { files_copied: 0, bytes_copied: 0, setup_ms: <lock wait only> }`. Baseline condition A (worktrees) logs the same fields measured off `git worktree add` + install. C3 lives or dies here.

## Harness restriction manifest (v1: pi)

| Harness | Method | Status |
|---|---|---|
| pi | extension factory: `registerTool(submit_edit_intent)` + `tool_call` hook returning `{block:true, reason:redirect}` for mutating tools (`edit`, `write`) | implemented here |
| codex / claude / cursor | undocumented stubs — gated on positive v1 results per protocol §7 | not attempted |

## Kill criteria (from protocol §8, verbatim intent)

- Agents significantly less effective without tight edit–test–edit loops *(live)*
- Conflict rate high even for non-overlapping changes *(live, but conflict-classification tooling ships here)*
- Harness differences make consistent restriction impossible *(pi answered at build time)*
- Applier becomes SPOF/bottleneck *(latency + lock-wait metrics ship here)*

## Validation report

### Build-time proofs (this branch, 2026-08-22)

Each row cites the test that demonstrates it. Suite: `vitest run` — 219 passing (42 patchonly + 177 pre-existing, zero regressions). Gate: `npm run check` (biome strict + `tsc --noEmit`) clean.

| Claim | Proof | Status |
|---|---|---|
| C4 (conflicts are data) | `patchonly-apply` + `patchonly-applier`: every failure returns `{kind, detail, edit_index}`; zero filesystem trace asserted via `status --porcelain` after conflict / stale-base / test-failure paths | **held at component level** |
| C3 (isolation ≈ 0) | `patchonly-applier` + metrics: applied intents log `{files_copied: 0, bytes_copied: 0}`; structurally, no copy occurs by construction | **held structurally; economics vs worktrees = live measurement** |
| C1/C2 mechanics (intent → applier → commit loop) | `patchonly-server`: mock-pi session → UDS → applier → real git repo end-to-end; commit message carries intent_id/agent_id/base | **held mechanically** |
| Harness restriction possible on pi | `patchonly-server` manifest tests: edit/write removed from active surface, blocked at `tool_call` with redirect reason, exactly one mutation door registered | **held for pi; other harnesses not attempted** |
| Applier SPOF/bottleneck risk is *measurable* | lock-wait p95 + latency percentiles in metrics; busy rejection after bounded wait; live-lock theft prevention proven (`does not rob a live lock`) | **instrumented; bottleneck verdict = live** |
| Rollback integrity | failing intents restore tree byte-exact incl. new-file deletion and branch return (`rolls back a failing intent that created a new file on a new branch`) | **held** |

Bugs found and fixed during proving (recorded because they validate the experiment's own thesis — the machinery is where friction hides):
1. Lock timeout was computed from the injected event clock — a constant test clock made `busy` unreachable. Lock contention now uses wall-clock; event timestamps stay injectable.
2. Stale-lock theft threshold was tied to the caller's wait timeout (300ms), letting an impatient caller rob a live applier mid-apply. Theft now uses its own `staleLockMs` (60s default).
3. `git checkout -- <file>` against a dirty index restores the edited content, silently un-rolling back failures. Rollback now unstages before checkout.

### Live-run gaps (UNKNOWN — only operation can answer)

- Does agent productivity survive without tight edit–test–edit loops? [UNKNOWN — C5]
- Real-world conflict rate on non-overlapping parallel tasks. [UNKNOWN]
- Worktree-vs-patch-only resource comparison under real task mixes. [UNKNOWN — condition A baseline runs not yet executed]
- Codex/Claude/Cursor restriction manifests. [UNKNOWN — gated on positive v1 results]

### Running the experiment

```sh
# terminal 1 — the applier owns the canonical tree
strudel-applier serve --repo ~/Infinity/arc --test "npm test"

# agent panes launch pi with the restriction shim:
#   PATCHONLY_SOCKET=~/.patchonly/applier.sock \
#   PATCHONLY_AGENT_ID=<pane-name> pi --extension dist/patchonly/pi-extension.js

# scoreboard
strudel-applier metrics
```
