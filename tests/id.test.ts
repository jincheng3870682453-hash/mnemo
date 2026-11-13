import test from 'node:test';
import assert from 'node:assert/strict';
import { slugify, isValidSlug, shortHash, newRef } from '../src/util/id.js';

test('ascii text becomes a readable slug', () => {
  assert.equal(slugify('React Hooks Rule'), 'react-hooks-rule');
  assert.ok(isValidSlug(slugify('React Hooks Rule')));
});

test('CJK input stays a valid slug', () => {
  const slug = slugify('金呈不喜欢客套开场白');
  assert.ok(isValidSlug(slug), `${slug} must be a valid slug`);
});

test('CJK input never collapses to its bare ascii remainder', () => {
  // Regression: stripping CJK used to leave "base" for both of these, so records
  // from different topics silently overwrote each other.
  const a = slugify('回复风格-base');
  const b = slugify('编辑器-base');
  assert.notEqual(a, b);
  assert.ok(a.startsWith('base-'));
  assert.ok(b.startsWith('base-'));
});

test('same text always yields the same slug', () => {
  assert.equal(slugify('固定输入'), slugify('固定输入'));
});

test('different CJK texts do not collide', () => {
  const seen = new Set<string>();
  for (const text of ['金呈喜欢简短', '金呈不喜欢简短', '完全不同的一句话', '另一句']) {
    seen.add(slugify(text));
  }
  assert.equal(seen.size, 4);
});

test('empty and punctuation-only input still produces a usable name', () => {
  assert.ok(isValidSlug(slugify('')));
  assert.ok(isValidSlug(slugify('！！！')));
});

test('hash is stable and refs are short', () => {
  assert.equal(shortHash('abc'), shortHash('abc'));
  assert.match(shortHash('abc'), /^[0-9a-f]{6}$/);
  assert.match(newRef('x'), /^[0-9a-f]{6}$/);
});
