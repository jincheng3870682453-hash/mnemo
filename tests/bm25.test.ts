import test from 'node:test';
import assert from 'node:assert/strict';
import { BM25Index } from '../src/index/bm25.js';
import { tokenize } from '../src/util/text.js';

test('ranks the document that matches more query terms first', () => {
  const index = new BM25Index();
  index.add('a', tokenize('electron asar integrity check'));
  index.add('b', tokenize('electron asar完整性校验 与 sha256'));
  index.add('c', tokenize('live2d rendering'));

  const hits = index.search(tokenize('asar integrity check'));
  assert.equal(hits[0].id, 'a');
  assert.ok(hits.some((h) => h.id === 'c') === false);
});

test('handles CJK queries through unigrams and bigrams', () => {
  const index = new BM25Index();
  index.add('a', tokenize('用户的记忆是幂律衰减的'));
  index.add('b', tokenize('用户喜欢简短回复'));
  index.add('c', tokenize('构建脚本使用 electron-builder'));

  const hits = index.search(tokenize('记忆 衰减'));
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'a');
});

test('normalised score of the best hit is 1', () => {
  const index = new BM25Index();
  index.add('a', tokenize('alpha beta gamma'));
  index.add('b', tokenize('alpha'));
  const hits = index.search(tokenize('alpha'));
  assert.equal(hits[0].norm, 1);
  assert.ok(hits.every((h) => h.norm <= 1 && h.norm >= 0));
});

test('re-adding an id replaces rather than duplicates it', () => {
  const index = new BM25Index();
  index.add('a', tokenize('one two three'));
  index.add('a', tokenize('four five six'));
  assert.equal(index.size, 1);
  assert.equal(index.search(tokenize('one')).length, 0);
  assert.equal(index.search(tokenize('four'))[0].id, 'a');
});

test('removing and clearing leave no ghosts', () => {
  const index = new BM25Index();
  index.add('a', tokenize('alpha'));
  index.add('b', tokenize('beta'));
  index.remove('a');
  assert.equal(index.search(tokenize('alpha')).length, 0);
  index.clear();
  assert.equal(index.size, 0);
  assert.equal(index.search(tokenize('beta')).length, 0);
});

test('an empty query or empty index returns nothing rather than throwing', () => {
  const index = new BM25Index();
  assert.deepEqual(index.search([]), []);
  index.add('a', tokenize('alpha'));
  assert.deepEqual(index.search([]), []);
});
