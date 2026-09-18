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
cannot repair that missing candidate. At this stage, lexical selection beat the
embedding order; the live Jev comparison below tests an additional ranking step.

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

## Live Jev result — credential boundary cleared

The initial unauthenticated probe returned HTTP 403. The operator subsequently
supplied access for this evaluation; the credential was used through the process
environment and was not saved in repository files or evaluation reports.

All 14 frozen-candidate requests succeeded, resolving `jev-latest` to
`jev-1.13.0`. Complete positive-task top-5 coverage rose from **8/12 to 11/12**,
with no positive-case regressions. The remaining failure was the already-known
missing candidate. Requests averaged **263 ms**, ranging from 169 to 748 ms.
Usage: 56,556 input tokens and 4,116 output tokens. At the acquired public rate
of $0.042 per million input tokens (output free), estimated scorer cost was
**$0.002375**, not a measured invoice. Source: https://docs.typesafe.ai/models.md.

This was not flawless judgment: Jev scored an unrelated `tool/pdf` candidate
2.78/3 with confidence 0.78 on the symbol-impact case. Its catalog description
was generic imperative text. The observation does not establish the error's
cause, but it rules out treating typed output or confidence as correctness.

## Paired Pi outcome pilot

Three new, predeclared read-only capability-instruction tasks were run twice per
arm: cross-file caller/impact commands, source search with unknown identifiers,
and combined browser-console/Word tracked-change instructions. Each required
actual successful source reads, source citations, and specific source-grounded
commands. An external deterministic checker inspected tool results and final
answers. These were completed instruction-retrieval tasks, **not** code edits,
browser operation, or DOCX artifact production.

Each pair received the same hashed initial candidate pool. The main model and
settings were fixed. Initial selections were supplied before main-model
inference; a real discovery tool allowed recovery if the shortlist was
insufficient. Jev was called live inside its arm, including on any recovery
search. Thus this tests a proposed preselection path, not an installed change
to Strudel's existing gateway. Later discovery queries could diverge. Order was
baseline/Jev for repetition one, then Jev/baseline for repetition two.

| Across six runs per arm | Embedding order | Jev order |
|---|---:|---:|
| Independently checked success | 6/6 | 6/6 |
| Main-model requests | 14 | 12 |
| Recovery discovery calls | 2 | 0 |
| Summed selection-to-answer time | 70.835 s | 70.458 s |
| Estimated model + scorer cost | $0.365508 | $0.345858 |

Jev removed one recovery/model round trip in each combined browser/Word run,
saving 3.06 s and 2.21 s there. It did not consistently speed up the simple
single-capability tasks. Overall elapsed time was effectively tied; estimated
cost was 5.4% lower, not remotely a demonstrated 100x improvement.

Timing includes actual scorer calls, session setup, main-model inference, reads,
and recovery retrieval; shared initial retrieval is measured separately and
excluded from the table. Cache reads were unequal (8,448 baseline versus zero
Jev), so these are observed conditions, not a controlled cold-cache result.
Pi costs use its model catalog; scorer cost uses the public rate above. Actual
attributable billing remains UNKNOWN. Six paired observations over three tasks
are not evidence of statistical significance or general coding-task benefit.

**Decision:** keep Jev as an opt-in evaluation candidate, not a default runtime
dependency or authorization gate. The ranking improvement is demonstrated; the
bounded multi-capability recovery benefit warrants further workload validation,
not a blanket speed claim. No production reranker or compaction change was made.

Private raw evidence and the deterministic catalog verifier are stored outside
the repository under the operator's local state directory. No credentials or
provider payloads are committed.
