# PRD: Auto-Research — Metacognitive Primitive Evaluation Layer for Strudel

**Version:** 0.1 — Draft  
**Date:** 2026-05-13  
**Status:** **Deferred** — depends on Layer 1 of the Oven, the bake-history viewer, and the fork engine. Revisit after ~200 real bakes have accumulated. See §0.0 below for the structural commitments we extracted from this PRD that must be honored in the substrate *now* so we do not paint ourselves into a corner.  
**Owner:** jrg  
**Audience:** Any agent or human builder with zero prior context on this work.

---

## 0.0 Substrate Commitments Extracted From This PRD (Honor Now)

This PRD is deferred, but five structural commitments were extracted from it during the phoropter review (luck / criticality / prd / processing-sigils / mapping-adjacent-possibilities). These must be reflected in the substrate from day one so a future implementation of the auto-research loop is additive, not a refactor.

1. **Append-only bake history.** `BakeHistoryEntry[]` on `IngredientManifest` is never mutated in place. New events append; old events are immutable. The schema already supports this — confirm and document the discipline in `packages/bakery/README.md`.

2. **Eval-functions-as-ingredients (kind: `tool`).** Whenever we eventually need to compare anything (parallel bakes, alternative primitives, recipe outcomes), the eval must itself be a registered ingredient — swappable, versioned, auditable, and forbidden from being modified by the loop that uses it. Default eval is one ingredient; specialized evals can coexist as siblings. The locked-judge pattern is non-negotiable; without it the system optimizes against itself.

3. **Apple Watch ring discipline for background processes.** Any background loop in the bakery (auto-research now, recipe planner later, anything else) must be: (a) ambient, never interruptive; (b) zero-latency on the user-facing hot path; (c) feature-flag killable with zero overhead when disabled; (d) surfacing only on threshold events, never running narration. This is documented as a substrate-level commitment in the bakery README.

4. **Chess-engine constraint pattern as a north star.** Future features that touch self-modification must articulate explicitly: what is the constraint that makes this trustworthy? What can the loop NOT touch? The constraint is the product. A loop with no forbidden zone is unauditable.

5. **`stage` field on `IngredientManifest`.** Add `stage: "cupboard" | "draft" | "active" | "deprecated"` to the manifest in the next substrate session. The Cupboard is the staging shelf — captured intent that is in the kitchen but not yet on the recommended-ingredients shelf. The natural primitive evolution pipeline (`phrase → command → skill → mcp/tool → subagent`) is then a sequence of `pantry promote` calls that change `kind` and `stage` together as the item matures. Costs ~10 lines now; retrofitting it later means migrating every existing ingredient.

### Explicitly excised from any future implementation

- **Auto-fork on low confidence.** Violates the flour-sifter principle (parallel mode is a tool the baker reaches for, never imposed). Fork mode stays user-initiated and agent-initiated only.
- **Skip hypothesis on failure (FR-6).** Backwards. Failures are the most valuable signal for "what would have worked instead." When this PRD is revisited, this clause must be flipped: *especially* generate hypotheses on failure.
- **Insight as a 10th ingredient kind.** Violates the nine. When implemented, insights live as annotations on bake-history entries (extending `BakeHistoryEntry` with optional `comparisons: [...]` rather than adding a new kind). The nine are the spine. We do not stray from them.

---

## 0. Mandatory Reading Before Building

This document is a living blueprint. Read it completely before touching any code.

### What you must know about the codebase before starting

Strudel is a fork of [Pi](https://github.com/earendil-works/pi-mono) — a TypeScript-first coding agent harness. It strips Pi's default built-in tools and wraps it in a **bakery metaphor**: the LLM is the Master Baker, capabilities are ingredients in a Pantry (SurrealDB-backed), and execution runs through the Oven.

The repo is a monorepo at `~/strudel/` with these relevant packages:

| Package | Path | Role |
|---|---|---|
| `@earendil-works/pi-agent-core` | `packages/agent/` | Agent loop, event streaming, tool execution |
| `@earendil-works/pi-ai` | `packages/ai/` (upstream Pi) | Multi-provider LLM layer |
| `@strudel/bakery` | `packages/bakery/` | Pantry, ingredient schema, SurrealDB storage, hybrid search |
| `@earendil-works/pi-coding-agent` | `packages/coding-agent/` | The harness shell — TUI, sessions, config |

The nine ingredient kinds (primitives): `directive`, `command`, `skill`, `hook`, `tool`, `mcp`, `plugin`, `agent`, `subagent`.

**Everything in this PRD is TypeScript/Node. No Python. No Python tooling. No Python references anywhere.**

---

## 1. Vision & Philosophy

### 1.1 The Core Idea

Auto-Research is a metacognitive layer that runs **silently inside Strudel sessions**. It observes every primitive invocation, evaluates whether the right primitive was chosen, explores alternatives autonomously, and surfaces structured insight — without interrupting the user or requiring their involvement during the loop.

It borrows directly from the `auto-research` paradigm by Arunjit Kapathi: constrained self-optimization through iterated experiments, where only improvements are kept and failures are discarded. The restaurant inventory and chess engine examples from the source video are the mental model — not the implementation.

### 1.2 Why This Exists

Strudel is designed to get better over time. The Pantry stores ingredients. Bake history records outcomes. But right now, none of that history is being *reasoned about*. The baker bakes, records a note, and moves on. Auto-Research closes that loop: it turns bake history into a self-improving feedback signal.

The specific problem it solves: **the baker currently has no way to know if it used the best primitive for a given task.** It picked a skill. Did the right skill? Was there a better command? Would a subagent have been faster? No one is asking those questions. Auto-Research asks them — in the background, automatically, without the user noticing.

### 1.3 The Non-Negotiable Design Constraint

**This feature must be invisible during normal operation.** The user should not know it is running. No banners, no progress indicators, no intermediate output, no interruptions. It surfaces only when it has produced a result worth a decision — a branch comparison, a recommendation, a scored alternative. Even then, surfacing is opt-in or deferred.

This is the Apple Watch ring model applied to agent cognition: the loop closes silently, the feedback is ambient, the user feels the improvement without seeing the machinery.

### 1.4 Relationship to the Broader Harness

Auto-Research is an **add-on feature**. It does not require changes to the core agent loop, the Pantry, or the Oven. It hooks into existing telemetry (bake history, `UsageStats`) and adds a new ingredient kind behavior on top. Strudel's current roadmap (Oven → Code Mode → Recipe Planner) continues uninterrupted. Auto-Research is parallel work, not a course change.

---

## 2. Core Concepts

### 2.1 The Evaluation Loop (Auto-Research Cycle)

```
Observation → Hypothesis → Experiment → Score → Keep/Discard → Persist Insight
```

Each cycle is triggered by a completed bake. The loop:

1. **Observe**: A primitive was invoked. Capture the invocation context — task description, input args, outcome, duration, notes.
2. **Hypothesize**: Given this task, were there other plausible primitives? Search the Pantry for alternatives (semantic + tag-based).
3. **Experiment**: For each alternative hypothesis, run a constrained simulation — either a dry-run invocation, a scoring pass via LLM, or a parallel fork (see §2.3).
4. **Score**: Compare outcomes using a locked eval function (defined per task category or globally). The score is not vibes — it is a structured signal: `{ fit: 0..1, efficiency: 0..1, risk: 0..1, note: string }`.
5. **Keep or Discard**: Improvements over the baseline are kept as `insight` records in the Pantry. Regressions are discarded silently. Only the delta matters.
6. **Persist**: Winning insights update ingredient metadata — tags, flavor, examples, usage recommendations.

This is the chess engine pattern: the system only ever ratchets upward. It never regresses to a worse state. Experiments that fail to improve are thrown away without ceremony.

### 2.2 The Constraint Structure

The auto-research loop is **forbidden from modifying**:
- The agent loop itself
- The core Pantry schema
- The user's active session context or message thread
- Any ingredient's core behavior or implementation

It is **permitted to**:
- Read bake history and ingredient manifests
- Run LLM scoring passes (silent, no user-visible output)
- Write `insight` and `decision` records to the Pantry
- Update ingredient `tags`, `examples`, and `flavor` fields (metadata only)
- Append tasting notes to `bake_history` entries
- Emit events to a background event bus (never to the main agent stream)

This constraint is the whole point. A system that can rewrite its own behavior is unauditable. A system that can only annotate and score is safe, reversible, and inspectable.

### 2.3 Parallel Stream Bifurcation (Fork Mode)

At decision points — moments where the baker is choosing between multiple plausible primitives — Auto-Research can **fork the execution stream**:

1. A fork is initiated either automatically (when confidence in primitive selection is below a threshold) or explicitly (user issues a diverge instruction).
2. Each fork is an isolated agent invocation: same task context, different primitive chosen.
3. Forks run concurrently. Each produces a complete output artifact.
4. Outputs are held in a **comparison buffer** — not immediately surfaced.
5. The comparison buffer is scored by the eval function.
6. The winning fork's output is either auto-selected (if score delta is decisive) or presented to the user as a cherry-pick choice.

Cherry-pick semantics are intentional: like `git cherry-pick`, the user sees two complete, standalone outputs and chooses one. The unchosen fork is not wasted — it is logged as a failed experiment and its failure reason is recorded.

**User-initiated fork syntax (illustrative, not final):**
```
> diverge: skill.debug-hypothesis vs skill.criticality — which better fits this refactor task?
```

The agent forks, runs both, scores, presents the winner with a diff-style summary.

### 2.4 The Eval Function

Every comparison needs a ground truth. The eval function is the locked judge.

- It is **not the LLM's opinion** — it is a structured scoring rubric defined per task category.
- Default eval: `{ fit, efficiency, risk }` each 0..1, with a weighted composite score.
- Eval functions are themselves registered as ingredients (kind: `tool`, tagged `eval`).
- They can be swapped without changing the loop.
- Initially, one global default eval. Over time, category-specific evals emerge from the insight corpus.

The eval function cannot be modified by the auto-research loop itself. It is the one fixed point. If it were mutable, the system would optimize toward gaming the eval rather than improving real outcomes — the Habitica failure mode.

### 2.5 The Insight Corpus

Every non-discarded experiment produces an insight record:

```typescript
interface AutoResearchInsight {
  id: string;
  task_fingerprint: string;       // hash of task category + input shape
  baseline_ingredient: string;    // what was actually used
  alternative_ingredient: string; // what was tested
  baseline_score: EvalScore;
  alternative_score: EvalScore;
  winner: "baseline" | "alternative";
  margin: number;                 // score delta
  recorded_at: string;
  note: string;                   // one-line human-readable conclusion
}
```

The corpus is queryable. Over time it becomes the recommendation engine: "for tasks that look like X, prefer ingredient Y over Z by margin M."

---

## 3. Functional Requirements

### 3.1 Background Observation (Must Have)

- **FR-1**: After every bake completes, capture a `BakeObservation` record: ingredient used, task context fingerprint, input shape, outcome, duration, eval score.
- **FR-2**: Observation capture must be non-blocking — it must not delay the bake result returning to the user.
- **FR-3**: Observation must hook into the existing `BakeHistoryEntry` mechanism in `packages/bakery/src/types.ts` — no parallel telemetry system.

### 3.2 Alternative Hypothesis Generation (Must Have)

- **FR-4**: For a given `BakeObservation`, search the Pantry for semantically similar ingredients (same kind, overlapping tags, similar flavor embedding).
- **FR-5**: Limit alternative candidates to top-3 by relevance score to bound token cost.
- **FR-6**: Skip hypothesis generation if the bake was a `failure` — failed bakes signal a different problem (broken ingredient, not wrong ingredient choice).

### 3.3 LLM Scoring Pass (Must Have)

- **FR-7**: For each candidate alternative, issue a silent LLM call: "given this task context and these two ingredients, which is the better fit and why?" Structured output only — no prose stream.
- **FR-8**: LLM scoring calls must use a separate, cheaper model if configured (`STRUDEL_AUTORESEARCH_MODEL`). Default fallback: same model as the session.
- **FR-9**: All LLM scoring calls are fire-and-forget from the user's perspective. If they fail, log silently and skip — no user-visible error.

### 3.4 Insight Persistence (Must Have)

- **FR-10**: Winning insights are written to the Pantry as `insight`-kind ingredients with `source.auto_research: true`.
- **FR-11**: Insight records are immutable after creation. New experiments on the same task fingerprint append new records, not overwrite.
- **FR-12**: Insight records surface in Pantry search results when querying for the relevant ingredient names.

### 3.5 Fork Mode (Should Have)

- **FR-13**: Provide a fork primitive that accepts N ingredient names and a task context, spawns N isolated agent invocations, and collects their outputs.
- **FR-14**: Fork invocations must be fully isolated — no shared mutable state between forks.
- **FR-15**: Fork results are scored against the eval function and ranked.
- **FR-16**: Ranked results are held in a comparison buffer. Auto-select the winner if margin > configurable threshold. Otherwise surface to user as a cherry-pick prompt.
- **FR-17**: The unchosen fork is logged as a `failure` experiment with `failure_reason: "outscored"`.

### 3.6 Recommendation Surfacing (Should Have)

- **FR-18**: When the baker is about to invoke an ingredient that has a strong alternative recommendation in the insight corpus (margin > threshold), inject a silent annotation into the agent's context: "note: for tasks like this, ingredient Y has outperformed ingredient X by margin M in N experiments."
- **FR-19**: This annotation is injected as a system-level context addition, never as a user-visible message.
- **FR-20**: The baker can ignore the annotation. The annotation is a nudge, not a directive.

### 3.7 Auditability (Should Have)

- **FR-21**: All auto-research activity is queryable via `strudel pantry search --tag auto_research`.
- **FR-22**: A `strudel autoresearch stats` command shows: total experiments run, win rate per ingredient, top 5 insight-generating task categories.
- **FR-23**: Auto-research can be fully disabled via `STRUDEL_AUTORESEARCH=false`. When disabled, zero overhead — no hooks fire.

---

## 4. Architecture Flow (High-Level)

```
Session Active
     │
     ▼
Bake Completes ──────────────────────────────────────────────────────────┐
     │                                                                    │
     │ (sync path — returns to user immediately)                         │
     ▼                                                                    │
User sees result                                                          │
                                                                          │
                                          (async background — never blocks)
                                                                          │
                                                         ┌────────────────┘
                                                         ▼
                                              BakeObserver.capture()
                                                         │
                                                         ▼
                                           task fingerprint + outcome
                                                         │
                                                         ▼
                                            Pantry.search(alternatives)
                                                         │
                                               top-3 candidates
                                                         │
                                                         ▼
                                          EvalEngine.score(baseline, alt[])
                                           (silent LLM calls, structured output)
                                                         │
                                              scored comparisons
                                                         │
                                          ┌──────────────┴──────────────┐
                                          │                             │
                                   no improvement                  improvement
                                          │                             │
                                       discard                          ▼
                                                            InsightStore.write()
                                                            (Pantry ingredient record)
                                                                        │
                                                                        ▼
                                                         IngredientMetadata.update()
                                                         (tags, examples, flavor — only)


Fork Mode (when invoked):

User/Agent triggers fork
         │
         ▼
ForkEngine.spawn(ingredientA, ingredientB, taskContext)
         │
    ┌────┴────┐
    ▼         ▼
AgentLoop  AgentLoop
(skill A)  (skill B)
    │         │
    └────┬────┘
         ▼
ComparisonBuffer.collect(outputA, outputB)
         │
         ▼
EvalEngine.score(outputA, outputB)
         │
    ┌────┴──────────────┐
    │                   │
margin > threshold   margin <= threshold
    │                   │
auto-select          cherry-pick prompt → user
    │
log loser as failed experiment
```

---

## 5. Non-Functional Requirements

### 5.1 Performance

- **NFR-1**: The observation capture path adds **zero latency** to the bake result. It must be fully async and fire-and-forget from the hot path.
- **NFR-2**: Auto-research LLM calls must not consume tokens from the user's active session context window. They are separate, stateless calls.
- **NFR-3**: If the Pantry is unavailable or the scoring LLM is unreachable, auto-research silently skips. The session continues unaffected.

### 5.2 Isolation

- **NFR-4**: Fork mode invocations are isolated processes or isolated agent contexts. They must not share mutable state, session context, or side-effect channels with the main session or with each other.
- **NFR-5**: Auto-research writes are append-only. It never modifies existing records in place (except ingredient metadata fields explicitly permitted in §2.2).

### 5.3 Observability

- **NFR-6**: All auto-research activity is queryable after the fact. Nothing is silently lost.
- **NFR-7**: The system emits structured logs at `debug` level only. No `info` or `warn` output during normal operation.

### 5.4 Language & Stack

- **NFR-8**: TypeScript only. No Python, no shell scripts beyond what already exists in the repo.
- **NFR-9**: Follow all conventions in `strudel/AGENTS.md` — no `any` types, no inline imports, Biome for linting/formatting.
- **NFR-10**: Storage: SurrealDB via the existing `PantryStorage` interface. No new storage dependencies.
- **NFR-11**: LLM calls: use the existing `@earendil-works/pi-ai` layer. No new HTTP clients, no direct provider SDK calls.

### 5.5 Configurability

- **NFR-12**: Feature flag: `STRUDEL_AUTORESEARCH=false` disables completely.
- **NFR-13**: Scoring model override: `STRUDEL_AUTORESEARCH_MODEL=<model-id>`.
- **NFR-14**: Fork auto-select threshold: `STRUDEL_AUTORESEARCH_FORK_THRESHOLD=0.15` (default 15% margin).
- **NFR-15**: Max alternatives per observation: `STRUDEL_AUTORESEARCH_MAX_ALTS=3`.

---

## 6. Builder & User Flows

### 6.1 Normal Session (User Is Unaware)

1. User prompts strudel. Baker selects `skill.debug-hypothesis`. Bake runs. Result returned.
2. In the background: BakeObserver captures the invocation. Pantry searched for alternatives. `skill.criticality` surfaces as a candidate. LLM scoring pass runs. `debug-hypothesis` wins by margin 0.22. Insight recorded. Session continues.
3. User never sees any of this.

### 6.2 Recommendation Nudge (User Notices Something Subtly Different)

1. Same flow as 6.1, but this time `skill.criticality` wins by margin 0.31.
2. On the *next* task of the same fingerprint category, the baker's context includes a silent annotation: "prior experiments suggest `skill.criticality` outperforms `skill.debug-hypothesis` for refactor tasks by margin 0.31 (3 experiments)."
3. Baker invokes `skill.criticality` this time. Result is better. Another insight record appended.
4. User may notice the baker made a different choice. That is the only visible signal.

### 6.3 Explicit Fork (User-Initiated)

1. User: "diverge — try `skill.debug-hypothesis` and `skill.criticality` on this refactor and show me both."
2. Fork engine spawns two isolated agent invocations with identical task context.
3. Both complete. Outputs scored. `skill.criticality` wins by margin 0.18 (above threshold).
4. Baker presents: "I ran both. `skill.criticality` scored higher (0.18 margin). Output below. `skill.debug-hypothesis` output available on request."
5. User accepts or overrides. Decision recorded.

### 6.4 Builder Flow (Implementing This Feature)

1. Read this PRD fully.
2. Read `packages/bakery/src/types.ts` — understand `BakeHistoryEntry`, `UsageStats`, `IngredientManifest`.
3. Read `packages/agent/src/agent-loop.ts` — understand the event stream and tool execution path.
4. Read `packages/agent/src/types.ts` — understand `AgentEvent` and `AgentContext`.
5. Implement in this order:
   - `packages/bakery/src/auto-research/observer.ts` — `BakeObserver`
   - `packages/bakery/src/auto-research/eval.ts` — `EvalEngine` + default eval function
   - `packages/bakery/src/auto-research/insight-store.ts` — `InsightStore`
   - `packages/bakery/src/auto-research/loop.ts` — orchestrates observer → eval → store
   - `packages/agent/src/harness/auto-research-hook.ts` — wires the loop into the agent event stream post-bake
   - `packages/bakery/src/auto-research/fork.ts` — `ForkEngine` (fork mode, after loop is stable)
6. Run `npm run check` from repo root after every meaningful change. Fix all diagnostics before moving on.
7. Write tests in `packages/bakery/test/` using vitest. Run them: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/auto-research.test.ts` from `packages/bakery/`.

---

## 7. Success Metrics

These are the conditions under which this feature is working correctly:

| Metric | Target | How to Verify |
|---|---|---|
| Zero latency added to bake hot path | < 1ms added | Benchmark bake completion time with/without observer |
| Insight records accumulate over sessions | > 0 records after 10 bakes | `strudel pantry search --tag auto_research` |
| No user-visible output during background loop | None | Session log audit — zero `info`/`warn` from auto-research |
| Fork produces two complete isolated outputs | Both outputs present in comparison buffer | Unit test: fork with two known skills on fixture task |
| Recommendation nudges improve subsequent bake scores | Score increases over baseline | Longitudinal eval across insight corpus |
| Feature can be fully disabled with no overhead | Zero hook fires when `STRUDEL_AUTORESEARCH=false` | Unit test: observe no-op when flag is off |

---

## 8. Future Extensions

These are **not in scope** for the initial build. They are documented here so the builder does not over-engineer toward them prematurely.

- **Category-specific eval functions**: Today one global eval. Eventually, eval functions emerge per task category from the insight corpus.
- **Insight-driven Pantry pruning**: Ingredients with consistently low scores against alternatives could be flagged for review or archival.
- **Cross-session insight federation**: Export the insight corpus as JSON, import on another machine. Recipes are portable; so should insights be.
- **Automated fork triggers**: Today forks are user-initiated or threshold-triggered. Eventually, the baker decides autonomously when a fork is worth the cost.
- **Multi-fork N>2**: The current design assumes binary forks (A vs B). N-way forks are a natural extension.
- **Eval function self-improvement**: The eval function itself could be scored and refined — but this is explicitly deferred. It requires a meta-eval, which adds a layer of complexity that is not warranted until the first-order loop is proven stable.

---

## 9. Scope Boundaries

### In Scope

- Background observation of bake outcomes
- Silent LLM scoring of alternative primitives
- Insight record persistence in the Pantry (SurrealDB, existing schema extended minimally)
- Annotation injection into agent context (silent, system-level)
- User-initiated fork mode with cherry-pick output
- Configuration via env vars
- `strudel autoresearch stats` CLI command
- TypeScript, monorepo conventions, Biome, vitest

### Explicitly Out of Scope

- Any Python tooling or Python-adjacent patterns
- Modifying the core agent loop behavior
- Modifying the Oven (not yet built)
- Modifying the Recipe Planner (not yet built)
- Any user-visible output during the background loop under normal operation
- Self-modifying ingredient implementations (metadata annotation only)
- Real-time streaming of auto-research progress
- Any new storage dependencies (SurrealDB only, existing `PantryStorage` interface)
- Any new LLM provider integrations (use `@earendil-works/pi-ai` as-is)
- Documentation or README updates (unless explicitly requested)

### The One Inviolable Constraint

The auto-research loop must never block, interrupt, or degrade the user's active session. If it cannot run cleanly in the background, it does not run. Correctness of the session takes absolute precedence over completeness of the research loop.

---

## Appendix A: Source Inspiration

**Video:** `@calebwritescode/video/7625016104116571406` (TikTok, May 2026)  
**Concept:** Auto-research by Arunjit Kapathi — constrained self-optimization through iterated experiments where only improvements are kept. Key structural insight: the constraint is the product. The agent cannot cheat because it cannot modify anything outside the target algorithm. Applied here: auto-research cannot modify ingredient behavior, only ingredient metadata and insight records.

**Chess engine mapping:**
- Chess engine algorithm → primitive selection heuristic
- ELO rating → eval score  
- Experiment loop → BakeObserver → EvalEngine → InsightStore cycle
- Forbidden zones → scope boundaries in §9
- Flat-line-then-improve pattern → insight accumulation is sparse at first, compounds over sessions

---

## Appendix B: Strudel Bakery Metaphor Alignment

For builders unfamiliar with Strudel's metaphor layer — do not dismiss it as decoration. It is load-bearing:

| Bakery Term | Auto-Research Term |
|---|---|
| Ingredient | Primitive (skill, tool, command, etc.) |
| Bake | Single primitive invocation |
| Tasting note | Insight record |
| Recipe refinement | Insight corpus driving recommendation nudges |
| Bake history | `BakeHistoryEntry[]` on `IngredientManifest` |
| The baker learning | Auto-research loop accumulating insight |
| Pantry | SurrealDB-backed ingredient registry |

The metaphor holds. Auto-research is the baker keeping a notebook of what worked, what didn't, and why — then consulting it before the next bake.
