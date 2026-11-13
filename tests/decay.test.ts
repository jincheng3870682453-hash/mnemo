import test from 'node:test';
import assert from 'node:assert/strict';
import {
  retention,
  tier,
  initialStability,
  reinforce,
  erodeConfidence,
  daysUntil,
} from '../src/memory/decay.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import { makeRecord } from './helpers.js';

const cfg = DEFAULT_CONFIG.decay;
const t0 = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number): Date => new Date(t0.getTime() + n * 86_400_000);

test('retention starts at 1 and decreases monotonically', () => {
  const record = makeRecord({ createdAt: t0.toISOString(), stability: 2 });
  const r0 = retention(record, t0, cfg);
  const r1 = retention(record, day(1), cfg);
  const r10 = retention(record, day(10), cfg);
  const r100 = retention(record, day(100), cfg);

  assert.ok(Math.abs(r0 - 1) < 1e-9, `expected 1, got ${r0}`);
  assert.ok(r1 < r0 && r1 > 0);
  assert.ok(r10 < r1 && r10 > 0);
  assert.ok(r100 < r10 && r100 > 0);
});

test('the tail is heavy: a year-old memory is still reachable, unlike exponential', () => {
  const record = makeRecord({ createdAt: t0.toISOString(), stability: 1 });
  const powerLaw = retention(record, day(365), cfg);
  const exponential = Math.exp(-365 / 1);

  assert.ok(powerLaw > 0.001, `power law should keep a tail, got ${powerLaw}`);
  assert.ok(powerLaw > exponential, 'power law must decay slower than exponential');
});

test('higher salience yields higher starting stability', () => {
  assert.ok(initialStability(10) > initialStability(5));
  assert.ok(initialStability(5) > initialStability(1));
  assert.equal(initialStability(1), 1);
});

test('recall reinforces: stability grows and decay slows', () => {
  const before = makeRecord({ createdAt: t0.toISOString(), stability: 1 });
  const baseline = retention(before, day(20), cfg);

  const recalled = makeRecord({ createdAt: t0.toISOString(), stability: 1 });
  for (let i = 0; i < 5; i++) reinforce(recalled, day(i), cfg);

  const after = retention(recalled, day(20), cfg);
  assert.equal(recalled.accessCount, 5);
  assert.ok(recalled.stability > 1);
  assert.ok(after > baseline, 'spacing effect should slow forgetting');
});

test('tiers transition active -> faint -> archived', () => {
  const record = makeRecord({ createdAt: t0.toISOString(), stability: 1 });
  assert.equal(tier(record, t0, cfg), 'active');
  const mid = tier(record, day(5), cfg);
  const late = tier(record, day(2000), cfg);
  assert.notEqual(mid, 'active');
  assert.equal(late, 'archived');
});

test('confidence erodes but never reaches zero', () => {
  let record = makeRecord({ confidence: 0.9 });
  for (let i = 0; i < 200; i++) record = erodeConfidence(record, 0.95);
  assert.ok(record.confidence > 0);
  assert.ok(record.confidence < 0.1);
});

test('daysUntil inverts the retention curve', () => {
  const record = makeRecord({ createdAt: t0.toISOString(), stability: 1 });
  const d = daysUntil(record, cfg.activeThreshold, cfg);
  const atThreshold = retention(record, day(d), cfg);
  assert.ok(Math.abs(atThreshold - cfg.activeThreshold) < 1e-6);
});
