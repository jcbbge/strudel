# @strudel/bakery

The Strudel bakery extension. Adds the two Oven primitives — `strudel_search` and `strudel_bake` — that the Master Baker uses to discover and execute ingredients (skills, tools, MCPs, sub-agents, hooks, …).

`strudel_search` is wired through to the SurrealDB-backed Pantry. `strudel_bake` is still a stub that echoes the payload; the sandboxed Oven arrives in a later step.

## Status

- [x] Package skeleton
- [x] `strudel_search` registered (Pantry-backed, hybrid search)
- [x] SurrealDB-backed Pantry (register / get / list / search / recordBake / reset)
- [x] Auto-registration of the nine primitives via `registerFromDirectory`
- [x] `/strudel status | pantry list | pantry reset | pantry sync` slash-commands
- [x] Master Baker identity injected as a system-prompt prefix
- [x] Substrate honors PRD §0.0 commitments (append-only history, `stage` field)
- [ ] `strudel_bake` is currently a stub
- [ ] Recipe Planner (intent step)
- [ ] Oven (sandboxed execution + Code Mode)

## Substrate Commitments (from `AUTO-RESEARCH-PRD.md` §0.0)

The Auto-Research evaluation layer is deferred until ~200 real bakes have accumulated. Five structural commitments were extracted from that PRD and are honored here from day one so a future implementation is additive, not a refactor.

1. **Append-only `BakeHistoryEntry[]`.** `Pantry.recordBake` only ever prepends a new entry and trims the tail to `MAX_BAKE_HISTORY`. Existing entries are never mutated. The `BakeHistoryEntry` interface in [`src/types.ts`](src/types.ts) carries the discipline as documentation; any future writer must preserve it.

2. **Eval-functions-as-ingredients (`kind: "tool"`).** When the eval layer lands, the eval itself will be a registered ingredient — swappable, versioned, auditable, and forbidden from being modified by the loop that uses it (locked-judge pattern). No eval ingredients exist yet; the schema is ready for them.

3. **Ambient background loops only.** Any future background loop in the bakery (auto-research, recipe planner, etc.) must be: (a) ambient, never interruptive; (b) zero-latency on the user-facing hot path; (c) feature-flag killable with zero overhead when disabled; (d) surfacing only on threshold events. There are no background loops yet.

4. **Articulated forbidden zones.** Future features that touch self-modification must explicitly state: what is the constraint that makes this trustworthy? What can the loop NOT touch? The constraint is the product.

5. **`stage` field on `IngredientManifest`.** Ingredients now carry `stage: "cupboard" | "draft" | "active" | "deprecated"`. Explicit registrations default to `"active"`. The Cupboard is the staging shelf for captured-but-not-yet-recommended intent. The natural primitive evolution pipeline (`phrase → command → skill → mcp/tool → subagent`) is a sequence of `pantry promote` calls (not yet implemented) that advance `kind` and `stage` together.

## Usage

The bakery is loaded as a Pi extension. The `strudel` CLI in [`packages/strudel`](../strudel) preloads it via `pi -e <bakery-dir>`; alternatively pass `-e packages/bakery` to `pi` directly or list the package in your extensions config.

### Slash commands

```text
/strudel status                 # surreal + llm health, pantry config
/strudel pantry list [kind]     # list ingredients, optionally filtered by kind
/strudel pantry reset           # wipe the pantry
/strudel pantry sync [path]     # auto-register a primitives tree
                                # (default: ~/agent-core/primitives)
```

### Tools surfaced to the agent

| Tool             | Status   | Purpose                                                                                  |
| ---------------- | -------- | ---------------------------------------------------------------------------------------- |
| `strudel_search` | working  | Hybrid search over the Pantry (semantic when LLM is reachable, lexical fallback)         |
| `strudel_bake`   | stub     | Will run a sandboxed Code-Mode payload composing ingredients; currently echoes the input |

## Backing services

- **SurrealDB** — default `http://127.0.0.1:6000`, ns `strudel`, db `bakery`. Schema is bootstrapped idempotently on first connect.
- **Local LLM** (optional) — OpenAI-compatible endpoint, default `http://127.0.0.1:8080/v1` (e.g. an MLX server). When available it auto-tags untagged ingredients on registration and computes embeddings for semantic search. When unavailable everything falls back to lexical matching.
