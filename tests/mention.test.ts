import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { FileStore } from '../src/store/file-store.js';
import { Mnemo } from '../src/mnemo.js';
import { tempDir } from './helpers.js';

/** Let the fire-and-forget `store.update` writes land before asserting. */
const settle = () => new Promise((r) => setTimeout(r, 25));

test('reinforce by names renews stability with the mention multiplier, not the recall one', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await mem.write({
      name: 'pref-direct',
      abstract: '金呈不喜欢客套开场白',
      body: '直接说结论，带评级和优先级。',
      type: 'preference',
      salience: 6,
    });
    const before = mem.get('pref-direct')!;
    const s0 = before.stability;

    const report = await mem.reinforce({ names: ['pref-direct'] });

    assert.equal(report.renewed.length, 1);
    assert.equal(report.growth, 1.15); // mention.growth, not decay.stabilityGrowth (1.3)
    const after = mem.get('pref-direct')!;
    assert.ok(Math.abs(after.stability - s0 * 1.15) < 1e-9);
    assert.equal(after.accessCount, before.accessCount + 1);
    assert.ok(after.lastAccess);
  } finally {
    await cleanup();
  }
});

test('a mention renews only records with a genuine lexical hit', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    // Mentioned: shares vocabulary with the query.
    await mem.write({
      name: 'cake-party',
      abstract: '周末一起去游乐园，约了草莓蛋糕',
      body: '约定提前一天确认天气。',
      type: 'event',
      salience: 3,
    });
    // Not mentioned: high salience, zero lexical overlap with the query.
    await mem.write({
      name: 'core-promise',
      abstract: '答应过陪她看第一场雪',
      body: '关系重大转折级别的承诺。',
      type: 'event',
      salience: 10,
    });

    const report = await mem.reinforce({ query: '草莓蛋糕' });

    assert.equal(report.renewed.length, 1);
    assert.equal(report.renewed[0].name, 'cake-party');
    assert.equal(report.matched, 1);
    assert.ok(!mem.get('core-promise')!.lastAccess, 'importance alone must not count as a mention');
  } finally {
    await cleanup();
  }
});

test('limit caps renewals and matched reports what was cut', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    // Consolidation off: near-identical abstracts are the point of this test,
    // and we do not want the merger folding them into one before we count.
    const mem = await Mnemo.open(dir, {
      userPrincipal: 'user:me',
      config: { consolidation: { enabled: false } },
    });
    for (const [i, word] of ['甲', '乙', '丙', '丁'].entries()) {
      await mem.write({
        name: `m-${i}`,
        abstract: `关于${word}的记录 条目`,
        body: `${word} 的正文内容`,
        type: 'fact',
        salience: 5,
      });
    }
    const report = await mem.reinforce({ query: '的记录', limit: 2 });
    assert.equal(report.renewed.length, 2);
    assert.ok(report.matched >= 2);
  } finally {
    await cleanup();
  }
});

test('renewals survive a reopen — the write-back is durable', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    await mem.write({
      name: 'durable',
      abstract: '需要跨会话存活的续期记录',
      body: '正文。',
      type: 'fact',
      salience: 5,
    });
    const s0 = mem.get('durable')!.stability;
    await mem.reinforce({ names: ['durable'] });
    await settle();

    const reopened = await Mnemo.open(dir, { userPrincipal: 'user:me' });
    const after = reopened.get('durable')!;
    assert.ok(after.stability > s0);
    assert.ok(after.lastAccess);
  } finally {
    await cleanup();
  }
});

test('reinforce never touches competition or adaptive state', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, {
      userPrincipal: 'user:me',
      config: { consolidation: { enabled: false } },
    });
    await mem.write({ name: 'a-1', abstract: '关于某甲的一条记录', body: '甲的正文', type: 'fact' });
    await mem.write({ name: 'a-2', abstract: '关于某甲的另一条近似记录', body: '乙的正文', type: 'fact' });

    const before = mem.get('a-2')!.suppressedAt;
    await mem.reinforce({ query: '某甲' });

    assert.equal(mem.get('a-2')!.suppressedAt, before);
    assert.equal(mem.adaptiveEnabled(), false);
  } finally {
    await cleanup();
  }
});
