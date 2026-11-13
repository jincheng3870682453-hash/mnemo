# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-11-13

Three mechanisms that are both cheaper and more human, plus the contribution
infrastructure.

### Added

**Metamemory — feeling of knowing** (`mem.feel()`, `mem.feelLine()`)
- Pre-retrieval probe: one line, three coarse buckets (`no` / `vague` / `yes`),
  at most a pointer. 43% cheaper than a full recall on the benchmark corpus.
- Confidence is query *coverage* (≥0.8 of multi-character tokens), not BM25's
  normalised score — that one is divided by the best hit, so the top hit is
  always 1.0 and would claim certainty on any query.
- Exposed over MCP as `memory_recall` with `probe: true`, keeping the tool count
  at six.

**Retrieval-induced forgetting** (`memory/competition.ts`)
- Recalling a memory quietly demotes its near-duplicates for a few days
  (`1 - 0.4·e^(-days/5)`), then they come back.
- Refuses to suppress a record that is itself frequently retrieved or highly
  salient — the documented failure mode from arXiv:2610.34977.
- New `competition` config block; `ScoredMemory.competition` reports the factor.

**Value-per-token budget fill** (`context/budget.ts`)
- `selectByValuePerToken()` maximises value under a token cost instead of taking
  the top k or truncating a list; the single best item always survives.
- Dropped items are announced in the block, never silently omitted.
- `bootContext()` now fetches 3× the display limit and lets the allocator choose.

**Contribution infrastructure**
- `CONTRIBUTING.md` — the three invariants a change must not break, what fits,
  commit convention, PR checklist, AI-assisted contribution rules
- `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), `SECURITY.md` with the threat
  model that names role-grounding misattribution as in-scope
- Issue templates (bug / feature) and a PR template
- `IDEAS.md` — the unimplemented directions, each with the human phenomenon it
  imitates, how it saves tokens, its failure mode, and a value/risk rating

### Changed

- `README.md` restructured as a landing page: proof above the fold, one-command
  install, deep design moved into `ARCHITECTURE.md` and `IDEAS.md`.
- `Mnemo.recall()` suppresses competitors of the top hit after reinforcing it.

## [0.2.0] — 2026-11-13

Renamed to `mnemo-memory` (the bare name `mnemo` is taken on npm) and shipped the
MCP server, the plugin package, a consolidation benchmark and CI.

### Added

**MCP server** (`mnemo-memory` binary, and the `mnemo-memory/mcp` subpath export)
- Newline-delimited JSON-RPC 2.0 over stdio, no dependencies, no SDK
- Six tools: `memory_recall`, `memory_read`, `memory_write`, `memory_forget`,
  `memory_intend`, `memory_context`
- Config entirely through `MNEMO_*` environment variables
- `serve()` takes an injectable stream + sink, so framing is testable in-process
- Diagnostics go to stderr; stdout carries protocol messages only

**Plugin**
- `plugin/` with `.zcode-plugin/` and `.claude-plugin/` manifests and `.mcp.json`
- `skills/mnemo-memory/SKILL.md` — how to use memory well (write thresholds,
  read depth, attribution, budget notes)
- `commands/memory-status.md` — `/memory-status`
- Committed `payload/dist` so the plugin installs straight from the repository
- `npm run verify:plugin` rebuilds and fails on drift; CI enforces it

**Pluggable semantic retrieval**
- `Embedder` interface, `OpenAIEmbedder` for any OpenAI-compatible `/embeddings`,
  and `HashingEmbedder` as an explicitly non-semantic dev stub
- `VectorIndex`: brute-force cosine, JSONL-persisted, keyed by embedder id so
  switching models invalidates rather than silently mixing spaces
- `vector.mode` = `off` | `auto` | `on`, threshold default 5,000 records
- `recall()` is now async (it may need to embed the query); BM25-only paths still
  resolve immediately

**Benchmark**
- `npm run bench` measures consolidation on/off over a 20×4 synthetic corpus:
  store size, stale beliefs still live, stale top-1 rate, top-1 accuracy,
  context tokens, merge and supersede counts
- `consolidation.enabled` config flag, so the least-proven mechanism can be
  switched off

**CI**
- GitHub Actions: Node 20/22/24 on Ubuntu, Node 24 on Windows, MCP handshake
  through a real pipe, plugin payload freshness, benchmark regression, package
  contents
- `Publish` workflow on `v*` tags with npm provenance

### Fixed

- `slugify()` collapsed CJK input to its bare ASCII remainder, so
  `"回复风格-base"` and `"编辑器-base"` both became `base` and records from
  different topics silently overwrote each other. Non-ASCII input now always
  carries a hash of the full text.
- `contradicts()` scanned the whole abstract for negation markers, so a predicate
  that itself contained one (`…不打 bundle`) made both sides look negative and hid
  a real change of mind. It now compares similarity after stripping negations and
  requires the negation counts to differ.
- `decisionEligible()` only checked `hop` and `type`, while `bindAttribution()`
  warned that an unbound preference would not be actionable. The check now
  enforces the subject binding, so the warning is true.
- In-place updates write to the location discovered by the directory scan
  (`FileStore.update`) and never construct a path.

## [0.1.0] — 2026-11-13

First release. Zero runtime dependencies; Node 20+.

### Added

**Storage**
- Markdown-first store: `facts/`, `episodic/`, `persona/`, `intentions/`, `archive/`, `session/`
- Disposable index — `rm -rf store/index` loses no knowledge (enforced by test)
- Atomic writes (temp file + rename); corrupt records are skipped, never fatal
- Containment-checked path handling; slug validation; traversal neutralisation

**Encoding**
- Dual-trace encoding (gist + verbatim) per fuzzy-trace theory
- Model-assisted gist extraction with guaranteed heuristic fallback (encoding never throws)
- `abstract` capped at write time so the L0 handle stays cheap

**Memory dynamics**
- Power-law retention `R = (1 + t/S)^-d` with three-tier state: active / faint / archived
- Spacing effect: stability ×1.3 on each recall; initial stability derived from salience
- Confidence erosion on reconstruction
- `daysUntil()` inversion of the retention curve

**Retrieval**
- Four-signal scoring: recency, importance, relevance (BM25), goal fit
- Cue-triggered recall (entity / topic / time / emotion / goal) with no query required
- `asOf` temporal queries
- L0 pointers only — bodies require an explicit, costed read
- Hand-written BM25 with CJK unigrams + bigrams; no vectors by default

**Consolidation**
- Four-way relation: duplicate / refines / supersedes / unrelated
- Contradiction checked before duplication
- Supersede never deletes; `invalidAt` + back-link; `--as-of` still answers
- `consolidate()` archives decayed records only — never runs automatically

**Attribution (security)**
- `subject` / `speaker` / `addressee` / `hop` bound at write time
- Second-hand preferences demoted to `hearsay` with a visible note
- `decisionEligible()` gates on hop, type, and subject binding
- Regression test for role grounding misattribution (arXiv:2610.38209)

**Context**
- `assemble()` returns a byte-stable `prefix` and a volatile `suffix`
- `stableToolBlock()` for deterministic tool schema serialisation
- Per-layer token budgets with loud warnings, never silent truncation
- `buildMemoryIndex()` caps the resident index

**Prospective memory**
- Intention records with `time@` and `event@` triggers
- `due()`, `pendingLines()` with human-readable "还有 N 天"

**Offloading**
- Threshold-based tool-output offload to `session/<sid>/offload-<ref>.txt`
- Line-ranged `readOffload()` paging

**Interfaces**
- `Mnemo` facade with six primary operations
- CLI: `write`, `recall`, `read`, `reconstruct`, `forget`, `cue`, `intend`, `due`, `ctx`, `stats`, `consolidate`
- `OpenAICompatibleLLM` adapter (DeepSeek / GLM / Moonshot / vLLM / Ollama)
- `NullLLM` default so everything works offline

### Known limitations

- Consolidation quality has not been shown to predict downstream accuracy
  (ρ = −0.24 in arXiv:2609.33013); the default is deliberately conservative.
- Decay and signal-weight defaults are uncalibrated starting points.
- CJK entity extraction covers only explicitly marked entities; register names
  with `cue()` rather than relying on inference.
- Vector retrieval is not implemented; it is an appropriate addition above
  roughly 5,000 records.

[0.1.0]: https://github.com/jincheng3870682453-hash/mnemo/releases/tag/v0.1.0
[0.2.0]: https://github.com/jincheng3870682453-hash/mnemo/releases/tag/v0.2.0
[0.3.0]: https://github.com/jincheng3870682453-hash/mnemo/releases/tag/v0.3.0
