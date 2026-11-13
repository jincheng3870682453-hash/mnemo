/**
 * Forgetting: power-law decay, not exponential.
 *
 *   R(t) = (1 + t / S) ^ -d
 *
 * Exponential decay (R = e^(-t/S)) is what most agent-memory libraries reach for.
 * It fits human retention poorly: one 2026 study reported R^2 = 0.954 for the
 * power law against 0.295 for the exponential. The difference is the tail — an
 * exponential says a memory is gone, the power law says it is merely hard to
 * reach, which is exactly what people experience.
 *
 * Retention is a *ranking* signal, not a deletion schedule. Nothing is removed at
 * R = 0; records degrade to `faint` (reachable only through a strong cue) and
 * then to `archived` (off the hot path, still recoverable and still subject to
 * `--as-of` queries).
 */

import type { DecayConfig, MemoryRecord } from '../types.js';
import { daysBetween, nowIso } from '../util/time.js';

export type RetentionTier = 'active' | 'faint' | 'archived';

/** Current retention strength in 0..1. */
export function retention(record: MemoryRecord, now: Date, cfg: DecayConfig): number {
  const anchor = record.lastAccess ?? record.createdAt;
  const elapsedDays = daysBetween(anchor, now);
  const stability = Math.max(0.1, record.stability);
  const r = Math.pow(1 + elapsedDays / stability, -cfg.exponent);
  return Math.min(1, Math.max(0, r));
}

export function tier(record: MemoryRecord, now: Date, cfg: DecayConfig): RetentionTier {
  const r = retention(record, now, cfg);
  if (r > cfg.activeThreshold) return 'active';
  if (r > cfg.faintThreshold) return 'faint';
  return 'archived';
}

/**
 * Stability a fresh record starts with, derived from salience.
 * Salience 10 => S 5.5d, salience 1 => S 1.0d. Emotional and important things
 * start harder to forget; mundane things start soft.
 */
export function initialStability(salience: number): number {
  const s = Math.min(10, Math.max(1, salience));
  return 1 + (s - 1) * 0.5;
}

/**
 * Apply the spacing effect: a successful recall makes the record harder to
 * forget. Mutates and returns the record.
 *
 * This is why `lastAccess` (not `createdAt`) anchors recency: something you think
 * about often *feels* recent, which is the observable behaviour of consolidation.
 */
export function reinforce(record: MemoryRecord, now: Date, cfg: DecayConfig): MemoryRecord {
  record.accessCount += 1;
  record.lastAccess = nowIso(now);
  record.stability = Math.min(3650, record.stability * cfg.stabilityGrowth);
  return record;
}

/**
 * Erode confidence when a record is re-read and re-told rather than quoted
 * verbatim. This models the finding that retrieval itself rewrites memory.
 */
export function erodeConfidence(record: MemoryRecord, factor: number): MemoryRecord {
  record.confidence = Math.max(0.05, record.confidence * factor);
  return record;
}

/** Days until retention crosses a threshold, assuming no further recall. */
export function daysUntil(record: MemoryRecord, threshold: number, cfg: DecayConfig): number {
  const stability = Math.max(0.1, record.stability);
  // Solve (1 + t/S)^-d = threshold  =>  t = S * (threshold^(-1/d) - 1)
  const t = stability * (Math.pow(threshold, -1 / cfg.exponent) - 1);
  return Math.max(0, t);
}
