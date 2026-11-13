/**
 * Dialogue benchmark: the same conversations, two very different memories.
 *
 *   npm run bench:dialogue
 *
 * What is compared
 * ----------------
 *   naive   — the transcript itself is the memory. Every turn resends the whole
 *             conversation so far, and "retrieval" is BM25 over raw turns.
 *   mnemo   — facts are written once, then each turn boots a pointer-only
 *             context (system + index + at most a handful of L0 lines).
 *
 * Both systems are asked the same labelled questions about the same dialogues.
 * The dataset ships in `bench/data/dialogues.jsonl`; every fact names the turn
 * that asserts it, and every query names the turn that answers it, so the two
 * systems can be scored without a model judge.
 *
 * Metrics
 * -------
 *   ctx tokens      tokens that would enter the prompt over the whole dialogue
 *                   (naive resends the transcript; mnemo boots a fresh context)
 *   tokens / turn   the same number, normalised, because dialogue lengths differ
 *   recall@1/@3     is the labelled fact/turn in the returned top-1 / top-3
 *   probe saving    feeling-of-knowing line vs a full recall, same queries
 *
 * Honesty notes
 * -------------
 * • The corpus is a curated set of real-looking conversations, not a peer-reviewed
 *   benchmark. It is larger and more varied than the synthetic consolidation
 *   corpus, and the labels are explicit, but it is still authored by the same
 *   person who wrote the library.
 * • The naive baseline is deliberately strong: it gets the entire transcript,
 *   un-truncated, at every turn. That is the point — the comparison is against
 *   the thing people actually do when they have no memory layer.
 * • `bench/data/fetch.mjs` can pull additional conversations from a public
 *   dataset, but its automatic labels are weaker than the curated ones. Report
 *   the curated number; use the downloaded set as a cross-check.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BM25Index, DEFAULT_SYSTEM, Mnemo, estimateTokens, tokenize } from '../src/index.js';
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
  turn: number;
}

interface Query {
  q: string;
  expectFact: string;
  expectTurn: number;
}

interface Dialogue {
  id: string;
  domain: string;
  source: string;
  turns: Turn[];
  facts: Fact[];
  queries: Query[];
}

interface SystemResult {
  ctxTokens: number;
  tokensPerTurn: number;
  hit1: number;
  hit3: number;
  queries: number;
  turns: number;
}

interface DialogueResult {
  id: string;
  domain: string;
  turns: number;
  facts: number;
  queries: number;
  mnemo: SystemResult;
  naive: SystemResult;
  probe: { probeTokens: number; recallTokens: number };
}

interface Report {
  generatedAt: string;
  corpus: { dialogues: number; turns: number; facts: number; queries: number };
  totals: {
    mnemo: SystemResult;
    naive: SystemResult;
    probe: { probeTokens: number; recallTokens: number };
  };
  byDomain: Array<{ domain: string; dialogues: number; queries: number; mnemoHit1: number; naiveHit1: number }>;
  /**
   * Analytical projection: per-turn context cost as a session grows. Naive is
   * linear in turns (it resends the transcript); mnemo is flat by construction.
   * Measured at the corpus average, so the 8-turn point reproduces `totals`.
   */
  costCurve: Array<{ turns: number; naive: number; mnemo: number }>;
  dialogues: DialogueResult[];
}

async function loadDialogues(file: string): Promise<Dialogue[]> {
  const raw = await readFile(file, 'utf8');
  const out: Dialogue[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as Dialogue);
  }
  if (out.length === 0) throw new Error(`no dialogues in ${file}`);
  return out;
}

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

async function runMnemo(
  dialogue: Dialogue,
  root: string,
): Promise<{ mnemo: SystemResult; probe: { probeTokens: number; recallTokens: number } }> {
  const mem = await Mnemo.open(path.join(root, dialogue.id), {
    userPrincipal: 'user:bench',
    agentPrincipal: 'agent:bench',
  });

  for (const fact of dialogue.facts) {
    await mem.write({
      name: fact.name,
      abstract: fact.abstract,
      body: fact.body,
      type: fact.type,
      salience: fact.salience,
      subject: 'user:bench',
      speaker: 'user:bench',
      addressee: 'agent:bench',
      hop: 0,
    });
  }

  // What a pointer-only memory would put in front of the model, turn by turn.
  let ctxTokens = 0;
  for (const turn of dialogue.turns) {
    const ctx = await mem.bootContext({ userMessage: turn.text });
    ctxTokens += ctx.tokens.total;
  }

  let hit1 = 0;
  let hit3 = 0;
  let probeTokens = 0;
  let recallTokens = 0;
  for (const query of dialogue.queries) {
    const hits = await mem.recall({ query: query.q, limit: 3 });
    const names = hits.map((hit) => hit.record.name);
    if (names[0] === query.expectFact) hit1++;
    if (names.includes(query.expectFact)) hit3++;

    probeTokens += estimateTokens(mem.feelLine(query.q));
    const lines = await mem.recallLines({ query: query.q, limit: 8 });
    recallTokens += lines.reduce((sum, line) => sum + estimateTokens(line), 0);
  }

  return {
    mnemo: {
      ctxTokens,
      tokensPerTurn: ctxTokens / Math.max(1, dialogue.turns.length),
      hit1,
      hit3,
      queries: dialogue.queries.length,
      turns: dialogue.turns.length,
    },
    probe: { probeTokens, recallTokens },
  };
}

function runNaive(dialogue: Dialogue): SystemResult {
  // Every turn resends the system prompt plus the whole transcript so far.
  const systemTokens = estimateTokens(DEFAULT_SYSTEM);
  const turnTokens = dialogue.turns.map((turn) =>
    estimateTokens(`${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`),
  );
  let cumulative = systemTokens;
  let ctxTokens = 0;
  for (const tokens of turnTokens) {
    cumulative += tokens;
    ctxTokens += cumulative;
  }

  const index = new BM25Index();
  dialogue.turns.forEach((turn, i) => index.add(String(i), tokenize(turn.text)));

  let hit1 = 0;
  let hit3 = 0;
  for (const query of dialogue.queries) {
    const hits = index.search(tokenize(query.q), 3).map((hit) => Number(hit.id));
    if (hits[0] === query.expectTurn) hit1++;
    if (hits.includes(query.expectTurn)) hit3++;
  }

  return {
    ctxTokens,
    tokensPerTurn: ctxTokens / Math.max(1, dialogue.turns.length),
    hit1,
    hit3,
    queries: dialogue.queries.length,
    turns: dialogue.turns.length,
  };
}

function emptySystem(): SystemResult {
  return { ctxTokens: 0, tokensPerTurn: 0, hit1: 0, hit3: 0, queries: 0, turns: 0 };
}

async function main(): Promise<void> {
  const dataPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.resolve(process.cwd(), 'bench/data/dialogues.jsonl');

  const dialogues = await loadDialogues(dataPath);
  const root = await mkdtemp(path.join(os.tmpdir(), 'mnemo-dialogue-'));

  process.stdout.write('\nmnemo dialogue benchmark\n');
  process.stdout.write(`corpus: ${dataPath}\n`);
  process.stdout.write(`         ${dialogues.length} dialogues\n\n`);

  try {
    const results: DialogueResult[] = [];
    for (const dialogue of dialogues) {
      const { mnemo, probe } = await runMnemo(dialogue, root);
      const naive = runNaive(dialogue);
      results.push({
        id: dialogue.id,
        domain: dialogue.domain,
        turns: dialogue.turns.length,
        facts: dialogue.facts.length,
        queries: dialogue.queries.length,
        mnemo,
        naive,
        probe,
      });
    }

    const totals = {
      mnemo: emptySystem(),
      naive: emptySystem(),
      probe: { probeTokens: 0, recallTokens: 0 },
    };
    for (const r of results) {
      totals.mnemo.ctxTokens += r.mnemo.ctxTokens;
      totals.mnemo.tokensPerTurn += r.mnemo.tokensPerTurn;
      totals.mnemo.hit1 += r.mnemo.hit1;
      totals.mnemo.hit3 += r.mnemo.hit3;
      totals.mnemo.queries += r.mnemo.queries;
      totals.mnemo.turns += r.mnemo.turns;

      totals.naive.ctxTokens += r.naive.ctxTokens;
      totals.naive.tokensPerTurn += r.naive.tokensPerTurn;
      totals.naive.hit1 += r.naive.hit1;
      totals.naive.hit3 += r.naive.hit3;
      totals.naive.queries += r.naive.queries;
      totals.naive.turns += r.naive.turns;

      totals.probe.probeTokens += r.probe.probeTokens;
      totals.probe.recallTokens += r.probe.recallTokens;
    }

    const turns = results.reduce((sum, r) => sum + r.turns, 0);
    const facts = results.reduce((sum, r) => sum + r.facts, 0);
    const queries = results.reduce((sum, r) => sum + r.queries, 0);
    totals.mnemo.tokensPerTurn = totals.mnemo.ctxTokens / Math.max(1, turns);
    totals.naive.tokensPerTurn = totals.naive.ctxTokens / Math.max(1, turns);

    const byDomain = new Map<string, { domain: string; dialogues: number; queries: number; mnemoHit1: number; naiveHit1: number }>();
    for (const r of results) {
      const entry = byDomain.get(r.domain) ?? {
        domain: r.domain,
        dialogues: 0,
        queries: 0,
        mnemoHit1: 0,
        naiveHit1: 0,
      };
      entry.dialogues += 1;
      entry.queries += r.queries;
      entry.mnemoHit1 += r.mnemo.hit1;
      entry.naiveHit1 += r.naive.hit1;
      byDomain.set(r.domain, entry);
    }

    // Per-turn cost projection over session length. The naive slope is the
    // corpus average turn size; the 8-turn point is calibrated to the measured
    // average so the chart cannot flatter either side.
    const systemTokens = estimateTokens(DEFAULT_SYSTEM);
    const totalTurnTokens = dialogues.reduce(
      (sum, dialogue) =>
        sum +
        dialogue.turns.reduce(
          (inner, turn) => inner + estimateTokens(`${turn.role === 'user' ? '用户' : '助手'}：${turn.text}`),
          0,
        ),
      0,
    );
    const avgTurnTokens = totalTurnTokens / Math.max(1, turns);
    const measuredMnemoPerTurn = totals.mnemo.ctxTokens / Math.max(1, turns);
    const costCurve = [8, 16, 32, 64, 128].map((n) => ({
      turns: n,
      naive: systemTokens + avgTurnTokens * ((n + 1) / 2),
      mnemo: measuredMnemoPerTurn,
    }));

    const report: Report = {
      generatedAt: new Date().toISOString(),
      corpus: { dialogues: dialogues.length, turns, facts, queries },
      totals,
      byDomain: [...byDomain.values()].sort((a, b) => a.domain.localeCompare(b.domain)),
      costCurve,
      dialogues: results,
    };

    const outDir = path.resolve(process.cwd(), 'bench/out');
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    // ---- console table -----------------------------------------------------
    const line = (label: string, naive: string, mnemo: string): string =>
      `  ${label.padEnd(22)} ${naive.padStart(13)} ${mnemo.padStart(13)}\n`;

    process.stdout.write(`  ${'metric'.padEnd(22)} ${'naive'.padStart(13)} ${'mnemo'.padStart(13)}\n`);
    process.stdout.write(line('context tokens', String(totals.naive.ctxTokens), String(totals.mnemo.ctxTokens)));
    process.stdout.write(line('tokens / turn', totals.naive.tokensPerTurn.toFixed(1), totals.mnemo.tokensPerTurn.toFixed(1)));
    process.stdout.write(
      line('recall@1', pct(totals.naive.hit1 / Math.max(1, queries)), pct(totals.mnemo.hit1 / Math.max(1, queries))),
    );
    process.stdout.write(
      line('recall@3', pct(totals.naive.hit3 / Math.max(1, queries)), pct(totals.mnemo.hit3 / Math.max(1, queries))),
    );

    const tokenSaving = totals.naive.ctxTokens === 0 ? 0 : 1 - totals.mnemo.ctxTokens / totals.naive.ctxTokens;
    const probeSaving =
      totals.probe.recallTokens === 0 ? 0 : 1 - totals.probe.probeTokens / totals.probe.recallTokens;

    process.stdout.write(`\ncontext ${pct(tokenSaving)} smaller over ${turns} turns\n`);
    process.stdout.write(
      `feeling-of-knowing probe: ${totals.probe.probeTokens} tok vs recall ${totals.probe.recallTokens} tok · ${pct(probeSaving)} cheaper\n`,
    );
    process.stdout.write(`\nreport: bench/out/report.json\n`);
    process.stdout.write(`render: npm run bench:render\n\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
