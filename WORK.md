# strudel — WORK.md

**Project:** strudel — fork of the Pi coding-agent monorepo, stripped of built-in mutating tools, wrapped in a "bakery" metaphor where the Master Baker layers Pantry-registered ingredients into recipes.
**Phase:** Implement
**Status:** Forage → curate loop runs end-to-end on local hardware (MLX :10240 + Surreal :6000) with no API keys. Curator produces high-quality LLM classifications with grounded evidence. Promote-through-CLI and Pantry search still untested interactively. Oven (`strudel_bake`) still a stub.

---

## ACTIVE

- [ ] Run the full interactive loop in one session: `/strudel forage <path>` → `/strudel cupboard curate` → `/strudel cupboard promote <id>` → `/strudel pantry list` → `strudel_search` from inside a chat turn. Validates the slash-command promote path (only the standalone curator script was exercised this session) AND that the Pantry's hybrid search returns the freshly-promoted ingredient.

## BLOCKED

(none)

## BACKLOG

- [ ] **mlx-omni-server: 2 of 3 chat models broken.** `mlx-community/Qwen2.5-3B-Instruct-4bit` and `lightonai/LateOn-Code-edge` both return HTTP 500 on `/v1/chat/completions`. Only `mlx-community/Qwen3-8B-4bit` works. Investigate (model files? mlx-omni version? GPU memory?) so we have fallbacks.
- [ ] **Add an opencode-plugin forager.** This session manually stashed `~/.config/opencode/plugins/smart-search.ts` because no built-in forager catches `.ts` files in plugin dirs. Pattern: walk `~/.config/opencode/plugins/`, `~/.opencode/plugins/`, package dirs with `@opencode-ai/plugin` import, stash with paradigm `opencode-plugin`. Curator already classifies them correctly.
- [ ] **Curator latency 13–25s on Qwen3-8B local.** Acceptable for one-shot interactive but blocks any batch curate flow. Explore: smaller distilled model for classify only, prompt compression, parallel classify when curating multiple cupboard rows.
- [ ] **Tag rule still leaks compound echoes.** Smart-search test produced `search_plugin` (kind is `plugin`). Could tighten the prompt to forbid any tag containing the kind as a substring, or post-process to strip them.
- [ ] **Bakery embedding path untested end-to-end this session.** `Qwen3-Embedding-4B-DWQ` is registered and the Pantry uses embeddings for hybrid search, but no `pantry.search()` call was actually verified against a non-trivial Pantry. Wire a smoke test once the interactive promote loop works.
- [ ] Oven: `strudel_bake` is a stub; build sandboxed Code Mode execution layer.
- [ ] Phase ④ promotion-policy worker: ambient/killable, advances drafts to active by usage thresholds (deferred per AUTO-RESEARCH-PRD §0.0 #3).
- [ ] Bakery test suite: zero tests. Needs SurrealClient mock or live-DB integration harness.
- [ ] Widen forager walk to allow opt-in hidden directories (`.github/`, `.claude/`, `.cursor/`) so `copilot-instructions.md` and `.claude/claude_desktop_config.json` get foraged.
- [ ] Recipe Planner (intent step before `strudel_bake`).
- [ ] `~/dotfiles/README.md` has unresolved `<<<<<<< HEAD` markers (separate from this repo).
- [ ] No SSH/remote forage support. To forage the M1 machine's directories, either run strudel there too or sshfs/rsync first.

## DONE

- [x] Drove strudel CLI end-to-end interactively against system MLX :10240, no API keys, no global install (just `node packages/strudel/dist/cli.js`). MLX provider auto-discovered + registered as `mlx-local`. Master Baker identity confirmed to shape behavior (agent searches Pantry first as instructed). — 2026-05-13
- [x] Diagnosed and worked around mlx-omni-server quirk: non-streaming `/v1/chat/completions` calls were returning empty `content` with `finish_reason: "tools"` because mlx-omni eagerly parsed Qwen3's `<tool_call>` tokens and dropped message text. Fix: send `tool_choice: "none"` from the bakery's classify/tag calls. — 2026-05-13
- [x] Redesigned curator prompt with deterministic rubric, identifier preservation, structured upstream_name/description fields, tag/dependency constraints, and a `kind_evidence` grounding field. Validated against three live candidates: `emil-design-eng` (was `skill.design_engineering` lossy → now `skill.emil_design_eng` with author-grounded flavor), `debug-hypothesis` (picked up "bulldozing" jargon from inside the SKILL.md), `smart-search.ts` (no rubric rule for paradigm — model still landed `plugin.smart_search` correctly with content-quoted evidence). — 2026-05-13
- [x] claude-skill forager now extracts top-level YAML frontmatter (`name`, `description`) into `adapter_meta` during Phase ①, so the curator gets structured signals up front instead of re-parsing the body. — 2026-05-13
- [x] Cupboard-curator: `Curator` class + `LocalLlm.classify()` + `strudel_curate` tool + `/strudel cupboard curate|promote|reject` slash commands. LLM-led classification with paradigm-derived heuristic fallback. Provenance preserved end-to-end (cupboard_id → manifest.source). — 2026-05-13
- [x] Four new foragers: `claude-skill`, `mcp-config`, `agent-md`, `raw-markdown`, on a shared `walkFiles` + `fileToCandidate` helper. Smoke-verified: 56 candidates across 4 paradigms in this repo, 0 errors. — 2026-05-13
- [x] CI green: deleted 5 upstream tests that asserted on stripped tools (`bash`/`read`/`edit`/`write`); added `--passWithNoTests` to bakery's vitest invocation. 1039 coding-agent tests pass, 0 failed. — 2026-05-13
- [x] Track 1: Cupboard + `pi-extension` forager + `/strudel forage|cupboard` slash commands + Master Baker identity injection. — 2026-05-13
- [x] System-tier infra: SurrealDB on `:6000`, mlx-omni-server on `:10240`, both managed by launchd, both shared across every project on this machine. Documented in `~/dotfiles/`. — 2026-05-13
- [x] Pi monorepo imported, rebranded to strudel, default tools stripped, `@strudel/bakery` and `strudel` CLI packages added, `AUTO-RESEARCH-PRD.md` committed (deferred). — 2026-05-13

---

## Architecture invariants (do not violate)

- **Two-tier services.** SYSTEM tier (SurrealDB :6000, mlx-omni-server :10240) is plug-and-play, machine-wide. PROJECT tier (per-project, never assumed cross-project). Bakery defaults stay neutral; project shells set `STRUDEL_LLM_BASE_URL` to point at the system tier.
- **Strudel is siloed inside SurrealDB at `ns=strudel/db=bakery`.** Tables: `ingredient` (Pantry) + `cupboard` (foraged candidates).
- **AUTO-RESEARCH-PRD §0.0 substrate commitments:** append-only `BakeHistoryEntry[]`, `stage` field on `IngredientManifest`, eval-functions-as-ingredients (locked-judge), ambient background loops only, articulated forbidden zones.

## Repo conventions

- Commit identity: `jrg <jrg@strudel.local>`.
- Every commit message includes `Amp-Thread-ID:` trailer + `Co-authored-by: Amp <amp@ampcode.com>`.
- `npm run check` before committing.
- `git add` only files YOU changed in THIS session — never `git add -A`.
