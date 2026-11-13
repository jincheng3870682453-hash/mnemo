import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assemble,
  trimToBudget,
  stableToolBlock,
  buildMemoryIndex,
} from '../src/context/assembler.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import { makeRecord } from './helpers.js';

const budget = DEFAULT_CONFIG.budget;

test('prefix is byte-identical across turns that only differ in the user message', () => {
  const base = {
    system: 'you are a helpful assistant',
    memoryIndex: '# Memory\n- 用户偏好简短回复',
  };
  const first = assemble({ ...base, userMessage: '第一句' }, budget);
  const second = assemble({ ...base, userMessage: '完全不同的一句话' }, budget);

  assert.equal(first.prefix, second.prefix);
  assert.notEqual(first.suffix, second.suffix);
  assert.ok(first.tokens.cacheableRatio > 0);
});

test('prefix never contains the volatile material', () => {
  const assembled = assemble(
    {
      system: 'sys',
      memoryIndex: '# Memory',
      retrieved: ['- 某条记忆'],
      taskCanvas: '## 目标\n做点什么',
      userMessage: '现在的问题',
    },
    budget,
  );
  assert.ok(!assembled.prefix.includes('现在的问题'));
  assert.ok(!assembled.prefix.includes('某条记忆'));
  assert.ok(assembled.suffix.includes('现在的问题'));
});

test('trimToBudget drops trailing lines and reports it', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} 这是一行足够长的内容`).join('\n');
  const result = trimToBudget(text, 50, '测试');
  assert.equal(result.trimmed, true);
  assert.ok(result.dropped > 0);
  assert.ok(result.text.includes('未放入'));
});

test('trimToBudget leaves short content untouched', () => {
  const result = trimToBudget('短', 100, '测试');
  assert.equal(result.trimmed, false);
  assert.equal(result.text, '短');
});

test('tool block is order-independent and key-sorted', () => {
  const a = { name: 'write', params: { b: 1, a: 2 } };
  const b = { name: 'read', params: { z: 1 } };

  assert.equal(stableToolBlock([a, b]), stableToolBlock([b, a]));
  const block = stableToolBlock([a]);
  assert.ok(block.indexOf('"a"') < block.indexOf('"b"'), 'keys must be sorted');
});

test('memory index is capped and links by name rather than embedding bodies', () => {
  const records = Array.from({ length: 40 }, (_, i) =>
    makeRecord({
      name: `fact-${i}`,
      abstract: `这是第 ${i} 条事实的描述`,
      type: 'fact',
      salience: 5,
    }),
  );
  const index = buildMemoryIndex(records, { maxLines: 8, now: new Date('2026-01-02T00:00:00Z') });
  const bullets = index.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(bullets.length <= 8, `expected <= 8 bullets, got ${bullets.length}`);
  assert.ok(index.includes('`fact-'));
  assert.ok(!index.includes('sample body'));
});

test('persona records are surfaced first', () => {
  const records = [
    makeRecord({ name: 'p1', type: 'persona', abstract: '说话直接，不客套', salience: 9 }),
    makeRecord({ name: 'f1', type: 'fact', abstract: '在做 Electron 诊断', salience: 9 }),
  ];
  const index = buildMemoryIndex(records, { maxLines: 5 });
  assert.ok(index.indexOf('说话直接') < index.indexOf('在做 Electron'));
});

test('exceeding a layer budget produces a warning, never a silent cut', () => {
  const assembled = assemble(
    { system: 'x'.repeat(4000), userMessage: 'hi' },
    { ...budget, system: 50 },
  );
  assert.ok(assembled.warnings.some((w) => w.includes('system')));
});
