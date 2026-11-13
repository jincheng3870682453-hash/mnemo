/**
 * Retrieval: four signals, cue-triggered, returns pointers not content.
 *
 *   score = w_recency * R(t)                    power-law retention
 *         + w_importance * salience * weight    was it worth remembering
 *         + w_relevance * bm25(query)           does it match what was asked
 *         + w_goalFit * (goal overlap | cues)   is it useful for what we are doing
 *
 * The fourth signal is the one most memory libraries lack, and it is what makes
 * recall feel situational rather than search-like. It is also the hook for
 * prospective memory: a record whose `future` field matches the current goal is
 * pulled up before anyone asks for it.
 *
 * Retrieval returns L0 lines — an abstract and a path — never bodies. Reading the
 * body is a separate, explicit, more expensive call.
 */

import type { MnemoConfig, MemoryRecord, Cue } from '../types.js';
import { cueToString } from '../types.js';
import type { BM25Index } from '../index/bm25.js';
import { retention, tier, type RetentionTier } from '../memory/decay.js';
import { decisionEligible } from '../memory/attribution.js';
import { competitionFactor } from '../memory/competition.js';
import { tokenOverlap, tokenize, truncate } from '../util/text.js';
import { daysBetween, parseIso } from '../util/time.js';

export interface RetrieveQuery {
  /** What the user asked. Optional: recall can be triggered by cues alone. */
  query?: string;
  /** What we are trying to accomplish this turn. Drives goalFit. */
  goal?: string;
  /** Situational cues harvested from context. */
  cues?: Cue[];
  limit?: number;
  /** Reconstruct the state of the world as of this instant. */
  asOf?: Date;
  /** Include records whose retention has fallen below the active threshold. */
  includeFaint?: boolean;
  /** Include second-hand records. They are still not decision-eligible. */
  includeHearsay?: boolean;
  excludeTypes?: readonly string[];
  /** Pre-computed semantic scores in 0..1, keyed by record name. */
  vectorHits?: Map<string, number>;
  /** How much vector relevance outweighs BM25 when both are present. 0..1. */
  vectorBlend?: number;
}

export interface Signals {
  recency: number;
  importance: number;
  relevance: number;
  goalFit: number;
}

export interface ScoredMemory {
  record: MemoryRecord;
  score: number;
  signals: Signals;
  tier: RetentionTier;
  /** False => may be mentioned, must not change behaviour. */
  decisionEligible: boolean;
  /** 0..1 multiplier from retrieval-induced forgetting. 1 means unsuppressed. */
  competition: number;
  /** The one-line L0 handle. This is what enters the prompt. */
  l0: string;
  /** Relative path, so a follow-up `read` never has to search. */
  path: string;
}

export interface RetrievalEngine {
  records: ReadonlyArray<MemoryRecord>;
  index: BM25Index;
  config: MnemoConfig;
  pathOf(name: string): string;
}

function cueMatch(recordCues: readonly string[], queryCues: readonly Cue[]): number {
  if (queryCues.length === 0 || recordCues.length === 0) return 0;
  const set = new Set(recordCues);
  let hits = 0;
  for (const cue of queryCues) {
    if (set.has(cueToString(cue))) hits++;
  }
  return Math.min(1, hits / Math.min(3, queryCues.length));
}

export function retrieve(engine: RetrievalEngine, query: RetrieveQuery): ScoredMemory[] {
  const now = query.asOf ?? new Date();
  const cfg = engine.config;
  const limit = query.limit ?? cfg.retrieve.limit;
  const weights = cfg.retrieve.weights;

  const bm25Hits = query.query?.trim()
    ? new Map(engine.index.search(tokenize(query.query), 200).map((h) => [h.id, h.norm]))
    : new Map<string, number>();

  const goalTokens = query.goal ? tokenize(query.goal) : [];
  const cues = query.cues ?? [];
  const vectorHits = query.vectorHits;
  const vectorBlend = vectorHits ? Math.min(1, Math.max(0, query.vectorBlend ?? 0.4)) : 0;
  const scored: ScoredMemory[] = [];

  for (const record of engine.records) {
    if (query.excludeTypes?.includes(record.type)) continue;

    // Temporal validity: `asOf` reconstructs the world at a past instant.
    if (record.validFrom) {
      const from = parseIso(record.validFrom);
      if (from && from.getTime() > now.getTime()) continue;
    }
    if (record.invalidAt) {
      const until = parseIso(record.invalidAt);
      if (until && until.getTime() <= now.getTime()) continue;
    }

    const retentionTier = tier(record, now, cfg.decay);
    const cueScore = cueMatch(record.cues, cues);

    if (retentionTier === 'archived' && !query.includeFaint) continue;
    // A `faint` record is only reachable when something specific reached for it.
    if (retentionTier === 'faint' && !query.includeFaint && cueScore < 0.5 && !bm25Hits.has(record.name)) {
      continue;
    }

    if (!query.includeHearsay && record.type === 'hearsay' && !bm25Hits.has(record.name)) {
      continue;
    }

    const recency = retention(record, now, cfg.decay);
    const importance = Math.min(1, (record.salience / 10) * record.weight);

    // Relevance blends lexical and semantic evidence. With no embedder,
    // vectorBlend is 0 and this reduces exactly to BM25.
    const lexical = bm25Hits.get(record.name) ?? 0;
    const semantic = vectorHits?.get(record.name) ?? 0;
    const relevance = vectorBlend * semantic + (1 - vectorBlend) * lexical;

    const goalTokensForRecord = [...tokenize(record.future.join(' ')), ...tokenize(record.abstract)];
    const goalOverlap = goalTokens.length > 0 ? tokenOverlap(goalTokens, goalTokensForRecord) : 0;
    const goalFit = Math.max(goalOverlap, cueScore);

    // Nothing distinguishes this record: it was not asked for, not cued, not
    // goal-relevant. Skipping keeps the candidate set honest and the prompt small.
    if (lexical === 0 && semantic === 0 && cueScore === 0 && goalOverlap === 0) continue;

    const score =
      weights.recency * recency +
      weights.importance * importance +
      weights.relevance * relevance +
      weights.goalFit * goalFit;

    // Retrieval-induced forgetting: a rival of something recently recalled is
    // quieter for a few days. Never zero, so it can always come back.
    const competition = competitionFactor(record, now, cfg.competition);

    scored.push({
      record,
      score: score * competition,
      signals: { recency, importance, relevance, goalFit },
      tier: retentionTier,
      decisionEligible: decisionEligible(record),
      competition,
      l0: '',
      path: engine.pathOf(record.name),
    });
  }

  scored.sort((a, b) => b.score - a.score || a.record.name.localeCompare(b.record.name));

  const top = scored.slice(0, limit);
  for (const item of top) item.l0 = renderL0(item);
  return top;
}

/**
 * One L0 line: abstract, type marker, age, path, score.
 *
 * The age is in the line on purpose. A model that knows a memory is 300 days old
 * treats it differently from one recorded this morning, and that difference is
 * most of what "having a sense of time" amounts to.
 */
export function renderL0(item: ScoredMemory, now: Date = new Date()): string {
  const r = item.record;
  const age = Math.round(daysBetween(r.validFrom, now));
  const flags: string[] = [];
  if (!item.decisionEligible) flags.push('relayed');
  if (r.invalidAt) flags.push('superseded');
  if (r.confidence < 0.6) flags.push(`conf=${r.confidence.toFixed(2)}`);
  if (item.tier === 'faint') flags.push('faint');
  const flagText = flags.length > 0 ? ` [${flags.join(',')}]` : '';
  return `- ${truncate(r.abstract, 80)}${flagText} · ${r.type} · ${age}d · ${item.score.toFixed(2)} · ${item.path}`;
}
