# Catalog and reranker evaluation

This evaluates capability selection, not task-completion quality. It uses real
files and the configured embedding endpoint; no fake model responses. It does
not load Pi's runtime tool/command registry, so it must not be presented as a
complete live-session catalog benchmark.

## Reproduce

```sh
npm ci
npm test
npm run check
npm run build

# A new private directory per baseline. Reads ~/.strudel/config.json unless
# STRUDEL_CONFIG_PATH is supplied. No shared embedding-cache writes.
node scripts/evaluate-retrieval.mjs baseline /absolute/private/eval-run

# Optional: seed the private cache from a known snapshot before baseline:
# STRUDEL_EVAL_CACHE=/absolute/cache.json node scripts/evaluate-retrieval.mjs baseline ...

# With TYPESAFE_API_KEY supplied securely in the environment:
node scripts/evaluate-retrieval.mjs jev /absolute/private/eval-run
```

`baseline` writes the task labels before scoring, indexes file capabilities,
records lexical and semantic coverage, and freezes each semantic shortlist.
`jev` consumes that shortlist without retrieving again. `TYPESAFE_MODEL` can
select the evaluation model; the default is the documented `jev-latest` alias.
The current HTTP contract was acquired from https://docs.typesafe.ai/api.md.
Actual billed charges are not inferred from token usage.

Output files refuse overwrite. On a partial failed Jev run, preserve its
request/response evidence and copy `frozen.json` to a new private directory for
a new attempt. Do not tune questions against these held-out results and call
another pass held-out; create a separate development set first.

## What is held fixed

- `test/retrieval-cases.json`: 12 positive tasks, including two requiring multiple
  capabilities, and two negative controls. Labels were authored before scoring.
- Retrieval budget: 20 candidates. Selection budget: 5.
- Each required group lists acceptable alternatives. Complete coverage means
  every group has a selected alternative.
- Candidate snapshots carry SHA-256 hashes, checked before Jev requests.
- Jev sees task and candidate descriptions, not the labels or baseline scores.
- Independent Score questions are batched over one state per task; ranking is
  stable on ties. Confidence is recorded, not treated as permission to act.
- No learned telemetry prior or randomized exploration.

Both selectors rank five items; neither has an abstention policy. The negative
controls expose forced suggestions, not calibrated rejection quality. The
`irrelevantSelections` field means "outside the authored acceptable sets", not
proof that every other capability is useless. This is a small convenience suite,
not an unbiased estimate over all work.

## Observed catalog repair result

On the configured local catalog, parsing real YAML recovered all twelve
block-scalar descriptions previously indexed as `>`. Three collection README
entries disappeared; README-backed primitive directories remain supported.
The index changed from 268 to 265 file primitives (212 to 209 on-demand).

| Positive tasks with complete coverage | Before repair | After repair |
|---|---:|---:|
| Lexical top 5 | 6/12 | 9/12 |
| Semantic top 5 | 5/12 | 8/12 |
| Semantic candidate pool, top 20 | 7/12 | 11/12 |

No positive case lost top-5 coverage. The remaining multi-capability
`source-and-deck` case lacks a required capability even in the top 20; a reranker
cannot repair that missing candidate. The lexical result also prevents claiming
that a model-backed selector has already won.

Warm semantic searches in this file-catalog run took roughly 97–101 ms. The
first search spent roughly 5.2 seconds embedding changed/missing catalog entries.
These are observed samples, not latency guarantees or p95 estimates.

## Live integration and remaining boundary

A post-fix real Pi session discovered and read the Galley skill and correctly
reported its endpoint/authentication syntax. Separately, a real hidden `grep`
tool was discovered, delivered in the next request's `additional_tools`, and
executed successfully. These prove bounded integration behavior, not improved
end-to-end task success across the suite.

The live session with 120 loaded skills also exposed `skill:*` commands through
Pi's registry, expanding the searchable set beyond the file-only evaluator.
Do not mix those candidate populations or call file-cache warmth full-runtime
cache warmth. Duplicate representations are an additional runtime-catalog
question, not silently removed by this repair.

Live Jev comparison is **blocked on credentials**. The endpoint returned HTTP
403, `authentication_error`, "Must supply an API key!" No configured key was
found; no live Jev score, cost, or downstream benefit is claimed. The request
adapter is prepared from the current docs, but its live contract remains
unverified until access is supplied. Paired end-to-end reranker trials depend on
that result and have not been run.

Private raw evidence and the deterministic catalog verifier are stored outside
the repository under the operator's local state directory. No credentials or
provider payloads are committed.
