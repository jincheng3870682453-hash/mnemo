import test from 'node:test';
import assert from 'node:assert/strict';
import { probeMetamemory, renderProbe } from '../src/memory/metamemory.js';
import { BM25Index } from '../src/index/bm25.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { MemoryRecord } from '../src/types.js';
import { indexableText } from '../src/memory/record.js';
import { tokenize } from '../src/util/text.js';
import { makeRecord } from './helpers.js';

const now = new Date('2026-06-01T00:00:00.000Z');
const fresh = new Date(now.getTime() - 86_400_000).toISOString();

function probe(records: MemoryRecord[], query: string) {
  const index = new BM25Index();
  for (const r of records) index.add(r.name, tokenize(indexableText(r)));
  return probeMetamemory({
    index,
    records,
    query,
    now,
    config: DEFAULT_CONFIG,
    pathOf: (name) => `facts/default/${name}.md`,
  });
}

test('an empty query is honestly nothing', () => {
  const result = probe([], '');
  assert.equal(result.feeling, 'no');
  assert.equal(result.candidates, 0);
});

test('an empty store yields "no" and saves a recall', () => {
  const result = probe([], '构建脚本');
  assert.equal(result.feeling, 'no');
  assert.equal(result.candidates, 0);
  assert.ok(result.savedTokens > 0);
  assert.ok(result.reason.includes('do not know') || result.reason.includes('guessing'));
});

test('a strong match yields "yes" with a pointer, never a body', () => {
  const record = makeRecord({
    name: 'build',
    abstract: '构建脚本使用 electron-builder',
    body: '这一段正文绝不该出现在探针输出里',
    createdAt: fresh,
    lastAccess: fresh,
    validFrom: fresh,
  });
  const result = probe([record], 'electron-builder');
  assert.equal(result.feeling, 'yes');
  assert.ok(result.hint);
  assert.equal(result.hint.name, 'build');
  assert.ok(!JSON.stringify(result).includes('绝不该出现在探针输出里'));
  assert.equal(result.hint.ageDays, 1);
});

test('a weak match yields "vague" rather than overclaiming', () => {
  const records = Array.from({ length: 5 }, (_, i) =>
    makeRecord({
      name: `r${i}`,
      abstract: `第 ${i} 条关于部署流程的记录`,
      createdAt: fresh,
      lastAccess: fresh,
      validFrom: fresh,
    }),
  );
  const result = probe(records, '部署流程 备份');
  assert.equal(result.feeling, 'vague');
  assert.ok(result.hint);
});

test('invalidated and archived records do not create a feeling', () => {
  const invalidated = makeRecord({
    name: 'gone',
    abstract: '构建脚本使用 electron-builder',
    invalidAt: fresh,
    validFrom: fresh,
  });
  assert.equal(probe([invalidated], 'electron-builder').feeling, 'no');

  const archived = makeRecord({
    name: 'old',
    abstract: '构建脚本使用 electron-builder',
    createdAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    lastAccess: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    validFrom: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    stability: 1,
  });
  assert.equal(probe([archived], 'electron-builder').feeling, 'no');
});

test('a shared single character is not knowledge', () => {
  // "帖子" shares one character with "量子纠缠"; BM25 indexes unigrams, so a
  // naive probe would return a hit. The probe must demand a multi-character
  // match or it will feel confident about everything.
  const record = makeRecord({
    name: 'rumour',
    abstract: '听说金呈喜欢用 X 工具',
    body: '来自第三方帖子。',
    createdAt: fresh,
    lastAccess: fresh,
    validFrom: fresh,
  });
  assert.equal(probe([record], '量子纠缠 光谱 低温').feeling, 'no');
});

test('the rendered line is a single line', () => {
  const record = makeRecord({
    name: 'x',
    abstract: '一个要点',
    createdAt: fresh,
    lastAccess: fresh,
    validFrom: fresh,
  });
  const line = renderProbe(probe([record], '要点'));
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.includes('memory·'));
});
