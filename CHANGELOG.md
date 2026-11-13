# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
