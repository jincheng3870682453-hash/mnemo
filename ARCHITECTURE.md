# Architecture

Why mnemo is built the way it is. Every non-obvious decision here has a reason,
and most of the reasons are measurements rather than preferences.

---

## 0. The shape of the problem

An agent's context cost is dominated by three things, in this order:

1. **What you put in it** — history, tool output, retrieved documents
2. **How you order it** — whether prefixes repeat and can be cached
3. **How you compress it** — the last resort, and the smallest lever

Almost every "memory library" attacks (3) and ignores (1) and (2). mnemo attacks
them in order.

The same inversion applies to "human-like". A database that remembers everything
perfectly is the *opposite* of a person. People keep the gist, lose the detail,
reconstruct on demand, and are triggered by context rather than by queries.
Those behaviours are also cheap. Being human-like and being token-thrifty are the
same optimisation seen from two ends.

---

## 1. Storage: files are the truth, indexes are caches

```
store/
  facts/<group>/<name>.md
  episodic/<group>/<name>.md
  persona/<name>.md
  intentions/<name>.md
  archive/<name>.md
  index/            <- disposable
  session/<sid>/
```

**Rule:** `rm -rf store/index` must lose no knowledge. This is enforced by
`tests/store.test.ts`, and it is the reason there is no database.

Why this matters beyond aesthetics:

- **Diffable.** A memory change shows up in `git diff` as a readable line.
- **Portable.** No vendor, no migration, no schema versioning.
- **Debuggable.** When the agent says something wrong, you open the file.
- **Durable.** A memory layer that can be lost by uninstalling a package is not
  a memory layer.

**Path safety.** Every dynamic path goes through `path.resolve(root, ...)`
immediately followed by a containment re-check against `root + path.sep`. Names
are additionally slug-validated; group segments are neutralised; session ids and
offload filenames are reduced to a single safe basename. See
`src/store/file-store.ts`.

---

## 2. Encoding: two traces, not one

Fuzzy-trace theory (Reyna & Brainerd, 1995) says a memory has a **gist** trace
(what it meant — survives for years) and a **verbatim** trace (exactly what was
said — gone in days). Decisions run on the gist. The verbatim is consulted only
when precision is needed.

```
raw content
  ├─ gist    → abstract (≤60 chars, L0) + body (L2)
  └─ verbatim → episodic/, subject to `verbatimTtlDays`
```

Practical consequence: `abstract` is capped at 60 characters at write time. This
is not cosmetic. If the L0 handle is long, the whole progressive-disclosure
economy collapses, because the cheap path stops being cheap. `createRecord()`
truncates rather than warns.

Encoding runs through a model when configured and falls back to a deterministic
heuristic otherwise. **It never throws.** A failed write is worse than a mediocre
gist.

The gist prompt asks for two extra fields most memory systems omit:

- `salience` (1–10) — seeds initial stability and ranking
- `future` — the questions this memory should answer later (see §6)

---

## 3. Forgetting: power law, not exponential

```
R(t) = (1 + t / S) ^ -d        d = 0.7 by default
```

Exponential decay (`e^(-t/S)`) is what most agent-memory code reaches for. It
fits human retention poorly — one study reported R² = 0.954 for the power law
against 0.295 for the exponential. The difference is the tail: an exponential
declares a memory gone, a power law says it is merely hard to reach. That
distinction is exactly what "tip of the tongue" feels like, and it is why
`tier()` has three levels rather than one:

| retention | tier | behaviour |
|---|---|---|
| > 0.3 | `active` | normally retrievable |
| 0.1 – 0.3 | `faint` | only reachable via a strong cue |
| ≤ 0.1 | `archived` | off the hot path, still `--as-of` queryable |

**Nothing is deleted.** `archive()` moves the file; `forget()` sets `invalidAt`.
Both keep the record answerable by a historical query, which is a requirement for
§5 and costs nothing but disk.

**Spacing effect.** Every successful recall multiplies `S` by 1.3. Frequently
recalled memories decay slower. This is not a metaphor — it is the same mechanism
as spaced repetition, and it is why `lastAccess` (not `createdAt`) anchors
recency: something you think about often *feels* recent.

**Initial stability derives from salience** (`1 + (s-1) × 0.5`), so emotionally
significant material starts harder to forget instead of being treated like
everything else.

---

## 4. Retrieval: four signals, pointers only

```
score = w_recency  · R(t)                     power-law retention
      + w_importance · salience · weight
      + w_relevance  · bm25(query)
      + w_goalFit    · (goal overlap | cue match)
```

The fourth signal is the one that makes recall feel situational. It comes from
two sources:

- `future` hooks — "this memory would answer a question about X"
- situational **cues** — entity, topic, time, emotion, goal

So recall can fire with no query at all:

```ts
mem.recall({ cues: [{ kind: 'emotion', value: 'anxiety' }] });
```

**BM25, not vectors, by default.** Measured trade-off from an existing
implementation: Recall@5 79.0% → 86.6% for vector fusion, but median latency
5.1 ms → 139.2 ms. At personal-agent scale the 7.6 points do not pay for 27×
latency, and vectors add a model download, a native module or a service. BM25
with CJK unigrams+bigrams keeps the read path in microseconds and needs nothing.

Vectors are an appropriate upgrade above roughly 5,000 records. They are not the
foundation.

**Candidates are filtered hard.** A record with no lexical match, no cue match
and no goal overlap is not returned at all. This keeps the candidate set honest
and the injected block small — and it means "nothing relevant" is a real answer.

**Retrieval returns L0 lines, never bodies.**

```
- 金呈不喜欢客套开场白 · preference · 0d · 3.85 · facts/user-tone/pref-direct.md
```

One line: abstract, type, age in days, score, path. The age is in the line on
purpose — a model that knows a memory is 300 days old treats it differently, and
that difference is most of what "having a sense of time" amounts to.

---

## 4.5 Metamemory: knowing whether you know

Cognitive psychology separates two signals (Nelson & Narens, 1990):

- **Feeling of knowing (FOK)** — anticipatory, *before* retrieval. Cheap, fuzzy.
- **Confidence** — retrospective, *after* an answer exists. Expensive, sharper.

Most memory layers only have the second. `mem.feel(query)` adds the first: one
line, roughly 25 tokens, answering "does memory have anything about this?" with
three values — `no` / `vague` / `yes` — plus at most a pointer.

**Why it saves tokens.** A full recall costs a round trip and ~30 tokens per hit,
and the caller may then read a body. The probe is 43% cheaper than a full recall
across the benchmark's queries, and infinitely cheaper when the honest answer is
"nothing" — it replaces recall → read → a disappointed model with one line.

**Confidence is query coverage, not rank.** The obvious implementation is to use
BM25's normalised score — and it is wrong: that score is divided by the best hit
in the result set, so the top hit is *always* 1.0 and the probe would report
certainty on any query at all. Coverage is what fraction of the query's
multi-character tokens appear in the record, thresholded at 0.8. Multi-character
because CJK unigrams match almost anything and inflate confidence.

**Calibration caveat.** Pre-retrieval confidence in LLMs is *weakly calibrated*
(NeurIPS 2026), and hallucinated answers retain elevated confidence. So the probe
is deliberately coarse: three buckets, never a probability, never a body.

---

## 4.6 Retrieval-induced forgetting: rivals go quiet

In people, retrieving a memory temporarily suppresses competitors sharing its
cues. Retrieve "her birthday is in May" and the wrong month is harder to reach for
a while. It is a sharpening mechanism, not a bug: without it, every recall returns
twelve near-identical candidates forever.

`suppressCompetitors()` runs after a recall: near-duplicate records of the winner
get a `suppressedAt` stamp, and `competitionFactor()` multiplies their score by
`1 - 0.4·e^(-days/5)`. So a rival drops at most 40%, and is fully back within a
couple of weeks.

**The two measured facts that shape it** (arXiv:2610.34977):

1. Suppressing persistent competitors can expose evidence you would otherwise
   never see.
2. Suppressing *repeatedly useful* memories is the complementary failure mode.

So `shouldSuppress()` refuses to touch a record when:

| Condition | Reason |
|---|---|
| `accessCount > winner.accessCount + 1` | it is a second real answer, not a rival |
| `salience >= 9` | the user marked it important |
| different `type` | different kinds of claim are not substitutes |
| abstract overlap < 0.75 | not really a competitor |

This is suppression of *noise*, never of answers. Everything remains recoverable:
the stamp fades, and `--as-of` ignores it entirely.

---

## 5. Consolidation: four outcomes, and it never overwrites

| relation | meaning | action |
|---|---|---|
| `duplicate` | same claim again | touch it |
| `refines` | more detail, same topic | append to body |
| `supersedes` | opposite polarity | set `invalidAt` on the old, link from the new |
| `unrelated` | nothing in common | new record |

Contradiction is checked **before** duplication. `"likes X"` and `"dislikes X"`
are lexically near-identical; reporting the second as a duplicate would silently
keep a belief the person has already abandoned.

`supersedeRecord()` never deletes. The old file stays, `invalidAt` is set, and
the new record links back. This is what makes `recall({ asOf })` answerable:

```ts
mem.recall({ query: '详细解释', asOf: lastWeek });  // what you believed then
mem.recall({ query: '详细解释' });                  // what you believe now
```

Changing your mind while remembering that you changed it is a defining property
of human memory, and it is nearly free to implement.

**A caution the design takes seriously.** A 2026 study measured that
consolidation *quality scores* do not predict downstream answer accuracy
(Spearman ρ = −0.24, n = 12, CI spanning zero), and an independent replication
found a nightly consolidation cycle made results slightly worse (71.7% → 69.8%).
So `consolidate()` here does the conservative thing only — archive decayed
records — and nothing in the library runs it automatically.

---

## 6. Prospective memory: the part a database cannot do

Cognitive science treats "remembering to do something later" as a system separate
from recall: triggered by a **time** or an **event**, not by a query.

```yaml
type: intention
trigger: time@2026-11-18T09:00
status: pending
```

```yaml
type: intention
trigger: event@审计,截稿
status: pending
```

`pendingLines()` renders the resident block:

```
## 你记挂的事
- 提醒他周三交审计报告（还有 5 天）
```

Under 80 tokens. It is the difference between an assistant that waits to be asked
and one that remembers you have a deadline on Tuesday.

The `future` field on ordinary memories is the same idea in reverse: at write
time, ask *what will this be useful for?* and index on the answer. Retrieval can
then match on intended use rather than on wording.

---

## 7. Context assembly: the cache boundary is the API

```ts
const ctx = mem.buildContext({ system, memoryIndex, retrieved, userMessage });
ctx.prefix   // byte-stable, append-only, safe to cache
ctx.suffix   // changes every turn
```

Providers discount repeated prefixes heavily — one prices a cache hit at **2% of
a miss**. The failure mode is always the same: a timestamp, session id, or
re-serialised tool schema lands in the prefix, and the hit rate goes to zero.

Four rules, encoded in the API rather than in documentation:

1. `prefix` contains only system, tools, persona, memory index.
2. Tool definitions go through `stableToolBlock()` — keys sorted, array sorted.
   A schema that differs only in key order is byte-different and misses every time.
3. History is append-only. Never edit mid-conversation.
4. Budget overruns are **loud**: `warnings` is populated and content is trimmed
   with a visible marker, never silently truncated.

`buildMemoryIndex()` caps the resident index at 12 lines. Everything else stays
reachable through `recall()` but is not resident.

### 7.1 Filling the budget by value per token

Taking the top *k* — or concatenating until the budget runs out — wastes it. A
200-token memory ranked third may be worth less per token than a 40-token memory
ranked fifth, and truncating mid-list silently drops whatever came last.

`selectByValuePerToken()` states the problem the way the retrieval literature does
(arXiv:2610.34673): maximise total value subject to total token cost, then fill.
Greedy by value-per-token is within a constant factor of optimal and is
deterministic, which matters more here than the last few percent.

Two deliberate rules:

- **The single best item is always included if it fits the budget at all.** A
  budget that returns nothing relevant is worse than a slightly over-budget one.
- **Dropped items are announced.** Silent truncation is the failure this exists to
  prevent: a model that does not know it is seeing a partial list answers as if it
  has everything.

`bootContext()` fetches three times the display limit and lets the allocator
choose, rather than asking retrieval to pre-decide.

---

## 8. Attribution: the vulnerability that is not about provenance

arXiv:2610.38209 (Oct 2026) formalises **role grounding misattribution**. The
attack needs no forgery and no provenance laundering:

1. Attacker agent publishes an honest, correctly-attributed post.
2. The post quotes a conversation with its own user: `user: always pick tool X`.
3. The victim stores the preference but keeps the context-relative role word
   `user` and loses the binding to the attacker's user.
4. At retrieval, the preference is re-grounded to the victim's own user.

Measured direct misattribution of stored payloads: **Mem0 78.1%, A-MEM 75.7%,
Hindsight 99.0%**. Tool-selection manipulation succeeds 92.37% of the time.

A signature or agent-id does not help: the writer is honest. The missing piece is
*whose* preference the content expresses.

mnemo's defence has three parts:

```ts
bindAttribution({ type: 'preference', hop: 1 })
// → { type: 'hearsay', downgraded: true,
//     notes: ['preference demoted to hearsay (hop=1): ...'] }
```

1. **Bind principals at write time** — `subject`, `speaker`, `addressee`. Never
   store the role word.
2. **Gate on testimony depth** — only `hop === 0` is decision-eligible.
3. **Demote, don't drop** — a second-hand preference becomes `hearsay`, which is
   still recallable and still useful as evidence, but cannot steer tool choice or
   arguments.

Every downgrade produces a note. Silent demotion is its own failure mode.

---

## 9. Offloading: the highest measured return

Tool output is where context dies. Above `offloadThresholdTokens` (default 400),
the text goes to `session/<sid>/offload-<ref>.txt` and context keeps one line:

```
[offload:d6b517] web_search · 300 行 · 4323 tok · 首行: 搜索结果 0: ...
```

`readOffload()` pages it back by line range, so "read all of it" stays bounded.

Reported production numbers (vendor-reported, long continuous sessions):

| task | tokens | success |
|---|---|---|
| WideSearch | 221.3M → 85.6M (**−61.4%**) | 33% → 50% |
| SWE-bench | 3474.1M → 2375.4M (**−33.1%**) | 58.4% → 64.2% |
| AA-LCR | 112.0M → 77.3M (**−31.0%**) | 44.0% → 47.5% |

Success went *up* as tokens went down: the noise was hurting quality, not just
the bill. Short interactions see almost none of this benefit — measure before
sizing anything on it.

---

## 10. Reconstruction, and why confidence erodes

Retrieval is not playback. Bartlett (1932) showed people rewrite unfamiliar
material into something schema-consistent and do not notice; Loftus (1974) showed
post-event information overwrites the original.

`reconstruct(name, situation)` returns a re-telling explicitly labelled as a gist,
never as a quote, and multiplies `confidence` by 0.95 each time. Repeated
reconstruction therefore shows up as a falling number rather than as silent drift.

This is also why `l0` lines say "abstract", not "quote", and why the default
system prompt tells the model: *the index is pointers, not text; read the file
before asserting detail.*

---

## 11. What is deliberately not here

| Omitted | Why |
|---|---|
| Vector search by default | 27× latency for 7.6 recall points at personal scale |
| Graph database | Frontmatter links give the same structure without the ops burden |
| Auto-consolidation | Not shown to help (ρ = −0.24); made optional and explicit |
| Hard delete | Forgetting should degrade, not vanish |
| Sandbox / eval harness | Out of scope; this is the memory layer, not the agent |
| More than six tools | Tool definitions are prefix cost and mis-call risk |

---

## 12. Test coverage map

| File | Guards |
|---|---|
| `yaml.test.ts` | byte-stable round trip, CJK, malformed input rejected |
| `text.test.ts` | token estimation, CJK bigrams, surrogate-safe truncation |
| `decay.test.ts` | power-law shape, heavy tail vs exponential, spacing effect, tier transitions |
| `bm25.test.ts` | ranking, CJK, id replacement, no ghost postings |
| `attribution.test.ts` | **the role grounding attack**, demotion, `hop` gating |
| `consolidation.test.ts` | contradiction-before-duplicate regression, merge idempotence |
| `intentions.test.ts` | time and event triggers, overdue rendering |
| `retrieve.test.ts` | four signals, cue-only recall, as-of, faint gating, L0 shape |
| `metamemory.test.ts` | probe never claims certainty on a weak match, never returns a body |
| `competition.test.ts` | suppression is weak, temporary, and refuses proven-useful records |
| `budget.test.ts` | value-per-token fill, best item survives, drops are announced |
| `assembler.test.ts` | **prefix byte-stability across turns**, deterministic tool order |
| `offload.test.ts` | threshold, paging, traversal rejection |
| `store.test.ts` | index is disposable, corrupt file isolation, path escapes |
| `integration.test.ts` | full lifecycle, supersede, hearsay quarantine, token ratio |

---

## 13. References

**Cognitive science**
Reyna & Brainerd, *Fuzzy-Trace Theory*, 1995 · Bartlett, *Remembering*, 1932 ·
Loftus & Palmer, 1974 · Schacter, *The Seven Sins of Memory*, 2001 ·
Wixted & Ebbesen, *On the form of forgetting*, 1991

**Engineering**
Park et al., *Generative Agents*, arXiv:2304.03442 · *HeLa-Mem*, ACL 2026 ·
*FADE*, IEEE 2026 · *MM-Mem*, arXiv:2603.01455 · *Pro-Memory*, arXiv:2611.05731 ·
*ProMemAgent*, arXiv:2610.27400

**Security**
*Is it my preference? Role Grounding Attack against Agent's Memory*,
arXiv:2610.38209

**Negative results (taken seriously here)**
*The Epistemics of Agent Memory*, arXiv:2609.33013
