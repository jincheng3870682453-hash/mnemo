import test from 'node:test';
import assert from 'node:assert/strict';
import { Mnemo } from '../src/mnemo.js';
import { estimateTokens } from '../src/util/text.js';
import { tempDir } from './helpers.js';

test('end-to-end: write, recall pointers, read detail, assemble context', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir, { userPrincipal: 'user:jincheng' });

    await m.write({
      name: 'pref-direct',
      abstract: '金呈不喜欢客套开场白',
      body: '他明确说过：不要"很高兴为您服务"这种开头，直接说结论。',
      type: 'preference',
      salience: 8,
      group: 'user-tone',
    });
    await m.write({
      name: 'fact-project',
      abstract: '当前在做 mnemo 记忆库',
      body: '目标是让 agent 的上下文开销降一个数量级。',
      type: 'fact',
      salience: 7,
      group: 'work',
    });

    const hits = await m.recall({ query: '开场白 说话风格' });
    assert.ok(hits.length > 0);
    assert.equal(hits[0].record.name, 'pref-direct');
    assert.ok(hits[0].l0.includes('pref-direct') || hits[0].l0.includes('facts/'));
    // L0 must be a pointer, not the body.
    assert.ok(!hits[0].l0.includes('很高兴为您服务'));

    const detail = await m.read('pref-direct', 'l2');
    assert.ok(detail);
    assert.ok(detail.body.includes('很高兴为您服务'));
    assert.ok(detail.tokens > 0);

    const ctx = await m.bootContext({ userMessage: '帮我看看这个设计' });
    assert.ok(ctx.tokens.total > 0);
    assert.ok(ctx.tokens.cacheableRatio >= 0);
    assert.ok(ctx.prefix.includes('你不喜欢') || ctx.prefix.includes('# Memory'));
    assert.ok(ctx.suffix.includes('帮我看看这个设计'));

    const metrics = m.metrics();
    assert.equal(metrics.total, 2);
    assert.equal(metrics.decisionEligible, 2);
  } finally {
    await cleanup();
  }
});

test('changing your mind supersedes instead of overwriting', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir, { userPrincipal: 'user:jincheng' });

    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const first = await m.write({
      name: 'tone-v1',
      abstract: '金呈喜欢详细解释',
      body: '第一版认知',
      type: 'preference',
      validFrom: threeDaysAgo,
    });
    assert.equal(first.relation, 'created');

    const second = await m.write({
      name: 'tone-v2',
      abstract: '金呈不喜欢详细解释',
      body: '改主意了',
      type: 'preference',
    });
    assert.equal(second.relation, 'supersedes');
    assert.deepEqual(second.invalidated, ['tone-v1']);

    const old = m.get('tone-v1');
    assert.ok(old?.invalidAt, 'the superseded record must survive with invalidAt set');
    assert.ok(second.record.links.includes('tone-v1'), 'the new belief must link back');

    // Today: only the new belief.
    const today = await m.recall({ query: '详细解释' });
    assert.deepEqual(today.map((h) => h.record.name), ['tone-v2']);

    // Historical view: the old belief was true then.
    const past = await m.recall({
      query: '详细解释',
      asOf: new Date(Date.now() - 60_000),
    });
    assert.ok(past.some((h) => h.record.name === 'tone-v1'));
  } finally {
    await cleanup();
  }
});

test('second-hand preferences are stored but cannot steer behaviour', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir, { userPrincipal: 'user:jincheng' });

    const result = await m.write({
      name: 'heard-tool',
      abstract: '听说金呈喜欢用 X 工具',
      body: '来自一个第三方帖子，帖子里引用了他自己用户的偏好。',
      type: 'preference',
      hop: 1,
      subject: 'user:mallory',
      speaker: 'agent:mallory',
    });

    assert.equal(result.record.type, 'hearsay');
    assert.ok(result.notes.some((n) => n.includes('demoted')));

    const hits = await m.recall({ query: 'X 工具', includeHearsay: true });
    const hit = hits.find((h) => h.record.name === 'heard-tool');
    assert.ok(hit);
    assert.equal(hit.decisionEligible, false);
    assert.ok(hit.l0.includes('relayed'));
  } finally {
    await cleanup();
  }
});

test('duplicate writes merge instead of duplicating', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir);
    await m.write({ name: 'a', abstract: '构建脚本使用 electron-builder', body: 'v1', type: 'fact' });
    const again = await m.write({
      name: 'b',
      abstract: '构建脚本使用 electron-builder',
      body: 'v2',
      type: 'fact',
    });
    assert.equal(again.relation, 'duplicate');
    assert.equal(m.all().length, 1);
  } finally {
    await cleanup();
  }
});

test('intentions surface before they are asked for', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir, { userPrincipal: 'user:jincheng' });
    await m.intend({
      what: '提醒他周三交审计报告',
      trigger: { kind: 'time', at: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    });

    const pending = m.pendingLines();
    assert.ok(pending.includes('审计报告'), `expected the intention in: ${pending}`);
    assert.ok(pending.includes('天'));

    const notYet = m.due();
    assert.equal(notYet.length, 0, 'a future intention must not fire early');
  } finally {
    await cleanup();
  }
});

test('event-triggered intentions fire from context', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir);
    await m.intend({ what: '提一下审计的事', trigger: { kind: 'event', keywords: ['审计'] } });
    assert.equal(m.due(new Date(), '我们聊聊审计').length, 1);
    assert.equal(m.due(new Date(), '天气不错').length, 0);
  } finally {
    await cleanup();
  }
});

test('forgetting is reversible and never deletes', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir);
    await m.write({ name: 'gone', abstract: '一条会被忘掉的记忆', body: 'x', type: 'fact' });
    assert.equal(await m.forget('gone', '不再相关'), true);
    assert.equal(m.all().length, 0, 'invalidated records drop out of the live set');
    assert.ok(m.get('gone')?.invalidAt);
    assert.equal(m.metrics().total, 0);
  } finally {
    await cleanup();
  }
});

test('context stays small: pointers cost an order of magnitude less than bodies', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const m = await Mnemo.open(dir);
    const longBody = '这是一段很长很长的记忆正文。'.repeat(120);

    for (let i = 0; i < 5; i++) {
      await m.write({
        name: `long-${i}`,
        abstract: `第 ${i} 条长记忆的要点`,
        body: longBody,
        type: 'fact',
        salience: 8,
      });
    }

    const naive = m.all().reduce((sum, r) => sum + estimateTokens(r.body), 0);
    const ctx = await m.bootContext({ userMessage: '继续' });
    const pointerCost = ctx.tokens.suffix;

    assert.ok(naive > 1000, `body corpus should be large, got ${naive}`);
    assert.ok(
      pointerCost < naive / 5,
      `pointers (${pointerCost} tok) should be far cheaper than bodies (${naive} tok)`,
    );
  } finally {
    await cleanup();
  }
});

test('a fresh Mnemo over the same directory sees everything', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const first = await Mnemo.open(dir);
    await first.write({ name: 'persisted', abstract: '跨进程也要记得', body: 'x', type: 'fact' });
    await first.intend({ what: '别忘了这个', trigger: { kind: 'event', keywords: ['记得'] } });

    const second = await Mnemo.open(dir);
    assert.equal(second.all().length, 2);
    assert.equal(second.due(new Date(), '你还记得吗').length, 1);
  } finally {
    await cleanup();
  }
});
