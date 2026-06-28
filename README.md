# Strudel

> A [Pi](https://pi.dev) extension that fixes **primitive overload** — search your
> skills, tools, and MCPs by intent instead of cramming all of them into the
> context window.

## The problem

Every agent harness converges on the same building blocks — skills, tools, MCPs,
subagents, slash commands, rules, hooks. Whatever you call them, they are all
**collections**. And collections have one failure mode at scale: the agent loses
track of what it has.

Give an agent 100 skills and it will reach for the same three to five every
time — not because the rest are worse, but because it never really *sees* the
catalog. It has no frame of reference for its own inventory. You end up
hand-routing ("no, use *that* one"), which defeats the point.

## The idea — a kitchen

You don't haul the entire grocery store into the kitchen to make a sandwich. You
keep a **pantry**, you reach for the ingredients the dish needs, and when you're
missing something you improvise. Strudel treats agent primitives the same way:

- The full catalog lives in a **Pantry** — indexed, not loaded into context.
- The agent **searches by intent** and pulls only what the task needs.
- It **composes** the pieces into a recipe and executes.
- Missing something? Substitute a near match.

The agent's context stays small; its reach stays large.

## How it works

Strudel is a **Pi extension** — it adds a small search-and-execute gateway on top
of Pi. It does **not** fork Pi; it runs against whatever version of Pi you have
installed, so you inherit every Pi upgrade for free.

- **Two classes of primitive.** *On-demand* kinds (skills, tools, MCPs,
  subagents, commands) go through the gateway. *Ambient* kinds (rules, hooks) are
  always-on and declarative — they stay as ordinary Pi extensions, because you
  don't "search for" a rule.
- **Zero-infrastructure by default.** The Pantry persists to JSONL — no database
  required to run it. Storage is behind a thin seam, so you can swap in a real DB
  later if you want.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the model and the v1 scope.

## Status

Early, and deliberately small. v1 establishes the base layer: the gateway over
**skills** first, then the other on-demand kinds. The harder goals strudel is
ultimately aiming at — the **context-window problem** and the **memory
problem** — are explicit *future* work, not solved yet. We are building the
foundation, in order, and proving each layer before adding the next.

## Install

```sh
# 1. Pi — the runtime (cognition layer)
curl -fsSL https://pi.dev/install.sh | sh

# 2. Strudel — this extension
pi install git:github.com/jcbbge/strudel
```

## Built on Pi

Strudel stands on [Pi](https://pi.dev) by [Mario Zechner](https://github.com/badlogic)
and the Earendil Works team (`@earendil-works/pi-coding-agent`, MIT). Pi is the
cognition layer — TUI, multi-provider AI, sessions, and the extension API.
Strudel is the pantry on top. Pi's own design goal — *"a minimal agent harness;
extensibility as primitives, not bundled features"* — is exactly the ground this
is built for.

## License

MIT
