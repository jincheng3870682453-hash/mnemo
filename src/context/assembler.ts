/**
 * Context assembly with an explicit cache boundary.
 *
 * The single highest-leverage cost optimisation in an agent is not compression,
 * it is *ordering*: providers discount repeated prefixes heavily (one provider's
 * cache-hit price is 2% of its miss price) and a single dynamic field moved into
 * the prefix can take the hit rate from ~99% to 0%.
 *
 * So `assemble()` returns two strings, not one:
 *
 *   prefix  — system, tool definitions, persona, memory index. Byte-stable,
 *             append-only, never contains a timestamp or session id.
 *   suffix  — intentions, retrieved pointers, task canvas, the user's message.
 *             Allowed to change every turn.
 *
 * The caller submits `prefix` with a cache breakpoint at its end. Everything the
 * library controls lives on the correct side of that line.
 */

import type { BudgetConfig, MemoryRecord } from '../types.js';
import { estimateTokens, truncate } from '../util/text.js';
import { daysBetween } from '../util/time.js';
import { renderSelection, selectByValuePerToken, type BudgetItem } from './budget.js';

export interface ContextInput {
  /** Stable system prompt. Must not contain timestamps, ids or counters. */
  system?: string;
  /** Tool definitions. Serialise them in a fixed order; see `stableToolBlock`. */
  tools?: string;
  /** Persona / style block. Stable. */
  persona?: string;
  /** The MEMORY.md index. Stable and append-only. */
  memoryIndex?: string;
  /** "Things you are keeping an eye on" — due or upcoming intentions. */
  pending?: string;
  /** L0 lines from `retrieve()`. */
  retrieved?: readonly string[];
  /**
   * Scored L0 items. When supplied, the retrieved budget is filled by value per
   * token instead of truncating the list — see context/budget.ts.
   */
  retrievedItems?: ReadonlyArray<BudgetItem>;
  /** Compact task state for long-running work. */
  taskCanvas?: string;
  /** This turn's user message. */
  userMessage: string;
}

export interface AssembledContext {
  /** Stable, cacheable portion. Put the cache breakpoint right after this. */
  prefix: string;
  /** Volatile portion. */
  suffix: string;
  full: string;
  tokens: {
    prefix: number;
    suffix: number;
    total: number;
    budget: number;
    /** Fraction of the total input that is cacheable. */
    cacheableRatio: number;
  };
  /** Emitted when a budget was exceeded and content was trimmed. Never silent. */
  warnings: string[];
}

const SECTION = {
  system: '## 你的角色',
  tools: '## 可用工具',
  persona: '## 说话方式',
  memoryIndex: '## 你记得的事',
  pending: '## 你记挂的事',
  retrieved: '## 可能相关的记忆（只是索引，需要细节请读文件）',
  canvas: '## 当前任务',
  user: '## 用户说',
};

function section(title: string, body: string): string {
  return `${title}\n${body.trim()}\n`;
}

/** Trim a block to a token budget by dropping trailing lines, and say so. */
export function trimToBudget(
  text: string,
  budget: number,
  label: string,
): { text: string; trimmed: boolean; dropped: number } {
  if (budget <= 0) return { text: '', trimmed: text.length > 0, dropped: text.split('\n').length };
  if (estimateTokens(text) <= budget) return { text, trimmed: false, dropped: 0 };

  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > budget * 0.9) break;
    kept.push(line);
    used += cost;
  }
  const dropped = lines.length - kept.length;
  const notice = `\n…（${label} 还有 ${dropped} 行未放入）`;
  return { text: kept.join('\n') + notice, trimmed: true, dropped };
}

export function assemble(input: ContextInput, budget: BudgetConfig): AssembledContext {
  const warnings: string[] = [];

  // ---- prefix: stable bytes only -----------------------------------------
  const prefixParts: string[] = [];
  if (input.system) {
    const t = trimToBudget(input.system, budget.system, '系统提示');
    if (t.trimmed) warnings.push(`system trimmed: dropped ${t.dropped} lines`);
    prefixParts.push(section(SECTION.system, t.text));
  }
  if (input.tools) {
    prefixParts.push(section(SECTION.tools, input.tools));
  }
  if (input.persona) {
    prefixParts.push(section(SECTION.persona, input.persona));
  }
  if (input.memoryIndex) {
    const t = trimToBudget(input.memoryIndex, budget.memoryIndex, '记忆索引');
    if (t.trimmed) warnings.push(`memoryIndex trimmed: dropped ${t.dropped} lines`);
    prefixParts.push(section(SECTION.memoryIndex, t.text));
  }
  const prefix = prefixParts.join('\n');

  // ---- suffix: everything allowed to change per turn ----------------------
  const suffixParts: string[] = [];
  if (input.pending) {
    suffixParts.push(section(SECTION.pending, input.pending));
  }
  if (input.retrievedItems && input.retrievedItems.length > 0) {
    const selection = selectByValuePerToken(input.retrievedItems, budget.retrieved);
    if (selection.truncated) {
      warnings.push(
        `retrieved: kept ${selection.kept.length}, dropped ${selection.dropped} over budget`,
      );
    }
    suffixParts.push(section(SECTION.retrieved, renderSelection(selection)));
  } else if (input.retrieved && input.retrieved.length > 0) {
    const block = input.retrieved.join('\n');
    const t = trimToBudget(block, budget.retrieved, '相关记忆');
    if (t.trimmed) warnings.push(`retrieved trimmed: dropped ${t.dropped} lines`);
    suffixParts.push(section(SECTION.retrieved, t.text));
  }
  if (input.taskCanvas) {
    const t = trimToBudget(input.taskCanvas, budget.taskCanvas, '任务画布');
    if (t.trimmed) warnings.push(`taskCanvas trimmed: dropped ${t.dropped} lines`);
    suffixParts.push(section(SECTION.canvas, t.text));
  }
  const userBudgeted = trimToBudget(input.userMessage, budget.userMessage, '用户输入');
  if (userBudgeted.trimmed) warnings.push('userMessage exceeded budget and was truncated');
  suffixParts.push(section(SECTION.user, userBudgeted.text));
  const suffix = suffixParts.join('\n');

  const prefixTokens = estimateTokens(prefix);
  const suffixTokens = estimateTokens(suffix);
  const total = prefixTokens + suffixTokens;
  const layerBudget =
    budget.system + budget.memoryIndex + budget.retrieved + budget.taskCanvas + budget.userMessage;

  return {
    prefix,
    suffix,
    full: `${prefix}\n${suffix}`,
    tokens: {
      prefix: prefixTokens,
      suffix: suffixTokens,
      total,
      budget: layerBudget,
      cacheableRatio: total > 0 ? prefixTokens / total : 0,
    },
    warnings,
  };
}

/**
 * Serialise tool definitions in a deterministic order with sorted keys.
 *
 * Tool schemas that differ only in key order produce different bytes and miss the
 * cache every single time. MCP servers that re-discover tools per session are the
 * usual culprit.
 */
export function stableToolBlock(tools: ReadonlyArray<Record<string, unknown>>): string {
  const sortDeep = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
      return out;
    }
    return value;
  };
  const serialised = tools.map((t) => JSON.stringify(sortDeep(t)));
  serialised.sort();
  return serialised.join('\n');
}

/**
 * Build the resident MEMORY.md index.
 *
 * This is the only unconditionally injected content in the whole system, so it is
 * strictly capped: persona lines plus the newest/highest-salience facts. Older
 * material stays reachable through `retrieve()` but is not resident.
 */
export function buildMemoryIndex(
  records: ReadonlyArray<MemoryRecord>,
  opts: { maxLines?: number; now?: Date; title?: string } = {},
): string {
  const maxLines = opts.maxLines ?? 12;
  const now = opts.now ?? new Date();
  const title = opts.title ?? '# Memory';

  const persona = records
    .filter((r) => r.type === 'persona' && !r.invalidAt)
    .sort((a, b) => b.salience - a.salience)
    .slice(0, 4);

  const rest = records
    .filter((r) => r.type !== 'persona' && r.type !== 'intention' && !r.invalidAt)
    .sort((a, b) => {
      const sa = a.salience * (1 / (1 + daysBetween(a.validFrom, now) / 30));
      const sb = b.salience * (1 / (1 + daysBetween(b.validFrom, now) / 30));
      return sb - sa;
    })
    .slice(0, Math.max(0, maxLines - persona.length));

  const lines: string[] = [title, ''];
  if (persona.length > 0) {
    lines.push('## 关于他们', '');
    for (const r of persona) lines.push(`- ${truncate(r.abstract, 60)} → \`${r.name}\``);
    lines.push('');
  }
  if (rest.length > 0) {
    lines.push('## 常驻事实', '');
    for (const r of rest) lines.push(`- ${truncate(r.abstract, 60)} → \`${r.name}\``);
  }
  return lines.join('\n').trim();
}
