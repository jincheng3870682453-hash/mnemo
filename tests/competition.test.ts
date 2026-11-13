import test from 'node:test';
import assert from 'node:assert/strict';
import {
  competitionFactor,
  shouldSuppress,
  findCompetitors,
  suppressCompetitors,
} from '../src/memory/competition.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import { makeRecord } from './helpers.js';

const cfg = DEFAULT_CONFIG.competition;
const now = new Date('2026-06-01T00:00:00.000Z');
const daysAgo = (n: number): string => new Date(now.getTime() - n * 86_400_000).toISOString();

test('an unsuppressed record scores at full strength', () => {
  assert.equal(competitionFactor({ suppressedAt: null }, now, cfg), 1);
});

test('suppression is a nudge, not a deletion, and it fades', () => {
  const justNow = competitionFactor({ suppressedAt: daysAgo(0) }, now, cfg);
  const twoDays = competitionFactor({ suppressedAt: daysAgo(2) }, now, cfg);
  const longAgo = competitionFactor({ suppressedAt: daysAgo(60) }, now, cfg);

  assert.ok(justNow < 1, 'fresh suppression must reduce the score');
  assert.ok(justNow > 0.5, 'but never remove it');
  assert.ok(twoDays > justNow, 'it recovers over days');
  assert.ok(longAgo > 0.99, 'and is gone within weeks');
});

test('disabling competition leaves scores untouched', () => {
  const off = { ...cfg, enabled: false };
  assert.equal(competitionFactor({ suppressedAt: daysAgo(0) }, now, off), 1);
  assert.deepEqual(findCompetitors(makeRecord(), [makeRecord({ name: 'other' })], off), []);
});

test('near-duplicates of the same type are competitors', () => {
  const winner = makeRecord({ name: 'a', abstract: '金呈喜欢用 tsc 直接编译' });
  const rival = makeRecord({ name: 'b', abstract: '金呈喜欢用 tsc 直接编译打包' });
  const unrelated = makeRecord({ name: 'c', abstract: '备份方案是每日快照' });

  assert.equal(shouldSuppress(rival, winner, cfg), true);
  assert.equal(shouldSuppress(unrelated, winner, cfg), false);
  assert.deepEqual(
    findCompetitors(winner, [winner, rival, unrelated], cfg).map((r) => r.name),
    ['b'],
  );
});

test('a record that is itself frequently used is never suppressed', () => {
  // Documented failure mode (arXiv:2610.34977): suppressing repeatedly useful
  // memories removes real answers.
  const winner = makeRecord({ name: 'a', abstract: '金呈喜欢用 tsc 直接编译', accessCount: 1 });
  const provenRival = makeRecord({
    name: 'b',
    abstract: '金呈喜欢用 tsc 直接编译打包',
    accessCount: 9,
  });
  assert.equal(shouldSuppress(provenRival, winner, cfg), false);
});

test('a highly salient record is never suppressed', () => {
  const winner = makeRecord({ name: 'a', abstract: '金呈喜欢用 tsc 直接编译' });
  const important = makeRecord({
    name: 'b',
    abstract: '金呈喜欢用 tsc 直接编译打包',
    salience: 10,
  });
  assert.equal(shouldSuppress(important, winner, cfg), false);
});

test('different types are not rivals', () => {
  const winner = makeRecord({ name: 'a', abstract: '金呈喜欢用 tsc 直接编译', type: 'preference' });
  const other = makeRecord({ name: 'b', abstract: '金呈喜欢用 tsc 直接编译打包', type: 'fact' });
  assert.equal(shouldSuppress(other, winner, cfg), false);
});

test('suppression stamps only the competitors', () => {
  const winner = makeRecord({ name: 'a', abstract: '金呈喜欢用 tsc 直接编译' });
  const rival = makeRecord({ name: 'b', abstract: '金呈喜欢用 tsc 直接编译打包' });
  const bystander = makeRecord({ name: 'c', abstract: '备份方案是每日快照' });

  const suppressed = suppressCompetitors(winner, [winner, rival, bystander], cfg, now);
  assert.deepEqual(suppressed.map((r) => r.name), ['b']);
  assert.equal(rival.suppressedAt, now.toISOString());
  assert.equal(winner.suppressedAt, null);
  assert.equal(bystander.suppressedAt, null);
});
