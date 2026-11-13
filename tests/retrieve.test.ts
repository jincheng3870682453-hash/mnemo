import test from 'node:test';
import assert from 'node:assert/strict';
import { retrieve, renderL0, type RetrievalEngine } from '../src/retrieval/retrieve.js';
import { BM25Index } from '../src/index/bm25.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { MemoryRecord } from '../src/types.js';
import { tokenize } from '../src/util/text.js';
import { indexableText } from '../src/memory/record.js';
import { makeRecord } from './helpers.js';

const now = new Date('2026-06-01T00:00:00.000Z');
const at = (daysAgo: number): string =>
  new Date(now.getTime() - daysAgo * 86_400_000).toISOString();

/**
 * A record whose creation, validity and last access all sit `daysAgo` before `now`.
 * Getting this wrong makes every record look ancient and silently archived, which
 * is exactly the bug this helper exists to prevent.
 */
function rec(
  daysAgo: number,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  const t = at(daysAgo);
  return makeRecord({ createdAt: t, lastAccess: t, validFrom: t, ...overrides });
}

function engineFor(records: MemoryRecord[]): RetrievalEngine {
  const index = new BM25Index();
  for (const r of records) index.add(r.name, tokenize(indexableText(r)));
  return {
    records,
    index,
    config: DEFAULT_CONFIG,
    pathOf: (name) => `facts/default/${name}.md`,
  };
}

test('a lexical match is returned; an unrelated record is not', () => {
  const records = [
    rec(1, { name: 'a', abstract: '金呈不喜欢客套开场白' }),
    rec(1, { name: 'b', abstract: '项目使用 electron-builder' }),
  ];
  const hits = retrieve(engineFor(records), { query: '开场白', asOf: now });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record.name, 'a');
});

test('goal fit lifts a record whose future hooks match the current goal', () => {
  const records = [
    rec(1, {
      name: 'tone',
      abstract: '金呈偏好简短回复',
      future: ['写正式文档前', '生成内容需要贴合个人风格时'],
      salience: 6,
    }),
    rec(1, {
      name: 'other',
      abstract: '金呈偏好简短回复的另一种说法',
      future: ['完全无关的用途'],
      salience: 6,
    }),
  ];
  const hits = retrieve(engineFor(records), { query: '简短回复', goal: '写正式文档', asOf: now });
  assert.equal(hits[0].record.name, 'tone');
  assert.ok(hits[0].signals.goalFit > 0);
});

test('a cue alone triggers recall without any query string', () => {
  const records = [
    rec(2, {
      name: 'cued',
      abstract: '上次聊到审计时他很焦虑',
      cues: ['entity:审计', 'emotion:anxiety'],
    }),
    rec(2, { name: 'plain', abstract: '完全无关的内容' }),
  ];
  const hits = retrieve(engineFor(records), {
    cues: [{ kind: 'emotion', value: 'anxiety' }],
    asOf: now,
  });
  assert.ok(hits.some((h) => h.record.name === 'cued'));
  assert.ok(!hits.some((h) => h.record.name === 'plain'));
});

test('a record with no query, cue or goal match is not returned', () => {
  const records = [rec(1, { name: 'lonely', abstract: '无人提及的事' })];
  assert.equal(retrieve(engineFor(records), { asOf: now }).length, 0);
});

test('archived records need an explicit opt-in', () => {
  const records = [rec(400, { name: 'old', abstract: '很久以前说过的话', stability: 1 })];
  assert.equal(retrieve(engineFor(records), { query: '很久以前', asOf: now }).length, 0);

  const withFlag = retrieve(engineFor(records), {
    query: '很久以前',
    asOf: now,
    includeFaint: true,
  });
  assert.equal(withFlag.length, 1);
  assert.equal(withFlag[0].tier, 'archived');
});

test('as-of reconstructs the past: a later belief is invisible', () => {
  const records = [rec(0, { name: 'later', abstract: '金呈喜欢详细解释' })];
  const yesterday = new Date(now.getTime() - 86_400_000);

  assert.equal(retrieve(engineFor(records), { query: '详细解释', asOf: yesterday }).length, 0);
  assert.equal(retrieve(engineFor(records), { query: '详细解释', asOf: now }).length, 1);
});

test('superseded records disappear after their invalidAt', () => {
  const records = [
    rec(10, { name: 'old', abstract: '金呈喜欢详细解释', invalidAt: at(5) }),
  ];
  assert.equal(retrieve(engineFor(records), { query: '详细解释', asOf: now }).length, 0);

  const backThen = retrieve(engineFor(records), {
    query: '详细解释',
    asOf: new Date(now.getTime() - 7 * 86_400_000),
  });
  assert.equal(backThen.length, 1);
});

test('limit is respected', () => {
  const records = Array.from({ length: 20 }, (_, i) =>
    rec(1, { name: `r${i}`, abstract: `上下文记忆第 ${i} 条` }),
  );
  const hits = retrieve(engineFor(records), { query: '上下文记忆', asOf: now, limit: 3 });
  assert.equal(hits.length, 3);
});

test('L0 lines carry a path and never the body', () => {
  const record = rec(1, {
    name: 'x',
    abstract: '一个要点',
    body: '一段绝不该出现在索引里的正文',
  });
  const hits = retrieve(engineFor([record]), { query: '要点', asOf: now });
  assert.equal(hits.length, 1);

  const line = renderL0(hits[0], now);
  assert.ok(line.includes('facts/default/x.md'));
  assert.ok(!line.includes('绝不该出现在索引里'));
  assert.ok(line.includes('1d'));
});

test('relayed records are flagged in L0 and marked non-actionable', () => {
  const record = rec(1, {
    name: 'rumour',
    abstract: '听说他喜欢 X 工具',
    type: 'hearsay',
    hop: 1,
  });
  const hits = retrieve(engineFor([record]), { query: 'X 工具', asOf: now });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].decisionEligible, false);
  assert.ok(hits[0].l0.includes('relayed'));
});
