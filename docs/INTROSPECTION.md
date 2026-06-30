# Strudel Introspection — `/strudel` Command Spec

**Problem:** Users can't verify strudel is working without calling the LLM or reading stderr. The tests prove the code works in isolation, not that YOUR deployment works.

**Solution:** A `/strudel` slash command with subcommands for inspecting every layer.

---

## Command Structure

```
/strudel              → status (default)
/strudel status       → overview: config, pantry counts, surface mode, embeddings health
/strudel pantry       → full inventory by kind
/strudel surface      → what's active, what's baseline, what got pruned
/strudel search <q>   → run a search without LLM, show scores
/strudel config       → show loaded config + where it came from
/strudel health       → connectivity check (embeddings endpoint, roots exist)
```

---

## `/strudel status` (default)

One-screen overview. No arguments.

```
Strudel v0.0.0
══════════════════════════════════════════════════════

Config: ~/.strudel/config.json ✓
Roots:  ~/.pi/agent (exists)
        ~/agent-core/primitives (exists)

Pantry: 120 primitives indexed
        ┌─────────┬───────┐
        │ kind    │ count │
        ├─────────┼───────┤
        │ skill   │    73 │
        │ plugin  │    13 │
        │ subagent│    13 │
        │ rule    │    10 │ (ambient)
        │ agent   │     5 │
        │ hook    │     2 │ (ambient)
        │ command │     2 │
        │ tool    │     1 │
        │ mcp     │     1 │
        └─────────┴───────┘

Search: semantic (L1)
        model: mlx-community/Qwen3-Embedding-4B-4bit-DWQ
        endpoint: http://127.0.0.1:10240/v1 ✓

Surface: pragmatic
         baseline: 6 tools (read, write, edit, bash, strudel_search, ...)
         activated this session: 0
         max activated: 24
```

---

## `/strudel pantry [--kind <kind>] [--search <query>]`

List the full inventory. Optional filters.

```
/strudel pantry
```
```
Pantry Inventory (120 primitives)
══════════════════════════════════════════════════════

skills/ (73)
  building-with-solidjs    SolidJS fundamentals and patterns
  solidjs-2-0              SolidJS 2.0 divergences from 1.x
  impeccable               Frontend interface design and iteration
  ...

rules/ (10) [ambient — not searchable]
  commit-convention        Commit message format
  work-file-format         WORK.md structure
  ...

tools/ (1)
  composto                 Code-to-IR compression

subagents/ (13)
  test-writer              Writes tests for implementations
  ...
```

With filter:
```
/strudel pantry --kind skill --search solid
```
```
skills/ matching "solid" (3 of 73)
  building-with-solidjs    SolidJS fundamentals and patterns
  solidjs-2-0              SolidJS 2.0 divergences from 1.x
  solid-testing            Testing patterns for Solid applications
```

---

## `/strudel surface`

Show what surface control is doing RIGHT NOW.

```
Surface Control (pragmatic mode)
══════════════════════════════════════════════════════

Baseline tools (always active):
  read, write, edit, bash, strudel_search, find

Activated this session (via strudel_search):
  (none yet)

Runtime tools available (from Pi registry):
  47 total — 41 suppressed, 6 active

Suppressed tools (would be in prompt without strudel):
  kotadb_search, kotadb_find_usages, kotadb_deps, ...
  alembic_create_shard, alembic_reconstitute, ...
  smart_search, perplexity_search, ...

Prompt sections:
  <available_skills> block: STRIPPED (73 skills not in prompt)
  Available tools: section: PRUNED to 6 tools
```

---

## `/strudel search <query>`

Run a search directly, see raw scores. No LLM involved.

```
/strudel search "file reading and writing"
```
```
Search: "file reading and writing" (semantic L1)
══════════════════════════════════════════════════════

 #  Score   Kind      Name                    Source
────────────────────────────────────────────────────
 1  0.732   tool      read                    runtime:tool
 2  0.689   tool      write                   runtime:tool
 3  0.656   skill     xlsx                    ~/.pi/agent/skills/xlsx/
 4  0.655   skill     pdf                     ~/.pi/agent/skills/pdf/
 5  0.648   skill     debugging-with-logs     ~/.pi/agent/skills/...
 6  0.644   tool      find                    runtime:tool
 7  0.641   subagent  test-writer             ~/.pi/agent/subagents/...
 8  0.638   skill     impeccable              ~/.pi/agent/skills/...

Query embedding: 384 dims, 12ms
Search time: 8ms (120 primitives)
Mode: semantic (lexical fallback: disabled)
```

With lexical comparison:
```
/strudel search "file reading" --compare
```
```
                    Semantic    Lexical
                    ────────    ───────
 1  read            0.732       6
 2  write           0.689       4
 3  xlsx            0.656       2
 ...

Semantic found 8 hits, lexical found 4 hits.
Top-1 agreement: ✓ (both picked 'read')
```

---

## `/strudel config`

Show exactly what config was loaded and from where.

```
Config: ~/.strudel/config.json
══════════════════════════════════════════════════════

{
  "pantry": {
    "roots": ["~/.pi/agent", "~/agent-core/primitives"]
  },
  "embeddings": {
    "baseUrl": "http://127.0.0.1:10240/v1",
    "model": "mlx-community/Qwen3-Embedding-4B-4bit-DWQ"
  },
  "surface": "pragmatic",
  "baseline": null  // using default
}

Resolved paths:
  roots[0]: /Users/jrg/.pi/agent ✓ (exists, 98 primitives)
  roots[1]: /Users/jrg/agent-core/primitives ✓ (exists, 22 primitives)

Defaults applied:
  surface: "pragmatic" (default)
  baseline: ["read", "write", "edit", "bash", "strudel_search", "find"]
```

---

## `/strudel health`

Verify everything is reachable. For debugging "it doesn't work".

```
Health Check
══════════════════════════════════════════════════════

Config file:
  ~/.strudel/config.json ✓ (parsed successfully)

Pantry roots:
  ~/.pi/agent ✓ (readable, 98 primitives)
  ~/agent-core/primitives ✓ (readable, 22 primitives)

Embeddings endpoint:
  http://127.0.0.1:10240/v1 ✓ (responding)
  model: mlx-community/Qwen3-Embedding-4B-4bit-DWQ ✓ (loaded)
  test embed: "hello" → 384 dims in 8ms ✓

Cache:
  ~/.strudel/cache/embeddings.json ✓ (142 cached, 847KB)

Overall: HEALTHY
```

Or when something's wrong:
```
Health Check
══════════════════════════════════════════════════════

Config file:
  ~/.strudel/config.json ✓

Pantry roots:
  ~/.pi/agent ✓ (readable, 98 primitives)
  ~/agent-core/primitives ✗ ENOENT (directory does not exist)

Embeddings endpoint:
  http://127.0.0.1:10240/v1 ✗ ECONNREFUSED
  fallback: lexical search (L0)

Overall: DEGRADED
  - 1 root missing (22 primitives not indexed)
  - embeddings offline (search quality reduced)
```

---

## Implementation Notes

1. **Register as slash command**, not a tool — this is user introspection, not agent behavior
2. **No LLM calls** — all output is deterministic, runs instantly
3. **Shares state with extension** — reads from the same `fileIndex`, `activated` set, `config`
4. **TUI output** — use Pi's TUI components for tables and formatting
5. **Exit codes** — `/strudel health` returns non-zero on DEGRADED for scripting

---

## Test Strategy

With this in place, users can verify their deployment:

```bash
# Quick smoke test
pi --print "/strudel health"

# Verify your skill got indexed
pi --print "/strudel pantry --search my-skill"

# Verify search quality
pi --print "/strudel search 'what I expect to find'"

# See what strudel is doing to the prompt
pi --print "/strudel surface"
```

The unit tests prove the code works. These commands prove YOUR deployment works.
