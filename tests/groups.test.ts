import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { Mnemo } from '../src/mnemo.js';
import { tempDir } from './helpers.js';

test('canonGroup folds future writes to the canonical directory', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await mem.write({ name: 'tone-a', abstract: '金呈不喜欢客套开场白', body: '直说结论', type: 'preference', group: 'userTone' });
    const before = await mem.get('tone-a') ? 'ok' : 'missing';
    assert.equal(before, 'ok');

    await mem.canonGroup('usertone', 'user-tone');

    await mem.write({ name: 'tone-b', abstract: '金呈要求先看数据再下结论', body: '数据优先', type: 'preference', group: 'userTone' });
    const b = mem.get('tone-b')!;
    const bPath = mem.store.relativePathFor(b).split(path.sep).join('/');
    assert.equal(bPath, 'facts/user-tone/tone-b.md', `alias write escaped folding: ${bPath}`);
  } finally {
    await cleanup();
  }
});

test('canonGroup with move:true relocates existing files and reports conflicts, never clobbers', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await mem.write({ name: 'tone-a', abstract: '记录甲：直接说结论', body: 'v1', type: 'preference', group: 'usertone' });
    await mem.write({ name: 'tone-b', abstract: '记录乙：数据优先', body: 'v1', type: 'preference', group: 'usertone' });
    // A record already in the canonical group claims the name `tone-b`.
    await mem.write({ name: 'tone-b', abstract: '记录丙：占住了这个名字', body: 'canonical twin', type: 'preference', group: 'user-tone' });

    const report = await mem.canonGroup('usertone', 'user-tone', { move: true });

    assert.deepEqual(report.moved.sort(), ['facts/user-tone/tone-a.md']);
    assert.equal(report.conflicts.length, 1);
    assert.ok(report.conflicts[0].includes('tone-b'));

    // The conflict file still exists exactly where it was, untouched.
    const stray = await readdir(path.join(dir, 'facts', 'usertone'));
    assert.equal(stray.filter((f) => f.endsWith('.md')).length, 1);
    assert.equal(mem.get('tone-a')!.abstract, '记录甲：直接说结论');
  } finally {
    await cleanup();
  }
});

test('the alias map survives a reopen and keeps folding', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const first = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await first.canonGroup('work-snippets', 'work/notes');

    const second = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    assert.deepEqual(second.groupAliases(), { 'work-snippets': 'work/notes' });
    await second.write({ name: 'snip-1', abstract: '一条工作片段', body: 'x', type: 'fact', group: 'work-snippets' });
    const rec = second.get('snip-1')!;
    assert.ok(second.store.relativePathFor(rec).includes('work'));
    assert.ok(second.store.relativePathFor(rec).includes('notes'));
  } finally {
    await cleanup();
  }
});

test('groups.json lives OUTSIDE index/ — deleting index loses no folding knowledge', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await mem.canonGroup('usertone', 'user-tone');
    assert.ok(mem.groupAliases()['usertone'] === 'user-tone');

    await rm(path.join(dir, 'index'), { recursive: true, force: true });

    const reopened = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    assert.equal(reopened.groupAliases()['usertone'], 'user-tone');
  } finally {
    await cleanup();
  }
});

test('groups() reports fragmentation with counts and folded aliases', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, {
      userPrincipal: 'user:me',
      config: { consolidation: { enabled: false } },
    });
    await mem.write({ name: 'g1', abstract: '甲组记录一', body: 'x', type: 'fact', group: 'alpha' });
    await mem.write({ name: 'g2', abstract: '甲组记录二', body: 'x', type: 'fact', group: 'alpha' });
    await mem.write({ name: 'g3', abstract: '乙组记录', body: 'x', type: 'fact', group: 'beta' });
    await mem.canonGroup('alphas', 'alpha');

    const groups = await mem.groups();
    const alpha = groups.find((g) => g.group === 'alpha')!;
    assert.ok(alpha && alpha.count === 2);
    assert.deepEqual(alpha.aliases, ['alphas']);
  } finally {
    await cleanup();
  }
});
