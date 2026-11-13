import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeTrigger,
  parseTrigger,
  isDue,
  isUpcoming,
  matchesEvent,
  dueIntentions,
  renderPending,
} from '../src/prospective/intentions.js';
import { makeRecord } from './helpers.js';

const now = new Date('2026-11-13T10:00:00.000Z');

function intention(overrides: Parameters<typeof makeRecord>[0] = {}): ReturnType<typeof makeRecord> {
  return makeRecord({
    type: 'intention',
    status: 'pending',
    abstract: '提醒他周三交审计报告',
    trigger: 'time@2026-11-18T09:00:00.000Z',
    ...overrides,
  });
}

test('triggers round-trip', () => {
  assert.equal(encodeTrigger({ kind: 'time', at: '2026-11-18T09:00:00.000Z' }), 'time@2026-11-18T09:00:00.000Z');
  assert.deepEqual(parseTrigger('event@交报告,截稿'), { kind: 'event', keywords: ['交报告', '截稿'] });
  assert.equal(parseTrigger('nonsense'), null);
  assert.equal(parseTrigger(null), null);
});

test('time trigger fires at or after its instant', () => {
  const record = intention();
  assert.equal(isDue(record, new Date('2026-11-17T23:59:00.000Z')), false);
  assert.equal(isDue(record, new Date('2026-11-18T09:00:00.000Z')), true);
  assert.equal(isDue(record, new Date('2026-11-19T00:00:00.000Z')), true);
});

test('an intention only fires while pending', () => {
  const done = intention({ status: 'done' });
  assert.equal(isDue(done, new Date('2026-12-01T00:00:00.000Z')), false);
  assert.equal(isUpcoming(done, now), false);
});

test('event triggers fire on keyword presence', () => {
  const record = intention({ trigger: 'event@审计,报告' });
  assert.equal(matchesEvent(record, '我们聊聊审计的事'), true);
  assert.equal(matchesEvent(record, '今天天气不错'), false);
});

test('upcoming window excludes far-future intentions', () => {
  const soon = intention({ trigger: 'time@2026-11-18T09:00:00.000Z' });
  const later = intention({ trigger: 'time@2027-06-01T09:00:00.000Z' });
  assert.equal(isUpcoming(soon, now, 14), true);
  assert.equal(isUpcoming(later, now, 14), false);
});

test('dueIntentions sorts by time and includes overdue ones', () => {
  const overdue = intention({ name: 'a', trigger: 'time@2026-11-01T09:00:00.000Z' });
  const future = intention({ name: 'b', trigger: 'time@2026-11-20T09:00:00.000Z' });
  const result = dueIntentions([future, overdue], now);
  assert.deepEqual(result.map((r) => r.name), ['a']);
});

test('renderPending expresses days remaining in human terms', () => {
  const today = intention({ trigger: `time@${now.toISOString()}` });
  const later = intention({ name: 'b', trigger: 'time@2026-11-18T10:00:00.000Z' });
  const overdue = intention({ name: 'c', trigger: 'time@2026-11-10T10:00:00.000Z' });

  const text = renderPending([today, later, overdue], now, { withinDays: 14 });
  assert.ok(text.includes('今天'));
  assert.ok(text.includes('还有 5 天'));
  assert.ok(text.includes('已过期'));
});

test('renderPending is empty when nothing is close', () => {
  const far = intention({ trigger: 'time@2027-06-01T09:00:00.000Z' });
  assert.equal(renderPending([far], now, { withinDays: 14 }), '');
});
