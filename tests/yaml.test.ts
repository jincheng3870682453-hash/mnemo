import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, serialize, FrontmatterError } from '../src/util/yaml.js';

test('round-trips scalars, arrays and nulls', () => {
  const data = {
    name: 'prefers-concise',
    weight: 0.8,
    hop: 0,
    invalid_at: null,
    active: true,
    links: ['a', 'b'],
    empty: [],
  };
  const text = serialize(data, 'body text');
  const parsed = parse(text);
  assert.equal(parsed.data.name, 'prefers-concise');
  assert.equal(parsed.data.weight, 0.8);
  assert.equal(parsed.data.hop, 0);
  assert.equal(parsed.data.invalid_at, null);
  assert.equal(parsed.data.active, true);
  assert.deepEqual(parsed.data.links, ['a', 'b']);
  assert.deepEqual(parsed.data.empty, []);
  assert.equal(parsed.body.trim(), 'body text');
});

test('quotes values that would otherwise be misread', () => {
  const text = stringify({
    a: 'null',
    b: 'true',
    c: '123',
    d: 'has: colon',
    e: ' leading space',
  });
  const parsed = parse(text);
  assert.equal(parsed.data.a, 'null');
  assert.equal(parsed.data.b, 'true');
  assert.equal(parsed.data.c, '123');
  assert.equal(parsed.data.d, 'has: colon');
  assert.equal(parsed.data.e, ' leading space');
});

test('serialisation is byte-stable regardless of key insertion order', () => {
  const a = stringify({ z: 1, a: 'x', m: ['q'] });
  const b = stringify({ m: ['q'], z: 1, a: 'x' });
  assert.equal(a, b);
});

test('CJK survives a round trip', () => {
  const text = serialize({ abstract: '金呈不喜欢客套开场白', cues: ['entity:金呈'] }, '正文');
  const parsed = parse(text);
  assert.equal(parsed.data.abstract, '金呈不喜欢客套开场白');
  assert.deepEqual(parsed.data.cues, ['entity:金呈']);
  assert.equal(parsed.body.trim(), '正文');
});

test('rejects malformed frontmatter instead of guessing', () => {
  assert.throws(() => parse('no frontmatter here'), FrontmatterError);
  assert.throws(() => parse('---\nkey: v\n'), FrontmatterError);
});
