/**
 * A five-minute tour of mnemo.
 *
 *   npm run build && node dist/examples/basic.js
 *
 * Everything here works offline: no API key, no model, no network. When you do
 * plug in a model, the same calls produce better gists — the mechanics do not change.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Mnemo } from '../src/index.js';

async function main(): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-demo-'));
  try {
    const mem = await Mnemo.open(path.join(dir, 'store'), {
      userPrincipal: 'user:jincheng',
      agentPrincipal: 'agent:self',
    });

    // ---- 1. remembering ----------------------------------------------------
    await mem.write({
      name: 'pref-direct',
      abstract: '金呈不喜欢客套开场白',
      body: '他说过：不要"很高兴为您服务"这种开头，直接说结论，带评级和优先级。',
      type: 'preference',
      group: 'user-tone',
      salience: 9,
      future: ['生成任何回复前', '写正式文档前'],
    });

    await mem.write({
      name: 'fact-stack',
      abstract: '技术栈是 Electron + 自研 Rust 渲染',
      body: '不用 Unity 或 Godot，渲染层是自己写的 wgpu。',
      type: 'fact',
      group: 'work',
      salience: 7,
    });

    // ---- 2. second-hand claims are quarantined ------------------------------
    const relayed = await mem.write({
      name: 'heard-tool',
      abstract: '听说金呈喜欢用 X 工具',
      body: '来自一个第三方帖子，帖子里引用了它自己用户的话。',
      type: 'preference',
      hop: 1,
      subject: 'user:someone-else',
      speaker: 'agent:mallory',
    });
    console.log('[attribution]', relayed.record.type, '|', relayed.notes.join('; ') || 'no notes');

    // ---- 3. recall returns pointers, not content ---------------------------
    console.log('\n[recall: 说话风格]');
    for (const line of await mem.recallLines({ query: '说话风格 开场白' })) {
      console.log(' ', line);
    }

    // ---- 4. detail is a separate, explicit, expensive step -----------------
    const detail = await mem.read('pref-direct', 'l2');
    console.log('\n[read l2] cost =', detail?.tokens, 'tok');
    console.log(' ', detail?.body.slice(0, 40), '...');

    // ---- 5. changing your mind keeps both beliefs --------------------------
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await mem.write({
      name: 'tone-v1',
      abstract: '金呈喜欢详细解释',
      body: '早期认知',
      type: 'preference',
      validFrom: threeDaysAgo,
    });
    const reversed = await mem.write({
      name: 'tone-v2',
      abstract: '金呈不喜欢详细解释',
      body: '改主意了：要结论先行',
      type: 'preference',
    });
    console.log('\n[supersede]', reversed.relation, '→ invalidated', reversed.invalidated);

    const asOfLastWeek = new Date(Date.now() - 2 * 86_400_000);
    const then = await mem.recall({ query: '详细解释', asOf: asOfLastWeek });
    console.log('[as-of 2 days ago] believed:', then.map((h) => h.record.abstract).join(' / ') || '(nothing yet)');
    const today = await mem.recall({ query: '详细解释' });
    console.log('[today] believes:', today.map((h) => h.record.abstract).join(' / '));

    // ---- 6. prospective memory: it remembers *for* you ---------------------
    await mem.intend({
      what: '提醒他周三交审计报告',
      trigger: { kind: 'time', at: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    });
    await mem.intend({
      what: '聊到审计时问一句进展',
      trigger: { kind: 'event', keywords: ['审计'] },
    });
    console.log('\n[keeping an eye on]');
    for (const line of mem.pendingLines().split('\n')) console.log(' ', line);
    console.log('[event trigger on "审计"] fired:', mem.due(new Date(), '聊聊审计吧').length);

    // ---- 7. what a model actually sees at the start of a session -----------
    const ctx = await mem.bootContext({ userMessage: '帮我看看这个设计' });
    console.log('\n[context] tokens:', ctx.tokens);
    console.log('[context] cacheable prefix:\n' + ctx.prefix);

    // ---- 8. offloading a big tool result -----------------------------------
    const bigOutput = Array.from({ length: 300 }, (_, i) => `搜索结果 ${i}: 关于 electron asar 的讨论`).join('\n');
    const offloaded = await mem.offload('session-1', 'web_search', bigOutput);
    console.log('\n[offload] saved', offloaded.savedTokens, 'tok; context sees:');
    console.log(' ', offloaded.inline.split('\n')[0]);

    console.log('\n[metrics]', mem.metrics());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
