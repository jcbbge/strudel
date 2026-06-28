# Roadmap

> The discipline: **prove each layer before the next.** v1 establishes the base.
> Everything below v1 is explicitly *later* and earns its place by demonstrated
> need — not by being a plausible idea. This file exists so good ideas are
> captured without being built prematurely (the failure mode that sank the lab).

## The intelligence ladder

Strudel's "intelligence" grows in rungs. Each rung is independently useful; we
climb only when the rung below is proven.

- **L0 — lexical search.** Zero model, zero infrastructure. Tokenized match over
  primitive name + description. Works the instant someone installs it.
- **L1 — embedding search.** A small embedder (local = still zero-infra, or a
  cheap hosted one). The real discoverability win. **v1 = L0 → L1.**
- **L2 — the generative brain ("the cell phone").** Categorize, enrich thin
  descriptions, distill intent, assemble recipes. Runs through `pi.completeProvider`
  or `@earendil-works/pi-ai` (no rebuilt infra — strudel gets a *model config*,
  not its own pathway), using a deliberately small/fast/cheap model, **opt-in**
  (needs a key → outside the zero-infra core). **v2.**

## v1 — the core (NOW)

- Pi **extension scaffold**; confirm `pi` loads it.
- **Pantry** — unified inventory of *all* kinds + a search index over the
  *on-demand* kinds. Sources: skills/prompts via the same dirs Pi reads;
  tools/mcp/commands via `getAllTools()` / `getCommands()`. **Kind-agnostic from
  day one.**
- **`strudel_search`** (L0 → L1) — surface the right primitives by intent.
- **`before_agent_start`** — suppress Pi's dump-everything; inject the distilled
  subset; `setActiveTools` to curate the surface.
- **bake (curate-and-run)** — activate the chosen tools + inject the chosen
  text-primitives; Pi's own loop executes (no `executeTool` needed).
- **Storage** — JSONL, zero-infra, behind a thin adapter seam.
- **Lead demo** — MCP-tool-explosion: install N MCP servers = hundreds of tools;
  vanilla Pi drowns; strudel surfaces the right few per task, with numbers.
  Skills (100 → picks-the-same-few) as the secondary demo.

## v2 — the brain & composition

- **L2 generative model** (the model-config knob; `completeProvider` / `pi-ai`).
- **Self-organizing Pantry** — structural categorization (server → tool, free) +
  semantic (heuristic name-patterns now; model-enriched later). The
  `list / search / execute` verb triad.
- **MCP, three-pass** — server → tools → functional category; enrich thin tool
  descriptions to raise search quality; handle dispatcher-style MCP extensions
  (one tool hiding many) vs. individually-registered tools.
- **Deterministic oven (Model B)** — recipes with `$N.field` bindings,
  strudel-orchestrated execution. Requires strudel-owned implementations OR an
  upstream `executeTool` contribution to Pi.
- **Telemetry extension** → JSONL event stream → **visualizer** (separate app).
- **Subagent dispatch** (deferred in Pi and the lab).

## v3+ — the hard goals (why strudel exists long-term)

- The **context-window problem**.
- The **memory problem**.

These are interconnected and are the destination. The base layer is the
foundation they require — we do not touch them until the foundation stands.

## Upstream-to-Pi candidates ("make Pi better")

When strudel needs something the `ExtensionAPI` cannot do, the fix is a minimal,
upstreamable contribution to Pi — never a fork:

- **Extension ordering / priority** — so a surface-controlling extension can be
  authoritative in the `before_agent_start` chain.
- **`executeTool`** on the `ExtensionAPI` — would unlock deterministic
  strudel-side orchestration (Model B).

## Discipline (non-negotiable)

1. Prove each layer before the next.
2. Verify the instrument before trusting the number.
3. Tests prove the core in a clean, zero-infra environment.
4. Curate, don't accumulate — a subsystem needs a demonstrated need.
5. No fork of Pi.
