/**
 * Adaptive tuning benchmark: hand-tuned defaults vs a learned policy.
 *
 *   npm run bench:adaptive
 *
 * Both arms run over the same dialogues, with the same facts and the same
 * queries. The only difference is whether `adaptive.enabled` is on. The
 * adaptive run receives *oracle feedback* — 1.0 when the labelled fact was in
 * the returned pointers, 0.0 when it was not — which is the best case for the
 * bandit and therefore an upper bound on what it can achieve in production.
 *
 * Reported:
 *   recall@1/@3   same labelled questions as `bench:dialogue`
 *   ctx tokens    pointer-only context over the whole corpus
 *   arm mix       how often each preset was chosen, and its mean reward
 *
 * Caveat: oracle feedback is not available to a real caller. In production the
 * tuner only gets `read()` heuristics plus explicit `feedback()`. Treat the
 * adaptive column as "what the policy can do when its signal is clean", not as
 * a promised improvement.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Mnemo } from '../src/index.js';
import type { MemoryType } from '../src/index.js';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

interface Fact {
  name: string;
  abstract: string;
  body: string;
  type: MemoryType;
  salience: number;
}

interface Query {
  q: string;
  expectFact: string;
}

interface Dialogue {
  id: string;
  domain: string;
  turns: Turn[];
  facts: Fact[];
  queries: Query[];
}

interface RunResult {
  label: string;
  ctxTokens: number;
  hit1: number;
  hit3: number;
  queries: number;
  arms: Array<{ label: string; pulls: number; meanReward: number }>;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function loadDialogues(): Promise<Dialogue[]> {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(path.resolve(process.cwd(), 'bench/data/dialogues.jsonl'), 'utf8');
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Dialogue);
}

async function seed(mem: Mnemo, dialogue: Dialogue): Promise<void> {
  for (const fact of dialogue.facts) {
    await mem.write({
      name: fact.name,
      abstract: fact.abstract,
      body: fact.body,
      type: fact.type,
      salience: fact.salience,
      subject: 'user:bench',
      speaker: 'user:bench',
      hop: 0,
    });
  }
}

async function run(
  label: string,
  dialogues: Dialogue[],
  adaptive: boolean,
  root: string,
): Promise<RunResult> {
  const mem = await Mnemo.open(path.join(root, label.replace(/\s+/g, '-')), {
    userPrincipal: 'user:bench',
    adaptive: adaptive ? { enabled: true, warmup: 0 } : undefined,
  });

  let ctxTokens = 0;
  let hit1 = 0;
  let hit3 = 0;
  let queryCount = 0;

  for (const dialogue of dialogues) {
    await seed(mem, dialogue);

    for (const turn of dialogue.turns) {
      const ctx = await mem.bootContext({ userMessage: turn.text });
      ctxTokens += ctx.tokens.total;
    }

    for (const query of dialogue.queries) {
      const hits = await mem.recall({ query: query.q, limit: 3 });
      const names = hits.map((hit) => hit.record.name);
      const ok = names.includes(query.expectFact);
      if (names[0] === query.expectFact) hit1++;
      if (ok) hit3++;
      queryCount++;
      if (adaptive) mem.feedback(ok ? 1 : 0);
    }
  }

  const stats = mem.adaptiveStats();
  return {
    label,
    ctxTokens,
    hit1,
    hit3,
    queries: queryCount,
    arms: stats.arms.map((arm) => ({
      label: arm.label,
      pulls: arm.pulls,
      meanReward: arm.meanReward,
    })),
  };
}

async function main(): Promise<void> {
  const dialogues = await loadDialogues();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mnemo-adaptive-bench-'));
  process.stdout.write('\nmnemo adaptive tuning benchmark\n');
  process.stdout.write(`corpus: ${dialogues.length} dialogues\n\n`);

  try {
    const fixed = await run('fixed defaults', dialogues, false, root);
    const learned = await run('adaptive', dialogues, true, root);

    const line = (name: string, fixedValue: string, learnedValue: string): string =>
      `  ${name.padEnd(20)} ${fixedValue.padStart(12)} ${learnedValue.padStart(12)}\n`;

    process.stdout.write(`  ${'metric'.padEnd(20)} ${'fixed'.padStart(12)} ${'adaptive'.padStart(12)}\n`);
    process.stdout.write(line('recall@1', pct(fixed.hit1 / Math.max(1, fixed.queries)), pct(learned.hit1 / Math.max(1, learned.queries))));
    process.stdout.write(line('recall@3', pct(fixed.hit3 / Math.max(1, fixed.queries)), pct(learned.hit3 / Math.max(1, learned.queries))));
    process.stdout.write(line('context tokens', String(fixed.ctxTokens), String(learned.ctxTokens)));
    process.stdout.write(line('queries', String(fixed.queries), String(learned.queries)));

    process.stdout.write('\narm mix (adaptive run)\n');
    for (const arm of learned.arms) {
      process.stdout.write(
        `  ${arm.label.padEnd(18)} pulls ${String(arm.pulls).padStart(4)} · mean reward ${arm.meanReward.toFixed(2)}\n`,
      );
    }

    process.stdout.write(
      '\nCaveat: the adaptive run gets oracle feedback (was the labelled fact in the\n' +
        'returned pointers). A real caller only has read()/feedback(), so this is an\n' +
        'upper bound, not a promised production gain.\n\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
