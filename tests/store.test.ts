import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { FileStore, PathEscapeError } from '../src/store/file-store.js';
import { Mnemo } from '../src/mnemo.js';
import { tempDir, makeRecord } from './helpers.js';

test('writes, reloads and finds a record by name', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    await store.save(makeRecord({ name: 'alpha' }));

    const fresh = new FileStore(dir);
    await fresh.init();
    const loaded = await fresh.load('alpha');
    assert.ok(loaded);
    assert.equal(loaded.name, 'alpha');
    assert.equal(loaded.body, 'sample body');
  } finally {
    await cleanup();
  }
});

test('the index directory is disposable: deleting it loses no knowledge', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mnemo = await Mnemo.open(dir);
    await mnemo.write({ name: 'k1', abstract: '金呈不喜欢客套开场白', body: '他明确说过', type: 'preference' });

    await rm(path.join(dir, 'index'), { recursive: true, force: true });

    const reopened = await Mnemo.open(dir);
    assert.equal(reopened.all().length, 1);
    const hits = reopened.recall({ query: '客套' });
    assert.equal(hits[0].record.name, 'k1');
  } finally {
    await cleanup();
  }
});

test('archiving moves the file but keeps it recoverable', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    const record = makeRecord({ name: 'old' });
    await store.save(record);
    const rel = await store.archive(record);
    assert.ok(rel.startsWith('archive'));
    assert.equal((await store.loadAll()).length, 0);
    assert.equal((await store.loadArchived()).length, 1);
  } finally {
    await cleanup();
  }
});

test('a name that is not a slug is rejected by the store rather than sanitised silently', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    assert.throws(
      () => store.relativePathFor({ name: '../../etc/passwd', type: 'fact', group: 'x' }),
      PathEscapeError,
    );
  } finally {
    await cleanup();
  }
});

test('group names with traversal segments are neutralised', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    const rel = store.relativePathFor({ name: 'ok', type: 'fact', group: '../../evil' });
    assert.ok(!rel.includes('..'));
    const abs = store.absolutePathFor({ name: 'ok', type: 'fact', group: '../../evil' });
    assert.ok(abs.startsWith(store.root));
  } finally {
    await cleanup();
  }
});

test('a corrupt file is skipped instead of taking down the whole load', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const store = new FileStore(dir);
    await store.init();
    await store.save(makeRecord({ name: 'good' }));
    const badPath = store.absolutePathFor({ name: 'bad', type: 'fact', group: 'default' });
    await (await import('node:fs/promises')).writeFile(badPath, 'not frontmatter at all', 'utf8');

    const records = await store.loadAll();
    assert.equal(records.length, 1);
    assert.equal(records[0].name, 'good');
  } finally {
    await cleanup();
  }
});
