import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideRelation,
  bestMatch,
  mergeIntoRecord,
  supersedeRecord,
} from '../src/memory/consolidation.js';
import { makeRecord } from './helpers.js';

test('identical claims are duplicates', () => {
  const plan = decideRelation(
    { abstract: '金呈不喜欢客套开场白', subject: 'user:jincheng' },
    { abstract: '金呈不喜欢客套开场白', subject: 'user:jincheng' },
  );
  assert.equal(plan.relation, 'duplicate');
});

test('a more specific claim refines the broader one', () => {
  const plan = decideRelation(
    { abstract: '金呈不喜欢客套开场白和寒暄', subject: 'user:jincheng' },
    { abstract: '金呈不喜欢客套开场白', subject: 'user:jincheng' },
  );
  assert.equal(plan.relation, 'refines');
});

test('opposite polarity supersedes rather than duplicating', () => {
  // Regression guard: duplication is checked after contradiction, so a changed
  // mind is never silently swallowed as "the same claim again".
  const plan = decideRelation(
    { abstract: '金呈喜欢详细解释', subject: 'user:jincheng' },
    { abstract: '金呈不喜欢详细解释', subject: 'user:jincheng' },
  );
  assert.equal(plan.relation, 'supersedes');
});

test('unrelated claims stay separate', () => {
  const plan = decideRelation(
    { abstract: '项目的构建脚本使用 electron-builder', subject: null },
    { abstract: '金呈偏好简短回复', subject: 'user:jincheng' },
  );
  assert.equal(plan.relation, 'unrelated');
});

test('bestMatch picks the strongest non-unrelated candidate', () => {
  const weak = makeRecord({ name: 'weak', abstract: '金呈回复偏好' });
  const strong = makeRecord({ name: 'strong', abstract: '金呈不喜欢客套开场白' });
  const match = bestMatch({ abstract: '金呈不喜欢客套开场白', subject: null }, [weak, strong]);
  assert.ok(match);
  assert.equal(match.record.name, 'strong');
});

test('bestMatch skips already invalidated records', () => {
  const stale = makeRecord({
    name: 'stale',
    abstract: '金呈不喜欢客套开场白',
    invalidAt: new Date().toISOString(),
  });
  assert.equal(bestMatch({ abstract: '金呈不喜欢客套开场白', subject: null }, [stale]), null);
});

test('merging keeps the abstract and appends the body exactly once', () => {
  const target = makeRecord({ body: 'first' });
  mergeIntoRecord(target, { body: 'second', salience: 8, provenance: ['s#1'], cues: ['topic:x'], future: ['f'] }, new Date());
  mergeIntoRecord(target, { body: 'second', salience: 8, provenance: ['s#1'], cues: ['topic:x'], future: ['f'] }, new Date());

  assert.equal(target.body.match(/second/g)?.length, 1, 'must not duplicate on re-merge');
  assert.equal(target.salience, 8);
  assert.ok(target.cues.includes('topic:x'));
});

test('supersede records the timestamp and keeps the record', () => {
  const record = makeRecord();
  const at = new Date('2026-06-01T00:00:00.000Z');
  supersedeRecord(record, at);
  assert.equal(record.invalidAt, at.toISOString());
});
