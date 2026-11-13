import test from 'node:test';
import assert from 'node:assert/strict';
import { selectByValuePerToken, renderSelection, type BudgetItem } from '../src/context/budget.js';

const item = (id: string, score: number, text: string): BudgetItem => ({ id, score, text });

test('value per token beats raw score when the budget is tight', () => {
  const short = item('short', 8, '短'); // 1 token
  const long = item('long', 10, '长'.repeat(200)); // 200 tokens
  const selection = selectByValuePerToken([long, short], 30);

  assert.deepEqual(selection.kept.map((i) => i.id), ['short']);
  assert.equal(selection.dropped, 1);
  assert.equal(selection.truncated, true);
});

test('the best item is included even when it exceeds the affordable share', () => {
  // Fits the overall budget, not the share left after the notice reserve.
  const big: BudgetItem = { id: 'big', score: 100, text: '字'.repeat(80), tokens: 80 };
  const selection = selectByValuePerToken([big], 100, 24);
  assert.equal(selection.kept.length, 1);
  assert.equal(selection.kept[0].id, 'big');
});

test('an item larger than the whole budget is not smuggled in', () => {
  const huge: BudgetItem = { id: 'huge', score: 100, text: '字'.repeat(500), tokens: 500 };
  const selection = selectByValuePerToken([huge], 40);
  assert.equal(selection.kept.length, 0);
  assert.equal(selection.truncated, true);
});

test('an empty list or zero budget yields nothing and says so', () => {
  assert.deepEqual(selectByValuePerToken([], 100).kept, []);
  const zero = selectByValuePerToken([item('a', 1, 'x')], 0);
  assert.equal(zero.kept.length, 0);
  assert.equal(zero.truncated, true);
});

test('kept items are presented in score order regardless of fill order', () => {
  const items = [
    item('a', 5, '甲'),
    item('b', 9, '乙'),
    item('c', 7, '丙'),
  ];
  const selection = selectByValuePerToken(items, 500);
  assert.deepEqual(selection.kept.map((i) => i.id), ['b', 'c', 'a']);
});

test('selection is deterministic for equal densities', () => {
  const items = [item('b', 5, '同'), item('a', 5, '同')];
  const first = selectByValuePerToken(items, 500).kept.map((i) => i.id);
  const second = selectByValuePerToken([...items].reverse(), 500).kept.map((i) => i.id);
  assert.deepEqual(first, second);
});

test('the budget is respected, with room held back for the notice', () => {
  const items = Array.from({ length: 20 }, (_, i) => item(`r${i}`, 100 - i, '内'.repeat(10)));
  const selection = selectByValuePerToken(items, 100, 24);
  assert.ok(selection.keptTokens <= 100 - 24 + 20, `tokens ${selection.keptTokens}`);
  assert.ok(selection.dropped > 0);
});

test('dropped items are surfaced, never silently truncated', () => {
  const items = [
    item('a', 10, '甲'.repeat(50)),
    item('b', 9, '乙'.repeat(50)),
    item('c', 8, '丙'.repeat(50)),
  ];
  const rendered = renderSelection(selectByValuePerToken(items, 60));
  assert.ok(rendered.includes('未放入'), rendered);
});

test('nothing dropped means no notice', () => {
  const rendered = renderSelection(selectByValuePerToken([item('a', 1, '短')], 500));
  assert.ok(!rendered.includes('未放入'));
});
