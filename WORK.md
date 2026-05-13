# strudel — WORK.md

**Project:** strudel — fork of the Pi coding-agent monorepo, stripped of built-in mutating tools, wrapped in a "bakery" metaphor where the Master Baker layers Pantry-registered ingredients into recipes.
**Phase:** Implement
**Status:** Source → cupboard → curator → pantry loop is live and smoke-verified end-to-end. Oven (`strudel_bake`) still a stub. CLI never driven interactively.

---

## ACTIVE

- [ ] Drive the strudel CLI end-to-end interactively (forage → curate → promote → search) against the system MLX server at `:10240`. Verifies `npm link`, the bakery LLM-default-port story, and whether the Master Baker identity actually shapes behavior in a real session.

## BLOCKED

(none)

## BACKLOG

- [ ] Oven: `strudel_bake` is a stub; build sandboxed Code Mode execution layer.
- [ ] Phase ④ promotion-policy worker: ambient/killable, advances drafts to active by usage thresholds (deferred per AUTO-RESEARCH-PRD §0.0 #3).
- [ ] Bakery test suite: zero tests. Needs SurrealClient mock or live-DB integration harness.
- [ ] Widen forager walk to allow opt-in hidden directories (`.github/`, `.claude/`, `.cursor/`) so `copilot-instructions.md` and `.claude/claude_desktop_config.json` get foraged.
- [ ] Recipe Planner (intent step before `strudel_bake`).
- [ ] `~/dotfiles/README.md` has unresolved `<<<<<<< HEAD` markers (separate from this repo).

## DONE

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
