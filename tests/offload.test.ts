import test from 'node:test';
import assert from 'node:assert/strict';
import { FileStore } from '../src/store/file-store.js';
import { maybeOffload, readOffload } from '../src/context/offload.js';
import { tempDir } from './helpers.js';

async function store(): Promise<{ store: FileStore; cleanup: () => Promise<void> }> {
  const { dir, cleanup } = await tempDir();
  const s = new FileStore(dir);
  await s.init();
  return { store: s, cleanup };
}

test('small output passes through untouched', async () => {
  const { store: s, cleanup } = await store();
  try {
    const result = await maybeOffload(s, 's1', 'shell', 'ok', { thresholdTokens: 100 });
    assert.equal(result.offloaded, false);
    assert.equal(result.inline, 'ok');
    assert.equal(result.savedTokens, 0);
  } finally {
    await cleanup();
  }
});

test('large output is replaced by a one-line reference', async () => {
  const { store: s, cleanup } = await store();
  try {
    const output = Array.from({ length: 500 }, (_, i) => `第 ${i} 行输出内容`).join('\n');
    const result = await maybeOffload(s, 's1', 'web_search', output, { thresholdTokens: 50 });

    assert.equal(result.offloaded, true);
    assert.ok(result.ref);
    assert.ok(result.inline.split('\n').length <= 3, 'the replacement must be tiny');
    assert.ok(result.savedTokens > 0);
    assert.ok(result.inline.includes(`offload:${result.ref}`));
  } finally {
    await cleanup();
  }
});

test('offloaded output can be paged back', async () => {
  const { store: s, cleanup } = await store();
  try {
    const output = Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n');
    const result = await maybeOffload(s, 's1', 'cat', output, { thresholdTokens: 10 });
    assert.ok(result.ref);

    const page = await readOffload(s, 's1', result.ref, { fromLine: 10, toLine: 12 });
    assert.ok(page);
    assert.equal(page.fromLine, 10);
    assert.equal(page.toLine, 12);
    assert.ok(page.text.includes('line-9'));
    assert.ok(page.text.includes('line-11'));
    assert.equal(page.totalLines, 200);
  } finally {
    await cleanup();
  }
});

test('reading a non-existent ref returns null instead of throwing', async () => {
  const { store: s, cleanup } = await store();
  try {
    assert.equal(await readOffload(s, 's1', 'deadbeef'), null);
  } finally {
    await cleanup();
  }
});

test('a traversal-shaped session id and file name cannot escape the store', async () => {
  const { store: s, cleanup } = await store();
  try {
    const abs = await s.writeSessionFile('../../escape', '../../evil.txt', 'x');
    assert.ok(abs.startsWith(s.root), `escaped to ${abs}`);
    assert.ok(!abs.includes('..'));
  } finally {
    await cleanup();
  }
});

test('offloading is disabled when the threshold is zero', async () => {
  const { store: s, cleanup } = await store();
  try {
    const output = 'x'.repeat(10_000);
    const result = await maybeOffload(s, 's1', 'cat', output, { thresholdTokens: 0 });
    assert.equal(result.offloaded, false);
  } finally {
    await cleanup();
  }
});
