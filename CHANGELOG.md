# Changelog

All notable changes to Strudel will be documented in this file.

## [0.1.0] - 2026-06-30

### Added

- **Introspection commands** — verify Strudel is working without calling the LLM
  - `/strudel` (status) — overview dashboard with config, pantry counts, search mode, surface state
  - `/strudel-health` — connectivity checks for config file, pantry roots, embeddings endpoint, cache
  - `/strudel-pantry` — full primitive inventory by kind with `--kind` and `--search` filters
  - `/strudel-surface` — surface control state showing baseline, activated, and suppressed tools
  - `/strudel-search <query>` — run search directly with raw scores, no LLM involved

- **Shared state module** (`src/state.ts`) — clean separation of extension state for commands

### Changed

- Version bump to 0.1.0
- Commands work in both TUI and print mode (`pi -p "/strudel"`)

### Technical

- 16 new tests for introspection commands (52 total tests)
- Commands directory structure: `src/commands/*.ts`

## [0.0.0] - Initial Development

### Added

- Core extension scaffold
- Pantry indexing — unified inventory over all primitive kinds from configured roots
- `strudel_search` tool — L0 lexical + L1 semantic search over primitives
- Surface control — `before_agent_start` hook prunes Pi's dump-everything sections
- Curate-and-run — tools surfaced via search become callable
- Configuration via `~/.strudel/config.json`
- Embeddings cache at `~/.strudel/cache/embeddings.json`
- 36 unit tests covering pantry, search, surface, embeddings
