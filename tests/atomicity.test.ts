import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FileStore } from '../src/store/file-store.js';
import { Mnemo } from '../src/mnemo.js';
import { tempDir, makeRecord } from './helpers.js';

test('update() leaves no temp orphans behind', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    await store.save(makeRecord({ name: 'alpha', body: 'v1' }));
    const record = (await store.load('alpha'))!;
    record.body = 'v2';
    await store.update(record);

    const loaded = await store.load('alpha');
    assert.equal(loaded!.body, 'v2');
    const all = await readdir(path.join(dir, 'facts', 'default'));
    assert.ok(all.every((f) => f.endsWith('.md')), `stray files: ${all.join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('a crashed write leaves a temp orphan, and the next open sweeps it', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    await store.save(makeRecord({ name: 'alpha' }));

    // Simulate the debris of a crash between writeFile and rename.
    const orphan = path.join(dir, 'facts', 'default', 'alpha.md.tmp-4242-deadbeef');
    await writeFile(orphan, 'half-written garbage', 'utf8');
    // Backdate it so the "concurrent writer" grace window does not spare it.
    const old = new Date(Date.now() - 120_000);
    await utimes(orphan, old, old);

    const fresh = new FileStore(dir);
    await fresh.init();
    const all = await readdir(path.join(dir, 'facts', 'default'));
    assert.ok(!all.some((f) => f.includes('.tmp-')), `orphan survived: ${all.join(', ')}`);
  } finally {
    await cleanup();
  }
});

test('a fresh temp from a concurrent writer is NOT swept', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    await store.save(makeRecord({ name: 'alpha' }));

    const live = path.join(dir, 'facts', 'default', 'beta.md.tmp-9999-cafebabe');
    await writeFile(live, 'in flight', 'utf8'); // mtime = now

    const fresh = new FileStore(dir);
    await fresh.init();
    const all = await readdir(path.join(dir, 'facts', 'default'));
    assert.ok(all.some((f) => f === 'beta.md.tmp-9999-cafebabe'));
  } finally {
    await cleanup();
  }
});

test('session writes are atomic too: content lands, no debris', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    await store.writeSessionFile('s-1', 'canvas.md', '# task canvas');
    assert.equal(await store.readSessionFile('s-1', 'canvas.md'), '# task canvas');
    const files = await readdir(path.join(dir, 'session', 's-1'));
    assert.ok(files.every((f) => !f.includes('.tmp-')));
  } finally {
    await cleanup();
  }
});

test('the whole store still works after atomic-write refactors: open, write, recall', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await mem.write({ name: 'k1', abstract: '金呈不喜欢客套开场白', body: '直说结论', type: 'preference' });
    const hits = await mem.recall({ query: '客套' });
    assert.equal(hits[0].record.name, 'k1');
    const fresh = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    assert.equal(fresh.get('k1')!.body, '直说结论');
  } finally {
    await cleanup();
  }
});
