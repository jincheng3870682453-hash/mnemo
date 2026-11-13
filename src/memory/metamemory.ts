/**
 * Metamemory: knowing whether you know, before you look.
 *
 * Cognitive psychology calls this the *feeling of knowing* (Nelson & Narens,
 * 1990): an anticipatory, pre-retrieval signal. It is cheap and imperfect, and
 * that is exactly why it is useful — it stops you from paying for a retrieval
 * when the honest answer is "I have no idea".
 *
 * Why this belongs in a token-thrifty memory layer
 * ------------------------------------------------
 * A full `recall` costs a round trip and ~30 tokens per hit, and the caller may
 * then `read` a body. A probe costs one short line. When the store has nothing,
 * the probe replaces a recall + a read + a disappointed model with "nothing".
 *
 * Research caveat, taken seriously: pre-retrieval confidence in LLMs is *weakly
 * calibrated* (NeurIPS 2026, "Feeling of Knowing in Large Language Models"), and
 * a hallucinated answer can retain elevated confidence. So this never claims
 * certainty — it reports a coarse three-way feeling plus a hint, and the caller
 * decides whether to spend the real retrieval.
 */

import type { Cue, MnemoConfig, MemoryRecord } from '../types.js';
import { cueToString } from '../types.js';
import type { BM25Index } from '../index/bm25.js';
import { retention, tier } from './decay.js';
import { tokenize } from '../util/text.js';

/** Coarse anticipatory feeling. Deliberately three values, not a fake precision. */
export type Feeling = 'no' | 'vague' | 'yes';

/**
 * Query coverage needed before the probe claims "yes".
 *
 * Set high on purpose. The research is blunt that pre-retrieval confidence in
 * LLMs is weakly calibrated, and the cost of a wrong "yes" (a retrieval spent for
 * nothing) is smaller than a wrong "vague" only if the caller still checks. 0.8
 * means "you match nearly everything that was asked", not "you share a word".
 */
const COVERAGE_THRESHOLD = 0.8;

export interface MetamemoryHint {
  name: string;
  abstract: string;
  path: string;
  /** Age in days, so the caller can judge freshness without a read. */
  ageDays: number;
}

export interface MetamemoryProbe {
  feeling: Feeling;
  /** Present for `vague` and `yes`: the most likely memory, as a pointer. */
  hint?: MetamemoryHint;
  /** How many records matched at all. Zero implies `feeling === 'no'`. */
  candidates: number;
  /** Tokens saved versus issuing a full recall for the same query. */
  savedTokens: number;
  /** One short sentence the model can act on. */
  reason: string;
}

export interface ProbeInput {
  index: BM25Index;
  records: ReadonlyArray<MemoryRecord>;
  query: string;
  cues?: Cue[];
  now: Date;
  config: MnemoConfig;
  pathOf(name: string): string;
}

/** Tokens a recall block would have cost for `n` hits. Mirrors renderL0's shape. */
function recallCost(n: number): number {
  return n === 0 ? 0 : 20 + n * 30;
}

/**
 * How much of the query this record actually covers, 0..1.
 *
 * Not BM25's normalised score: that is divided by the best hit in the result set,
 * so the top hit is *always* 1.0 and would report certainty on any query at all.
 * Multi-character tokens only — CJK unigrams match almost anything and would
 * inflate confidence.
 */
function queryCoverage(queryTokens: ReadonlyArray<string>, record: MemoryRecord): number {
  if (queryTokens.length === 0) return 0;
  const available = new Set(tokenize(`${record.abstract} ${record.body}`));
  let hit = 0;
  for (const token of queryTokens) if (available.has(token)) hit++;
  return hit / queryTokens.length;
}

function contentTokens(text: string): string[] {
  return Array.from(new Set(tokenize(text).filter((t) => Array.from(t).length >= 2)));
}

export function probeMetamemory(input: ProbeInput): MetamemoryProbe {
  const { index, records, query, now, config } = input;
  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return {
      feeling: 'no',
      candidates: 0,
      savedTokens: 0,
      reason: 'empty query: nothing to feel of knowing',
    };
  }

  const byName = new Map(records.map((r) => [r.name, r]));
  const queryTokens = contentTokens(trimmed);
  const hits: Array<{ hit: { id: string; score: number; norm: number }; record: MemoryRecord }> = [];
  for (const hit of index.search(tokenize(trimmed), 50)) {
    const record = byName.get(hit.id);
    if (!record) continue;
    if (record.invalidAt) continue;
    if (tier(record, now, config.decay) === 'archived') continue;
    // BM25 indexes CJK unigrams, so a single shared character ("子" inside
    // "帖子") produces a candidate. That is fine for search and wrong for a
    // probe: require at least one *multi-character* token in common, otherwise
    // the probe would feel confident about everything.
    if (queryCoverage(queryTokens, record) === 0) continue;
    hits.push({ hit, record });
  }

  if (hits.length === 0) {
    return {
      feeling: 'no',
      candidates: 0,
      savedTokens: recallCost(1),
      reason: 'nothing in memory matches this: say you do not know rather than guessing',
    };
  }

  const best = hits[0];
  const strength = retention(best.record, now, config.decay);
  const ageDays = Math.max(
    0,
    Math.round((now.getTime() - new Date(best.record.validFrom).getTime()) / 86_400_000),
  );

  // Confidence is query *coverage*, not relative rank: a record that matches one
  // incidental word should not feel like knowledge.
  const coverage = queryCoverage(queryTokens, best.record);
  const confident = coverage >= COVERAGE_THRESHOLD && strength > config.decay.activeThreshold;
  const feeling: Feeling = confident ? 'yes' : 'vague';

  const hint: MetamemoryHint = {
    name: best.record.name,
    abstract: best.record.abstract,
    path: input.pathOf(best.record.name),
    ageDays,
  };

  const reason = confident
    ? 'this looks like something you know: read it before asserting detail'
    : 'you half-remember something like this: read it to check, or say it is fuzzy';

  return {
    feeling,
    hint,
    candidates: hits.length,
    savedTokens: Math.max(0, recallCost(hits.length) - 25),
    reason,
  };
}

/** Render a probe as the single line the model actually sees. */
export function renderProbe(probe: MetamemoryProbe): string {
  if (probe.feeling === 'no') return `[memory] ${probe.reason}`;
  const hint = probe.hint;
  if (!hint) return `[memory·${probe.feeling}] ${probe.reason}`;
  return (
    `[memory·${probe.feeling}] ${hint.abstract} · ${hint.ageDays}d · ${hint.path}` +
    ` — ${probe.reason}`
  );
}

/** Cue matching used by callers that want to probe without a text query. */
export function cueSignature(cues: ReadonlyArray<Cue>): string {
  return cues.map(cueToString).join(' ');
}
