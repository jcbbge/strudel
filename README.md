# strudel

> A self-improving, layered agentic harness. The agent is a baker. The repo is its test kitchen.

Strudel is a coding-agent harness with **nothing built in**. No `read`, no `bash`, no `edit`, no `write`. The agent starts with bare cognition and a Pantry full of small, composable primitives — your tools, your skills, your sub-agents, your hooks — and learns to layer them into recipes that actually do work. Every bake is recorded. Recipes that succeed get found again. Recipes that fail get refined.

This is a fork of [Pi](https://github.com/earendil-works/pi) stripped to the cognition layer, then wrapped in a bakery metaphor that turns out to be the right mental model for an extensible agent.

---

## Why

Every other coding agent ships with a fixed menu of dangerous defaults — read any file, run any shell command, edit anything. The convenience is real and so is the blast radius. You can't audit what the agent is *capable of*; you can only audit what it *did*.

Strudel inverts that. The agent is capable of nothing until you stock the pantry. Want it to read files? Register a `read_file` ingredient. Want it to run `git status`? Register `command.git-status`. Want a Python sandbox? Register `tool.python_scratchpad`. Every capability is a named, versioned, reviewable item on a shelf with usage stats next to it.

The trade is: a little more setup up front, and in exchange you get an agent whose surface area you can actually see, an agent that gets *more capable over time* as you teach it your craft, and an agent whose capabilities are portable — your pantry exports as JSON, imports on a fresh machine, and the same recipes work.

## The metaphor (it's not just decoration)

```diagram
╭───────────────────────────────────────────────────────────────╮
│                       The Master Baker                        │
│                            (LLM)                              │
│                                                               │
│   reads recipe cards · annotates the margins · invents new    │
╰────────┬────────────────────────────────────────────┬─────────╯
         │                                            │
         ▼                                            ▼
╭─────────────────────╮                    ╭─────────────────────╮
│   Recipe Planner    │                    │     The Oven        │
│  (Intent / Plan)    │───── plans  ──────▶│ (Unified Execute)   │
╰──────────┬──────────╯                    ╰──────────┬──────────╯
           │                                          │
           ▼                                          ▼
╭───────────────────────────────────────────────────────────────╮
│                          The Pantry                           │
│        directives · commands · skills · hooks · tools         │
│           mcp · plugins · agents · subagents                  │
│                                                               │
│  hybrid storage (semantic + lexical) · usage stats · history  │
╰───────────────────────────────────────────────────────────────╯
```

- **The Master Baker** is the LLM. It reads recipe cards, scribbles in margins, refines techniques over time, and invents new dishes when it needs to.
- **The Pantry** is persistent storage for every primitive the baker can compose. Default backend: SurrealDB. Bring your own — the storage layer is an interface.
- **The Recipe Planner** is the metacognition step. Before any non-trivial bake, the baker summarizes the goal, queries the Pantry, drafts a recipe.
- **The Oven** is the unified execution surface. Every primitive — whether it's a single command or a multi-step Code Mode recipe — runs through the Oven.
- **Bake history** turns every execution into telemetry the baker can learn from.

The fact that the baker keeps a notebook — annotates which recipes worked, when to use bread flour vs all-purpose, what the salt-to-flour ratio should be in this kitchen specifically — is the whole point. **This isn't a generic agent. It's your agent's test kitchen, becoming uniquely yours, one bake at a time.**

## The nine primitives

Every ingredient in the Pantry is one of nine kinds. Each kind has its own registry, its own invoker, and its own way of being baked.

| Kind | What it is | What "bake" means |
|---|---|---|
| **directive** | Persistent guidance ("never push to main without tests") | Inject into the system prompt; persists until removed |
| **command** | A named, parameterized shell or prompt one-shot | Execute the body with the given args |
| **skill** | A focused chunk of expertise loaded into context for a task | Mount as a context-scoped system-prompt addition |
| **hook** | A lifecycle script (session-start, pre-bake, etc.) | Install to a lifecycle slot; runtime fires it on event |
| **tool** | A callable function with input/output schema | Invoke with validated args, return result |
| **mcp** | A connection to an MCP server | Connect, list its tools, expose or invoke |
| **plugin** | A bundle of multiple primitives shipped together | Expand and register all contained items |
| **agent** | A long-lived agent with its own persona/model/memory | Hand off control or fork the conversation |
| **subagent** | A short-lived task agent (architect, debugger, reviewer) | Spawn child session, run to completion, return result |

The nine are the spine. Strudel does not stray from them. New capabilities are always one of the nine.

## Composability — your kitchen, your appliances

Strudel is a framework, not a product. The defaults reflect *one* setup (mine) — they are not the only configuration. Every external dependency is behind an interface so you can swap it without forking.

**Storage** (`PantryStorage`)
- Default: SurrealDB (HTTP, no native client needed)
- Swap in: Postgres, SQLite, JSON file, in-memory, anything that satisfies `register / get / list / search / recordBake`

**Enricher** (`PantryEnricher`)
- Default: any OpenAI-compatible endpoint (works with [MLX](https://github.com/ml-explore/mlx-lm), [Ollama](https://ollama.com), vLLM, llama.cpp server, etc.)
- Swap in: Anthropic embeddings, OpenAI cloud, a noop enricher that disables embeddings entirely
- Without an enricher, the Pantry falls back to lexical search and skips auto-tagging — everything still works.

**LLM** — strudel inherits Pi's multi-provider AI layer. Anthropic, OpenAI, Google, xAI, Groq, Cerebras, OpenRouter, MLX, Ollama, Bedrock, and more.

**Primitives** — the pantry starts empty. Stock it with whatever you have. The included `pantry sync` command will walk a directory tree (default: `~/agent-core/primitives`) and register everything it finds. Bring your own conventions — directories map to ingredient kinds, frontmatter is parsed, fallbacks are sensible.

If you want to teach strudel to talk to a different database or a different embedding service, you write one class, register it, and you're done. No core changes. No fork.

## Status

Strudel is early. Honest snapshot:

| Area | State |
|---|---|
| Stripped fork (no built-in `read/bash/edit/write`) | done |
| Global `strudel` binary, dog-food install loop | done |
| SurrealDB-backed Pantry with hybrid search | done |
| Auto-registration of on-disk primitives (8 of 9 kinds) | done |
| Branding pass (LLM sees "strudel", not "pi") | done |
| Pluggable storage / enricher interfaces | next |
| The Oven — invokers for all nine primitive kinds | next |
| Code Mode (sandboxed JS recipe execution) | next |
| Recipe Planner | after Oven |
| Self-registration during sessions | after Oven |
| Pantry import/export, `strudel doctor` | planned |

## Install

### Requirements

- Node.js ≥ 20.6
- A SurrealDB instance (local is fine; default `http://127.0.0.1:6000`)
- *Optional but recommended:* a local OpenAI-compatible LLM (MLX, Ollama, llama.cpp) at `http://127.0.0.1:8080/v1` for embeddings + auto-tagging
- *Optional:* a directory of primitives to seed the Pantry (e.g. `~/agent-core/primitives/`)

### From source (dog-food / development)

```bash
git clone https://github.com/<you>/strudel.git
cd strudel
npm install
npm run build
cd packages/strudel
npm link
```

`strudel` is now on your PATH. Every subsequent `npm run build` at the repo root refreshes the binary in place — no re-link needed. This is the loop you want while developing your own primitives or hacking on the bakery itself.

### Configure your kitchen

Defaults assume the author's setup. To point at your own SurrealDB / LLM:

```bash
export STRUDEL_SURREAL_URL="http://your-host:8000"
export STRUDEL_SURREAL_USER="root"
export STRUDEL_SURREAL_PASS="..."
export STRUDEL_SURREAL_NS="strudel"
export STRUDEL_SURREAL_DB="bakery"

export STRUDEL_LLM_BASE_URL="http://localhost:11434/v1"     # Ollama, MLX, vLLM, …
export STRUDEL_LLM_CHAT_MODEL="llama3.1:8b"
export STRUDEL_LLM_EMBEDDING_MODEL="nomic-embed-text"
```

A `strudel doctor` command that scans your environment and walks you through this is on the roadmap.

### Stock the pantry

```bash
strudel /strudel pantry sync ~/agent-core/primitives
strudel /strudel pantry list
strudel /strudel status
```

### First bake

```bash
strudel
> search the pantry for anything related to debugging
```

## The dog-food contract

This repo is the source of truth for the binary you run. There is no separate distribution. When you change code in this repo and rebuild, the global `strudel` binary updates immediately. That means:

- You ship improvements to yourself in seconds.
- Every recipe you invent, every bug you hit, every refinement you make is *for the agent you're using right now*.
- The agent and the workshop are the same project.

This is the intended posture. Use the agent to improve the agent. Bake in your own kitchen.

## Contributing

This is a personal-tool-shaped-as-a-framework. Contributions welcome, but the bar is "does this make the bakery more bakery-shaped, or does it pull strudel toward being a generic agent?" If you're unsure, open an issue first.

See [AGENTS.md](AGENTS.md) for development conventions (humans and agents both follow these). See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Lineage

Strudel forks [Pi](https://github.com/earendil-works/pi) by [Mario Zechner](https://github.com/badlogic) and the Earendil Works team. Pi provides the cognition layer (TUI, multi-provider AI, extension API, session management). Strudel provides the bakery on top: stripped defaults, the nine primitives, the Pantry, and (soon) the Oven.

Pi is excellent. If you want a coding agent with batteries included, use Pi. If you want a coding agent that starts empty and fills with your own work, you're in the right place.

## License

MIT
