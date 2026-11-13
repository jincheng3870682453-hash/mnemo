# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-11-13

情节记忆：事实记的是「什么是真的」，情节记的是「发生过什么」。

### Added

**Episodes**（`checkpoint()` / `episodes()` / `episodeLines()`）
- `checkpoint()` 把一段对话压成一条 episode：摘要即标题、即 L0 手柄、即文件名来源，
  可选链接到它涉及的事实记录。
- `episodes()` / `episodeLines()` 返回一行一条的列表（标题 · 日期 · 路径）——
  **列出来就是索引**，回答「上次那次是什么时候」不需要读任何正文、不需要查询。
- 新增 `episode` 记忆类型，落在 `episodic/` 下。
- `episode` 不参与合并：两次聊同一个话题是两件事，不是重复陈述。
- CLI 新增 `checkpoint` 与 `episodes` 两个命令。

**为什么不是 JSON 文件名当摘要**
- 中文文件名跨平台会被 zip / git 搞乱；本仓库就出过一类 bug，削掉 CJK 之后
  20 个主题塌成同一个文件名。
- JSON 把正文的换行变成 `\n` 汤，diff 不可读，不能手改。
- 文件名列表只能列、不能查；BM25 可以。
- 文件名要唯一就得加哈希后缀，加了就不像概括了。

所以文件名仍是 slug，摘要仍是第一行；真正有用的那部分——**便宜的列表**——由
`episodes()` 提供。

### Changed

- 合并候选集中排除 `episode` 类型。
- 记忆类型枚举、目录映射、默认前瞻钩子同步支持 `episode`。

## [0.5.0] — 2026-11-13

DSH Go 插件。`dsh-go/` 是一个独立的 npm 包（`mnemo-dsh-go`），按 DSH Go 的原生插件协议声明界面。

### Added

**DSH Go 原生插件**（`dsh-go/`，独立包 `mnemo-dsh-go`）
- 三个界面，都只放指针：输入框上方一行状态（`记忆 12 · 惦记 2`）、两条胶囊动作
  （记住这句 / 想起来）、一个面板（最近记录、可作依据数、一键自检）。
- `remember` 同步返回 toast，写入在后台完成——不占用 3 秒的效果窗口。
- `recall` 走协议里的延后效果（`pending` + `result`），先跑元记忆探针，确认「不知道」
  就直接说没有，省掉一次完整检索；命中则把 L0 指针插回输入框，**绝不自动发送**。
- 面板视图只用 v1 组件，数据里只有摘要、类型、年龄，没有正文。
- 库的编译产物随包内嵌（`lib/mnemo/`），手机上安装不需要构建步骤。

**离线插件检查器**（`npm run check:dsh-go`）
- 按官方 `dsh-go-plugin` 技能文档的约束做 lint：插槽上限、标签字数、id 字符集与
  唯一性、序列化 ≤16 KiB、`strip` 与 `panel` 的交叉引用、effect 白名单。
- 然后用假桥接真点一遍每个 handler：空草稿被拒、写入生效、状态条 ≤24 字、
  延后效果返回可插入内容、面板视图可渲染且 ≤32 KiB。
- 权威检查器仍是 App 自带的 `kit/bin/check.mjs`；这个脚本让 CI 在没有手机的情况下
  也能拦住同一类错误，规则是从文档逐条复刻的，不是猜的。

### Changed

- `npm run verify:plugin` 同时校验 `plugin/` 与 `dsh-go/` 的产物是否与源码一致。
- 根 README 的「五种用法」加入 DSH Go。

## [0.4.0] — 2026-11-13

Two mechanisms borrowed from my own other projects, both of which close a hole
the 0.3.0 design had left open.

### Added

**Reversible consolidation** (from `token-sage`'s snapshot-and-rollback pattern)
- Every `refines` and every `supersedes` writes a snapshot to
  `history/<name>/<timestamp>.md` before the record is rewritten.
- `mem.history(name)` lists versions, `mem.restore(name, version?)` puts one back
  and clears `invalidAt`.
- `history/` is excluded from the record scan, so preserved versions never show up
  as memories.
- Rationale: a config flag protects the *next* write, not the merge that already
  destroyed a body. Consolidation is the least-proven mechanism here (ρ = −0.24),
  so it should be reversible, not merely switchable.

**Empirical confidence** (from `shepherd-microdemo`'s credit × decoy verification)
- `mem.selfTest()` samples records deterministically, uses each record's own
  abstract as a query, and moves `confidence` toward whether it actually came back
  first (EMA).
- The caveat ships in the return value: self-retrieval is easier than a real
  query, so `hitRate` is a health signal and corruption detector, not an estimate
  of user-level recall.

### Fixed

- `contradicts()` treated any added negation as a reversal, so refining a claim
  with a subordinate clause ("…用 tsc" → "…用 tsc 且不打包") silently invalidated
  the original instead of merging. It now requires the stripped claims to be ≥0.85
  similar, i.e. the only substantive difference must be the polarity itself.

### Changed

- `IDEAS.md` gained a section of mechanisms transplanted from my other repos
  (decoy verification, snapshot rollback, half-duplex optimism, SimHash dedupe and
  topic-shift detection, HMAC audit chain, would-do logging, offline parameter
  fitting), and the roadmap was reordered around them.

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
[0.4.0]: https://github.com/jincheng3870682453-hash/mnemo/releases/tag/v0.4.0
[0.5.0]: https://github.com/jincheng3870682453-hash/mnemo/releases/tag/v0.5.0
[0.6.0]: https://github.com/jincheng3870682453-hash/mnemo/releases/tag/v0.6.0
