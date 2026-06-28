# Architecture

This document is the spine, and it exists *before* the code on purpose. The
predecessor project (archived) drifted by building elaborate subsystems on a core
that was never verified. The rule we do not break here:

> **Strip the exotic, harden the core, and prove each layer before adding the next.**

## Thesis

The industry has converged on a set of agent **primitives** — skills, tools,
MCPs, subagents, slash commands, rules, hooks (and provider/variant kinds). They
differ in purpose, but they share one structural truth: **each is a collection.**
And collections fail the same way at scale — the agent loses awareness of what is
available and reverts to a familiar few. The fix is the same for all of them:
don't register the collection into context; **index it and search it by intent.**

## Two classes of primitive

Not every primitive belongs in the gateway. This split resolves a real tension
(ambient primitives are a leaky fit for "search-and-execute"):

| Class | Kinds | Mechanism | Surfaced to the agent? |
|---|---|---|---|
| **On-demand / collection** | skills, tools, MCPs, subagents, slash_commands | Strudel gateway (`search → prep → bake`) | Yes — selected per task |
| **Ambient / runtime** | rules, hooks (providers, directives-as-context) | Plain Pi extensions (lifecycle hooks) | No — always-on, declarative |

A rule is not something you "search for and execute"; it is a constraint that is
always active. Forcing ambient primitives through a search gateway is a leaky
abstraction. They stay as ordinary Pi extensions — which is exactly what Pi's
extension system is for.

## Composition is the point — not single-primitive lookup

The executor.sh pattern (`list → search → execute`) is the *entry mechanism*, not
the whole idea. Strudel does **not** stop at "find the one skill for this prompt."
Because every on-demand kind is a collection under **one** gateway, a request is
satisfied by **assembling a recipe across kinds** — not by retrieving a single
item.

A single task might resolve to: a *skill* (how to brainstorm) + a *tool* (to write
files) + an *MCP server* (to query an API) + a *plugin* + a second *skill* —
composed in order, with dependencies and bindings, into one execution that
produces a single output. Like a kitchen: a dish is ingredients + utensils + a
technique, combined — not one item off a shelf.

The three gateway verbs, precisely:
- **`search`** — gather *candidates across all on-demand kinds* by intent
  (requirements gathering), not a single-kind lookup.
- **`prep`** — distill those candidates into a validated, ordered **recipe**
  (which primitives, in what order, with what `$N.field` bindings).
- **`bake`** — execute the recipe → one result.

**Build constraint (load-bearing):** the Pantry index, search, and recipe model
are **kind-agnostic from day one.** v1 seeds the Pantry with skills first, but the
plumbing must never assume a single kind — `search` returns mixed-kind candidates
and recipes span kinds. *Skills-first is a content choice, not a schema
constraint.* Building skills-only plumbing we'd have to rip out to compose later
is exactly the kind of drift we're avoiding.

## Extension-only — no fork

Strudel is a **Pi extension** and never forks or vendors Pi. The seam is Pi's
`ExtensionAPI`. Strudel runs against whatever Pi the user installed
(`@earendil-works/pi-coding-agent`, MIT) — **whatever Pi ships, strudel ships.**

- **Pi runtime** — `@earendil-works/pi-coding-agent`. Installed upstream,
  untouched. The cognition layer (TUI, providers, sessions, extension API).
- **Strudel** — this repo. Installed via `pi install`. The pantry layer.
- **"Making Pi better"** — when strudel needs something the `ExtensionAPI`
  cannot do, that is a gap to **contribute upstream to Pi**, not a reason to
  fork. Strudel's pressure on the API reveals what Pi is missing.

We devDepend on `@earendil-works/pi-coding-agent` only for its `ExtensionAPI`
types; at runtime strudel uses whatever Pi the user has.

## Primitive placement & interop

**Pi has two doors for primitives, not one:**
- *Files (auto-discovered):* skills, prompt-templates, themes, context/rules files —
  dropped into standard dirs (`~/.pi/agent/<kind>/`, `./.pi/<kind>/`), aggregated by
  the resource-loader.
- *Code (the ExtensionAPI):* tools, hooks, providers, MCP clients, code-commands — TS
  modules (`jiti` / `pi install`) that `register…` via the API at load.

Users keep using **both** Pi doors to add primitives. Strudel never gatekeeps how a
primitive is *added* — only how on-demand primitives are *selected*.

| Kind | Door | Lives | Class | Strudel role |
|---|---|---|---|---|
| skill | file | `~/.pi/agent/skills/`, `./.pi/skills/` | on-demand | index + select (replace Pi's dump); bake = inject chosen |
| prompt/template | file | `…/prompts/` | on-demand | index + surface |
| tool | code | an extension | on-demand | index via `getAllTools`; bake = `setActiveTools` subset |
| mcp | code (no native MCP) | an MCP extension | on-demand | index its **individual tools**; activate the right ones |
| slash_command (code) | code | extension | on-demand | index via `getCommands` |
| subagent | code | extension | on-demand | deferred (v1) |
| rule | file | `AGENTS.md`/`pi.md`/`.pi/context.md` | ambient | inventory only |
| hook | code | extension (`pi.on`) | ambient | inventory only |
| provider | code | extension | ambient/config | inventory only |
| plugin/package | both | `packages/` | container | index contents |

The Pantry is **both** a *search index* (on-demand kinds) and a *unified inventory*
(all kinds, incl. ambient — for the catalog view and the visualizer).

**Strudel is a runtime lens — nothing moves into it.** At `session_start` /
`before_agent_start` strudel aggregates by (a) reading the same resource dirs Pi
reads, and (b) enumerating the live registry (`getAllTools()`, `getCommands()`). A
user's existing extensions / MCP servers are simply the *input* to the index — no
migration, no relocation.

**Execution: strudel curates, Pi executes.** The ExtensionAPI exposes
`getAllTools` / `setActiveTools` but **no `executeTool`**. So strudel never runs
primitives itself: bake = activate the chosen tools (`setActiveTools`) + inject the
chosen text-primitives (skills/rules) → the agent runs the curated recipe through
Pi's own loop → one output. Deterministic strudel-side orchestration (the lab's
"oven", with `$N.field` bindings) is deferred — it would require strudel-owned
implementations or an upstream `executeTool` contribution to Pi.

**MCP granularity:** index each MCP *tool* individually (they register individually,
so each appears in `getAllTools`) — not the server as a unit. Search surfaces the
right 2 of Cloudflare's 60, not all 60. (Caveat: this holds when the MCP extension
registers tools individually rather than behind one dispatcher tool — see Q3 notes.)

## The three scopes

```
Pi runtime ──ExtensionAPI──▶ strudel extension(s) ──JSONL events──▶ visualizer (separate, later)
```

1. **Pi runtime** — installed, upstream, never modified.
2. **Strudel extensions** — the gateway, and (separately) telemetry.
3. **Visualizer** — a separate app that ingests the telemetry event stream.
   Optional. Later.

## Telemetry

Telemetry is its **own extension**, not a runtime change. Pi already emits a full
lifecycle to extensions — `before_agent_start`, `tool_call`, `tool_result`,
`tool_execution_*`, `turn_start`/`turn_end`, `message_*`,
`after_provider_response`, `session_*`. A telemetry extension subscribes and
writes a normalized JSONL event stream; the visualizer ingests it. No runtime
instrumentation needed. (Deep sub-lifecycle tracing, if ever wanted, is the only
thing that would justify an upstream Pi contribution — deferred.)

## v1 scope

**IN**
- The gateway as a Pi extension: a **Pantry** index + `strudel_search` +
  `strudel_prep` + `strudel_bake`.
- First kind: **skills**. Then the other on-demand kinds.
- **Search and compose** (recipes) — both, this cycle.
- **Storage: JSONL** by default (zero-infra), behind a thin adapter seam so a DB
  can be swapped in.
- A **telemetry extension** emitting a JSONL event stream.

**OUT — explicitly deferred, do not build**
- Memory subsystem; context-window compression. (Stated *future* goals.)
- Self-improvement machinery: auto-research, gleaner, curator, judge/scoring,
  shadow-planner, distiller.
- Runtime *invention* of missing primitives. (Substitution is in scope;
  invention is later.)
- A bespoke event bus / perf framework. (Telemetry is a thin extension, not a
  framework.)
- Any fork of, or modification to, Pi's source.

## Discipline (the lessons, written down)

1. **Prove each layer before the next.** Search before compose-quality; compose
   before substitution; nothing ships before the core works end-to-end with zero
   infrastructure.
2. **Curate, don't accumulate.** A new subsystem requires a demonstrated need,
   not a plausible idea.
3. **Strip the exotic.** If it needs a service to run, it is not in the core.
4. **Measure before optimizing; verify the instrument before trusting the
   number.**
5. **Tests must prove the core in a clean, no-infra environment.**
   Green-by-skipping is not green.
