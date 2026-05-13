# strudel

Global CLI for the Strudel layered agentic bakery harness. Wraps the
[Pi coding agent](../coding-agent/README.md) and always preloads the
[`@strudel/bakery`](../bakery) extension so the Pantry, Recipe Planner, and
Oven primitives are available out of the box.

## Install (dog-food / development)

From a fresh clone:

```bash
git clone https://github.com/<you>/strudel.git
cd strudel
npm install
npm run build
cd packages/strudel
npm link
```

That puts a global `strudel` binary on your PATH that points back at this
repo. Any subsequent `npm run build` at the repo root refreshes the binary
in-place — no re-link required.

## Install (global from this repo)

```bash
git clone https://github.com/<you>/strudel.git
cd strudel
npm install
npm run build
npm install -g ./packages/strudel
```

## Usage

```bash
strudel                                # interactive TUI
strudel -p "what is on the front shelf?"
strudel /strudel status                # bakery status + Pantry / LLM health
strudel /strudel pantry list           # show registered ingredients
strudel /strudel pantry sync ~/agent-core/primitives  # auto-register a tree
```

All standard Pi flags are forwarded (`--provider`, `--model`, `--no-session`,
`-e`, etc.).

## What the wrapper does

The CLI is intentionally tiny:

1. Sets `process.title` to `strudel`.
2. Resolves the on-disk path of `@strudel/bakery` and prepends
   `-e <bakery-dir>` to `process.argv`.
3. Hands off to the Pi coding-agent's `main()`.

That means `strudel <args...>` ≡ `pi -e <bakery-dir> <args...>`.

## Requirements

- Node.js >= 20.6
- A running [SurrealDB](https://surrealdb.com) (defaults to
  `http://127.0.0.1:6000`, ns=`strudel`, db=`bakery`)
- Optional: a local OpenAI-compatible LLM at `http://127.0.0.1:8080/v1`
  (e.g. `mlx-serve`) for embeddings + auto-tagging. Without it, the Pantry
  falls back to lexical search.
