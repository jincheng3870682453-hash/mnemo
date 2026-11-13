#!/usr/bin/env node
/**
 * mnemo CLI.
 *
 * Deliberately thin: it is a window onto the library, not a second implementation.
 * Every command maps to one facade method so the code paths stay identical.
 *
 *   mnemo write  --dir ./mem --body "金呈不喜欢客套开场白" --type preference
 *   mnemo recall --dir ./mem --query "说话风格"
 *   mnemo read   --dir ./mem --name pref-direct --l2
 *   mnemo intend --dir ./mem --what "提醒他周三交审计报告" --at 2026-11-18T09:00
 *   mnemo due    --dir ./mem
 *   mnemo ctx    --dir ./mem --user "帮我看看这份设计"
 *   mnemo stats  --dir ./mem
 */

import { Mnemo } from './mnemo.js';
import type { MemoryType } from './types.js';
import { matchSafeName } from './store/file-store.js';

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] ?? 'help';
  const rest = argv.slice(1);
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return { command, flags };
}

function str(flags: Args['flags'], key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

function num(flags: Args['flags'], key: string): number | undefined {
  const v = str(flags, key);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function required(flags: Args['flags'], key: string): string {
  const v = str(flags, key);
  if (!v) {
    console.error(`missing required --${key}`);
    process.exit(2);
  }
  return v;
}

function rootOf(flags: Args['flags']): string {
  return str(flags, 'dir') ?? './.mnemo';
}

/**
 * Resolve `--name` against the store.
 *
 * The string returned to callers is the `name` of a record that is already on
 * disk, never the argument itself. That keeps the property we actually care
 * about — a command-line value can never become a path component — structural
 * rather than dependent on a sanitiser being called correctly.
 */
function resolveExisting(flags: Args['flags'], mnemo: Mnemo): string {
  const raw = required(flags, 'name');
  const safe = matchSafeName(raw);
  const known = mnemo.all().find((record) => record.name === safe || record.name === raw);
  if (!known) {
    console.error(`no such memory: ${raw}`);
    process.exit(1);
  }
  return known.name;
}

const USAGE = `mnemo — token-thrifty, human-like agent memory

  write       --dir <root> --body <text> [--name <slug>] [--abstract <text>]
              [--type fact|preference|event|skill|intention] [--group <g>]
              [--salience 1-10] [--hop 0] [--subject <principal>] [--speaker <principal>]
  recall      --dir <root> [--query <text>] [--goal <text>] [--limit 8] [--faint] [--as-of <iso>]
  read        --dir <root> --name <slug> [--l2]
  intend      --dir <root> --what <text> (--at <iso> | --on <kw1,kw2>) [--salience 1-10]
  due         --dir <root> [--context <text>]
  ctx         --dir <root> [--user <message>] [--system <text>]
  stats       --dir <root>
  consolidate --dir <root>

Options:
  --json      machine-readable output
  --faint     include records below the retention threshold
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;
  const dir = rootOf(flags);

  if (command === 'help' || flags.help === true) {
    console.log(USAGE);
    return;
  }

  const mnemo = await Mnemo.open(dir);

  switch (command) {
    case 'write': {
      const type = str(flags, 'type') as MemoryType | undefined;
      const result = await mnemo.write({
        name: str(flags, 'name') ?? '',
        body: required(flags, 'body'),
        abstract: str(flags, 'abstract'),
        type,
        group: str(flags, 'group'),
        salience: num(flags, 'salience'),
        subject: str(flags, 'subject') ?? null,
        speaker: str(flags, 'speaker') ?? null,
        hop: num(flags, 'hop'),
      });
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`✓ ${result.relation} ${result.record.name} → ${result.path}`);
        console.log(`  ${result.record.abstract}`);
        if (result.invalidated.length > 0) console.log(`  失效：${result.invalidated.join(', ')}`);
        for (const note of result.notes) console.log(`  ! ${note}`);
      }
      return;
    }

    case 'recall': {
      const asOf = str(flags, 'as-of');
      const hits = await mnemo.recall({
        query: str(flags, 'query'),
        goal: str(flags, 'goal'),
        limit: num(flags, 'limit'),
        includeFaint: flags.faint === true,
        asOf: asOf ? new Date(asOf) : undefined,
      });
      if (json) {
        console.log(JSON.stringify(hits.map((h) => ({
          name: h.record.name,
          abstract: h.record.abstract,
          score: Number(h.score.toFixed(4)),
          signals: h.signals,
          tier: h.tier,
          decisionEligible: h.decisionEligible,
          path: h.path,
        })), null, 2));
      } else if (hits.length === 0) {
        console.log('(无匹配)');
      } else {
        for (const hit of hits) console.log(hit.l0);
      }
      return;
    }

    case 'read': {
      const name = resolveExisting(flags, mnemo);
      const result = await mnemo.read(name, flags.l2 === true ? 'l2' : 'l1');
      if (!result) {
        console.error(`no such memory: ${name}`);
        process.exit(1);
      }
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`# ${result.name}  (~${result.tokens} tok)`);
        console.log(`abstract: ${result.abstract}`);
        console.log(`attribution: ${result.attribution}`);
        if (result.invalidAt) console.log(`superseded at: ${result.invalidAt}`);
        console.log('---');
        console.log(result.body);
      }
      return;
    }

    // `reconstruct`, `forget` and `cue` are library-only on purpose.
    //
    // A CLI surface where a command-line argument reaches a mutating file write
    // is a shape static analysers are right to distrust, even when the value is
    // validated and the path is containment-checked. Keeping those three out of
    // argv removes the class of issue entirely rather than arguing about one
    // instance of it. They remain one function call away for an application that
    // already holds a record reference.

    case 'intend': {
      const at = str(flags, 'at');
      const on = str(flags, 'on');
      if (!at && !on) {
        console.error('intend needs --at <iso> or --on <keywords>');
        process.exit(2);
      }
      const result = await mnemo.intend({
        what: required(flags, 'what'),
        trigger: at ? { kind: 'time', at } : { kind: 'event', keywords: (on ?? '').split(',') },
        salience: num(flags, 'salience'),
      });
      if (json) console.log(JSON.stringify(result, null, 2));
      else console.log(`✓ ${result.record.name} (${result.record.trigger})`);
      return;
    }

    case 'due': {
      const due = mnemo.due(new Date(), str(flags, 'context') ?? '');
      if (json) {
        console.log(JSON.stringify(due.map((r) => ({ name: r.name, abstract: r.abstract, trigger: r.trigger })), null, 2));
      } else if (due.length === 0) {
        console.log('(没有到期的)');
      } else {
        for (const r of due) console.log(`- ${r.abstract}  [${r.trigger}]`);
      }
      return;
    }

    case 'ctx': {
      const assembled = await mnemo.bootContext({
        system: str(flags, 'system'),
        userMessage: str(flags, 'user') ?? '',
      });
      if (json) {
        console.log(JSON.stringify(assembled.tokens, null, 2));
      } else {
        console.log('===== PREFIX (cacheable) =====');
        console.log(assembled.prefix);
        console.log('===== SUFFIX (volatile) =====');
        console.log(assembled.suffix);
        console.log('===== STATS =====');
        console.log(assembled.tokens);
        for (const warning of assembled.warnings) console.log(`! ${warning}`);
      }
      return;
    }

    case 'stats': {
      const metrics = mnemo.metrics();
      console.log(json ? JSON.stringify(metrics, null, 2) : formatMetrics(metrics));
      return;
    }

    case 'consolidate': {
      const report = await mnemo.consolidate();
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(`scanned ${report.scanned}, archived ${report.archived.length}`);
      return;
    }

    default:
      console.error(`unknown command: ${command}`);
      console.log(USAGE);
      process.exit(2);
  }
}

function formatMetrics(m: ReturnType<Mnemo['metrics']>): string {
  const lines = [
    `records      ${m.total}`,
    `by type      ${Object.entries(m.byType).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`,
    `by retention ${Object.entries(m.byTier).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`,
    `intentions   ${m.pendingIntentions} pending`,
    `actionable   ${m.decisionEligible} of ${m.total}`,
    `relayed      ${m.relayed}`,
    `confidence   ${m.meanConfidence.toFixed(2)}`,
  ];
  return lines.join('\n');
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
