import test from 'node:test';
import assert from 'node:assert/strict';
import { Mnemo } from '../src/mnemo.js';
import { tempDir } from './helpers.js';

test('merging keeps a version of the record it overwrote', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    await mem.write({ name: 'build', abstract: '构建脚本使用 tsc', body: 'v1 正文', type: 'fact' });

    // A refinement merges into the existing record and, without a snapshot, would
    // destroy "v1 正文" for good.
    const merged = await mem.write({
      name: 'build-more',
      abstract: '构建脚本使用 tsc 且不打包',
      body: 'v2 正文',
      type: 'fact',
    });
    assert.equal(merged.relation, 'refines');

    const versions = await mem.history('build');
    assert.equal(versions.length, 1);

    const current = await mem.read('build', 'l2');
    assert.ok(current?.body.includes('v2 正文'));
    assert.ok(current?.body.includes('v1 正文'), 'body should accumulate');
  } finally {
    await cleanup();
  }
});

test('a merge can be undone', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    await mem.write({ name: 'note', abstract: '部署方式是单机 docker', body: '原始正文', type: 'fact' });
    await mem.write({
      name: 'note-more',
      abstract: '部署方式是单机 docker，由 systemd 托管并开机自启',
      body: '追加的错误内容',
      type: 'fact',
    });

    const before = await mem.read('note', 'l2');
    assert.ok(before?.body.includes('追加的错误内容'));

    assert.equal(await mem.restore('note'), true);

    const after = await mem.read('note', 'l2');
    assert.equal(after?.body, '原始正文');
  } finally {
    await cleanup();
  }
});

test('superseding also preserves the old belief', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    await mem.write({ name: 'tone', abstract: '金呈喜欢详细解释', body: '旧认知', type: 'preference' });
    await mem.write({ name: 'tone-new', abstract: '金呈不喜欢详细解释', body: '新认知', type: 'preference' });

    const versions = await mem.history('tone');
    assert.equal(versions.length, 1);
    assert.equal(await mem.restore('tone', versions[0]), true);

    const restored = await mem.get('tone');
    assert.equal(restored?.invalidAt, null, 'restoring revives the record');
    assert.ok(restored?.body.includes('旧认知'));
  } finally {
    await cleanup();
  }
});

test('history files never appear as records', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    await mem.write({ name: 'a', abstract: '构建脚本使用 tsc', body: 'x', type: 'fact' });
    await mem.write({ name: 'b', abstract: '构建脚本使用 tsc 且不打包', body: 'y', type: 'fact' });

    assert.equal(mem.all().length, 1);
    assert.equal((await mem.history('a')).length, 1);
  } finally {
    await cleanup();
  }
});

test('restore reports honestly when there is nothing to restore', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    assert.deepEqual(await mem.history('nope'), []);
    assert.equal(await mem.restore('nope'), false);
    assert.equal(await mem.restore('nope', '2026-01-01T00-00-00-000Z'), false);
  } finally {
    await cleanup();
  }
});
