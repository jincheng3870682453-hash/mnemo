#!/usr/bin/env node
/**
 * Download a small OASST1 slice and convert it to the dialogue benchmark format.
 *
 *   node bench/data/fetch.mjs [count]
 *
 * Auto-labels are heuristic: a "fact" is the first sentence of an assistant
 * message, and its query is the first 40 characters of the preceding user
 * message. That is good enough to cross-check the curated corpus, not to
 * replace it. See BENCHMARK.md §2.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const API =
  'https://datasets-server.huggingface.co/rows?dataset=OpenAssistant/oasst1&config=default&split=train';
const MAX_TURNS = 8;
const MAX_DIALOGUES = Number.parseInt(process.argv[2] ?? '20', 10) || 20;

const clip = (text, n) => (text.length <= n ? text : text.slice(0, n - 1) + '…');

function firstSentence(text) {
  const m = text.match(/^(.{1,120}?)[。！？.!?\n]/);
  return (m ? m[1] : text).trim();
}

async function main() {
  console.log(`fetching OASST1 rows from HuggingFace…`);
  const res = await fetch(`${API}&offset=0&length=${MAX_DIALOGUES * MAX_TURNS * 2}`);
  if (!res.ok) throw new Error(`HuggingFace ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const rows = (data.rows ?? []).map((r) => r.row).filter((r) => r.text && r.role);

  const dialogues = [];
  let turns = [];
  let facts = [];
  let queries = [];

  const flush = () => {
    if (turns.length >= 2) {
      const id = `oasst-${String(dialogues.length + 1).padStart(3, '0')}`;
      dialogues.push({ id, domain: 'oasst', source: 'OpenAssistant/oasst1 (auto-labelled)', turns, facts, queries });
    }
    turns = [];
    facts = [];
    queries = [];
  };

  for (let i = 0; i < rows.length && dialogues.length < MAX_DIALOGUES; i++) {
    const row = rows[i];
    const text = String(row.text).trim();
    if (!text) continue;

    if (row.role === 'assistant' && turns.length > 0 && turns[turns.length - 1].role === 'user') {
      const turnIndex = turns.length;
      turns.push({ role: 'assistant', text });

      const userText = turns[turnIndex - 1].text;
      const factName = `${dialogues.length + 1}-f${facts.length + 1}`;
      const abstract = clip(firstSentence(text), 60);
      facts.push({
        name: factName,
        abstract,
        body: text,
        type: 'fact',
        salience: 5,
        turn: turnIndex,
      });
      queries.push({
        q: clip(userText.replace(/\s+/g, ' '), 40),
        expectFact: factName,
        expectTurn: turnIndex - 1,
      });

      if (turns.length >= MAX_TURNS) flush();
    } else if (row.role === 'user') {
      turns.push({ role: 'user', text });
    }
  }
  flush();

  if (dialogues.length === 0) throw new Error('no usable dialogues parsed');

  const out = path.resolve(process.cwd(), 'bench/data/dialogues.oasst.jsonl');
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, dialogues.map((d) => JSON.stringify(d)).join('\n'), 'utf8');
  console.log(`wrote ${dialogues.length} dialogues to bench/data/dialogues.oasst.jsonl`);
  console.log(`run: node dist/bench/dialogue.js bench/data/dialogues.oasst.jsonl`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
