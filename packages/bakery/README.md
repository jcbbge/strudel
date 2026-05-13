# @strudel/bakery

The Strudel bakery extension. Adds the two Oven primitives — `strudel_search` and `strudel_bake` — that the Master Baker uses to discover and execute ingredients (skills, tools, MCPs, sub-agents, hooks, …).

`strudel_search` is wired through to the SurrealDB-backed Pantry. `strudel_bake` is still a stub that echoes the payload; the sandboxed Oven arrives in a later step.

## Status

- [x] Package skeleton
- [x] `strudel_search` registered (Pantry-backed, hybrid search)
- [x] SurrealDB-backed Pantry (register / get / list / search / recordBake / reset)
- [x] Auto-registration of the nine primitives via `registerFromDirectory`
- [x] Cupboard (Phase ① of the foraging pipeline) + `pi-extension` forager
- [x] `/strudel status | pantry … | forage … | cupboard …` slash-commands
- [x] Master Baker identity injected as a system-prompt prefix
- [x] Substrate honors PRD §0.0 commitments (append-only history, `stage` field)
- [x] Cupboard-curator (Phases ②/③ — `strudel_curate` + `/strudel cupboard curate|promote|reject`)
- [x] Additional foragers (claude-skill, mcp-config, agent-md, raw-markdown)
- [ ] `strudel_bake` is currently a stub
- [ ] Promotion-policy worker (Phase ④ — draft → active by use)
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
/strudel status                       # surreal + llm health, pantry + cupboard counts
/strudel pantry list [kind]           # list ingredients, optionally filtered by kind
/strudel pantry reset                 # wipe the pantry
/strudel pantry sync [path]           # auto-register a primitives tree
                                      # (default: ~/agent-core/primitives)
/strudel forage <path>                # Phase ①: walk a path, stash candidates in cupboard
/strudel cupboard list [paradigm]     # list cupboard candidates, optional paradigm filter
/strudel cupboard curate [id]         # Phase ②: classify candidate (LLM, heuristic fallback)
/strudel cupboard promote <id> [--kind=X] [--name=Y]
                                      # Phase ③: register as draft Pantry ingredient + mark reviewed
/strudel cupboard reject <id>         # mark reviewed without registering
/strudel cupboard reset               # wipe the cupboard
```

## The foraging pipeline

The Cupboard sits in front of the Pantry. It is where raw, foraged material lands before being judged and shaped into ingredients. Four phases:

```diagram
╭──────────────────────────────────────────────────────────────────╮
│  ① SOURCE  ──▶  ② IDENTIFY  ──▶  ③ CLASSIFY  ──▶  ④ PROMOTE     │
│                                                                  │
│  /strudel       cupboard        cupboard        ingredient       │
│  forage         curator         curator         usage policy     │
│  (mechanical)   subagent        subagent        (mechanical)     │
│                 (LLM)           (LLM + human)                    │
╰──────────────────────────────────────────────────────────────────╯
```

### Phase ① — Source (this release)

`/strudel forage <path>` walks the given root with every registered Forager. Each forager identifies one source paradigm and yields `RawCandidate`s. The Cupboard upserts them by SHA-256 content hash, so re-foraging the same content from any path is idempotent (every observed path is appended to `seen_at`).

Bundled foragers:

| Paradigm        | What it finds                                                                                                  |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `pi-extension`  | Packages depending on `@earendil-works/pi-coding-agent` + loose `.ts/.mjs/.js` extension files.                |
| `claude-skill`  | Directories containing a `SKILL.md` file (Claude Code / Anthropic Skills format).                              |
| `mcp-config`    | `mcp.json`, `.mcp.json`, `claude_desktop_config.json`, `mcp.config.json`, plus any JSON with `mcpServers`.     |
| `agent-md`      | Per-directory agent instructions: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `copilot-instructions.md`. |
| `raw-markdown`  | Free-form `.md` / `.mdx` not claimed by another paradigm; project docs (README/LICENSE/CHANGELOG/…) are skipped. |

Phase ① is intentionally LLM-free. It runs fast and is safe to re-run nightly across many roots.

The walker skips `node_modules`, `.git`, `dist`, `build`, and other always-skip directories — including hidden directories by default. That means files under `.github/`, `.claude/`, `.cursor/`, etc. are not currently picked up; widening the walker is a follow-up if/when it matters.

### Phases ② / ③ — Cupboard curator (this release)

The curator is exposed both as a tool (`strudel_curate`) and as a slash command family (`/strudel cupboard curate|promote|reject`). It picks the next unreviewed candidate, calls the local LLM via `LocalLlm.classify()` to propose a `kind`, name, flavor, tags, dependencies, and confidence; on `promote` it registers the result into the Pantry as `stage: "draft"` (provenance — `cupboard_id`, `source_path`, `source_paradigm`, adapter meta, curator meta — is preserved under `manifest.source`) and marks the cupboard row reviewed.

If the LLM is unreachable the curator falls back to a paradigm-derived heuristic (`pi-extension → plugin`, `claude-skill → skill`, `mcp-config → mcp`, `agent-md → directive`, `raw-markdown → directive`), always at low confidence. That keeps the loop usable on a fresh machine without an LLM, and the human (or a more capable model) can refine later via `/strudel cupboard promote --kind=… --name=…`.

### Phase ④ — Promotion policy worker (deferred)

Ambient background task that advances drafts to `stage: "active"` once usage stats clear a threshold (e.g. N successful bakes, zero recent failures). Honors PRD §0.0 #3 (ambient, killable, threshold-only surfacing).

### Tools surfaced to the agent

| Tool             | Status   | Purpose                                                                                                 |
| ---------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `strudel_search` | working  | Hybrid search over the Pantry (semantic when LLM is reachable, lexical fallback)                        |
| `strudel_bake`   | stub     | Will run a sandboxed Code-Mode payload composing ingredients; currently echoes the input                |
| `strudel_curate` | working  | Picks an unreviewed cupboard candidate, classifies it via the LLM, optionally promotes/rejects it       |

## Backing services

- **SurrealDB** — default `http://127.0.0.1:6000`, ns `strudel`, db `bakery`. Schema is bootstrapped idempotently on first connect.
- **Local LLM** (optional) — OpenAI-compatible endpoint, default `http://127.0.0.1:8080/v1` (e.g. an MLX server). When available it auto-tags untagged ingredients on registration and computes embeddings for semantic search. When unavailable everything falls back to lexical matching.
