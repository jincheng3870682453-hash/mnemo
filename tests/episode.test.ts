import test from 'node:test';
import assert from 'node:assert/strict';
import { Mnemo } from '../src/mnemo.js';
import { tempDir } from './helpers.js';

test('a checkpoint becomes an episode whose title is the summary', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    const result = await mem.checkpoint({
      summary: '讨论记忆冷热分区与 JSON 存储方案',
      sessionId: 's-1',
    });

    assert.equal(result.record.type, 'episode');
    assert.equal(result.record.abstract, '讨论记忆冷热分区与 JSON 存储方案');
    assert.ok(result.path.startsWith('episodic'));
    assert.equal(result.record.provenance[0], 's-1#episode');
  } finally {
    await cleanup();
  }
});

test('the listing is the index: title, date and path, no bodies', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    await mem.checkpoint({
      summary: '第一次聊到记忆分区',
      body: '这一段正文不该出现在列表里',
      at: new Date('2026-11-01T10:00:00Z'),
    });
    await mem.checkpoint({
      summary: '第二次聊到 JSON 方案',
      at: new Date('2026-11-05T10:00:00Z'),
    });

    const list = mem.episodes();
    assert.equal(list.length, 2);
    assert.equal(list[0].title, '第二次聊到 JSON 方案', 'newest first');
    assert.ok(list[0].path.endsWith('.md'));

    const lines = mem.episodeLines();
    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.equal(line.split('\n').length, 1);
      assert.ok(line.startsWith('- '));
    }
    assert.ok(!lines.join('\n').includes('不该出现在列表里'));
  } finally {
    await cleanup();
  }
});

test('episodes never consolidate with each other', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    // Deliberately near-identical: two conversations about the same thing are
    // two events, not a duplicate claim.
    const first = await mem.checkpoint({ summary: '讨论记忆分区方案' });
    const second = await mem.checkpoint({ summary: '讨论记忆分区方案与冷热分层' });

    assert.equal(first.relation, 'created');
    assert.equal(second.relation, 'created');
    assert.equal(mem.episodes().length, 2);
  } finally {
    await cleanup();
  }
});

test('an episode can point at the facts it was about', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    await mem.write({ name: 'pref', abstract: '金呈不喜欢客套开场白', body: 'x', type: 'preference' });
    await mem.checkpoint({ summary: '聊到回复风格', facts: ['pref'] });

    const [episode] = mem.episodes();
    assert.deepEqual(episode.facts, ['pref']);

    const detail = await mem.read(episode.name, 'l2');
    assert.ok(detail);
  } finally {
    await cleanup();
  }
});

test('checkpointing the same summary twice is idempotent', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    const a = await mem.checkpoint({ summary: '同一段对话' });
    const b = await mem.checkpoint({ summary: '同一段对话' });
    assert.equal(a.record.name, b.record.name);
    assert.equal(mem.episodes().length, 1);
  } finally {
    await cleanup();
  }
});

test('an empty summary is refused rather than stored as a blank episode', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    await assert.rejects(() => mem.checkpoint({ summary: '   ' }), /summary/);
  } finally {
    await cleanup();
  }
});

test('episodes show up in metrics as their own type', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    await mem.checkpoint({ summary: '一次对话' });
    assert.equal(mem.metrics().byType.episode, 1);
  } finally {
    await cleanup();
  }
});

test('episodes survive a reopen', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const first = await Mnemo.open(dir);
    await first.checkpoint({ summary: '跨进程也要记得' });

    const second = await Mnemo.open(dir);
    assert.equal(second.episodes().length, 1);
    assert.equal(second.episodes()[0].title, '跨进程也要记得');
  } finally {
    await cleanup();
  }
});
