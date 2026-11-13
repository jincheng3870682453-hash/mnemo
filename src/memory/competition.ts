/**
 * Retrieval-induced forgetting: recalling one thing quiets its rivals.
 *
 * In people, retrieving a memory temporarily suppresses competitors that share
 * its cues — retrieving "her birthday is in May" makes the *wrong* month harder
 * to reach for a while. It is a sharpening mechanism, not a bug: it is what keeps
 * recall from returning twelve near-identical candidates forever.
 *
 * Two measured facts shape this implementation
 * --------------------------------------------
 * • Suppressing persistent competitors can surface evidence you would otherwise
 *   never see (arXiv:2610.34977).
 * • Suppressing *repeatedly useful* memories is the complementary failure mode,
 *   from the same paper. A record that keeps getting retrieved is not a
 *   competitor, it is a real answer.
 *
 * So the penalty here is deliberately weak, temporary, and refuses to touch a
 * competitor that is itself frequently used or highly salient. It reduces noise;
 * it never removes an answer.
 */

import type { CompetitionConfig, MemoryRecord } from '../types.js';
import { tokenOverlap, tokenize } from '../util/text.js';
import { daysBetween, nowIso } from '../util/time.js';

/** Multiplier applied to a record's score, in (0, 1]. 1 = no suppression. */
export function competitionFactor(
  record: Pick<MemoryRecord, 'suppressedAt'>,
  now: Date,
  cfg: CompetitionConfig,
): number {
  if (!cfg.enabled || !record.suppressedAt) return 1;
  const days = daysBetween(record.suppressedAt, now);
  // Exponential recovery: the rival becomes reachable again within a few days.
  const penalty = cfg.maxPenalty * Math.exp(-days / Math.max(0.5, cfg.fadeDays));
  return Math.max(0, 1 - penalty);
}

/**
 * Would suppressing `competitor` on behalf of `winner` be a mistake?
 * Returns true when it is safe to suppress.
 */
export function shouldSuppress(
  competitor: MemoryRecord,
  winner: MemoryRecord,
  cfg: CompetitionConfig,
): boolean {
  if (competitor.name === winner.name) return false;
  if (competitor.type !== winner.type) return false;
  if (competitor.invalidAt) return false;
  // A record that is retrieved as often as the winner is not a rival; it is a
  // second real answer. Suppressing it is the documented failure mode.
  if (competitor.accessCount > winner.accessCount + 1) return false;
  // Never quiet something the user marked as very important.
  if (competitor.salience >= 9) return false;
  const overlap = tokenOverlap(tokenize(competitor.abstract), tokenize(winner.abstract));
  return overlap >= cfg.threshold;
}

/** Competitors of `winner`, most similar first. */
export function findCompetitors(
  winner: MemoryRecord,
  records: ReadonlyArray<MemoryRecord>,
  cfg: CompetitionConfig,
): MemoryRecord[] {
  if (!cfg.enabled) return [];
  const out: Array<{ record: MemoryRecord; overlap: number }> = [];
  for (const record of records) {
    if (!shouldSuppress(record, winner, cfg)) continue;
    const overlap = tokenOverlap(tokenize(record.abstract), tokenize(winner.abstract));
    out.push({ record, overlap });
  }
  out.sort((a, b) => b.overlap - a.overlap);
  return out.map((entry) => entry.record);
}

/** Mark competitors as suppressed as of `now`. Mutates the records. */
export function suppressCompetitors(
  winner: MemoryRecord,
  records: ReadonlyArray<MemoryRecord>,
  cfg: CompetitionConfig,
  now: Date,
): MemoryRecord[] {
  const competitors = findCompetitors(winner, records, cfg);
  for (const record of competitors) record.suppressedAt = nowIso(now);
  return competitors;
}
