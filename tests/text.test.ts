import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, tokenize, truncate, tokenOverlap } from '../src/util/text.js';

test('estimates CJK at roughly one token per character', () => {
  const text = '你好世界';
  assert.ok(estimateTokens(text) >= 4);
  assert.ok(estimateTokens(text) <= 8);
});

test('estimates latin text at roughly a quarter token per char', () => {
  const text = 'the quick brown fox jumps over the lazy dog';
  const tokens = estimateTokens(text);
  assert.ok(tokens >= 10 && tokens <= 15, `got ${tokens}`);
});

test('tokenises CJK into unigrams and bigrams', () => {
  const tokens = tokenize('上下文记忆');
  assert.ok(tokens.includes('上'));
  assert.ok(tokens.includes('上下'));
  assert.ok(tokens.includes('下文'));
});

test('tokenises latin case-insensitively and keeps numbers', () => {
  const tokens = tokenize('Electron ARRAY 2026');
  assert.deepEqual(tokens, ['electron', 'array', '2026']);
});

test('truncate never splits a surrogate pair', () => {
  const text = '😀😀😀😀😀';
  const cut = truncate(text, 3);
  assert.equal(Array.from(cut).length, 3);
  assert.ok(cut.endsWith('…'));
});

test('token overlap is symmetric and bounded', () => {
  const a = tokenize('上下文 记忆 节省');
  const b = tokenize('上下文 记忆');
  assert.equal(tokenOverlap(a, b), tokenOverlap(b, a));
  assert.ok(tokenOverlap(a, b) > 0 && tokenOverlap(a, b) < 1);
  assert.equal(tokenOverlap([], b), 0);
});
