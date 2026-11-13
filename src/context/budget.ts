/**
 * Budgeted selection: buy the most value you can afford.
 *
 * The naive way to fit retrieved memories into a token budget is to take the top
 * k, or to concatenate until the budget runs out. Both waste it: a 200-token
 * memory that ranks 3rd may be worth less per token than a 40-token memory that
 * ranks 5th, and truncating mid-list silently drops whatever came last.
 *
 * This is the formulation the retrieval literature uses: maximise total value
 * subject to a token cost, then fill. Greedy by value-per-token is within a
 * constant factor of optimal for this shape and is deterministic, which matters
 * more than the last few percent.
 *
 * One rule that is not from the greedy loop: the single best item is always
 * included if it fits at all. A budget that returns *nothing* relevant is worse
 * than a slightly over-budget one.
 */

import { estimateTokens } from '../util/text.js';

export interface BudgetItem {
  id: string;
  /** The rendered line that will enter the prompt. */
  text: string;
  /** Retrieval score. Higher is better. */
  score: number;
  /** Override the measured cost, e.g. when a body will be inlined. */
  tokens?: number;
}

export interface BudgetSelection {
  /** Selected items, in descending score order (presentation order). */
  kept: BudgetItem[];
  keptTokens: number;
  dropped: number;
  droppedTokens: number;
  /** True when at least one item had to be left out. */
  truncated: boolean;
}

/**
 * Greedy value-per-token fill.
 *
 * @param reserve tokens held back for the "...N more" notice.
 */
export function selectByValuePerToken(
  items: ReadonlyArray<BudgetItem>,
  budget: number,
  reserve = 24,
): BudgetSelection {
  if (items.length === 0 || budget <= 0) {
    return {
      kept: [],
      keptTokens: 0,
      dropped: items.length,
      droppedTokens: items.reduce((sum, item) => sum + costOf(item), 0),
      truncated: items.length > 0,
    };
  }

  const affordable = Math.max(0, budget - reserve);
  const scored = items.map((item) => {
    const tokens = costOf(item);
    return { item, tokens, density: item.score / Math.max(1, tokens) };
  });

  // Deterministic: density, then score, then id.
  scored.sort(
    (a, b) => b.density - a.density || b.item.score - a.item.score || a.item.id.localeCompare(b.item.id),
  );

  const kept: BudgetItem[] = [];
  let used = 0;
  let droppedTokens = 0;

  for (const entry of scored) {
    const fits = used + entry.tokens <= affordable;
    const betterThanNothing = kept.length === 0 && entry.tokens <= budget;
    if (fits || betterThanNothing) {
      kept.push(entry.item);
      used += entry.tokens;
    } else {
      droppedTokens += entry.tokens;
    }
  }

  kept.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  return {
    kept,
    keptTokens: used,
    dropped: items.length - kept.length,
    droppedTokens,
    truncated: items.length > kept.length,
  };
}

function costOf(item: BudgetItem): number {
  return Math.max(1, item.tokens ?? estimateTokens(item.text));
}

/**
 * Render a selection as a block, appending an explicit notice when items were
 * dropped. Silent truncation is the failure this exists to prevent: a model that
 * does not know it is seeing a partial list will answer as if it has everything.
 */
export function renderSelection(selection: BudgetSelection, label = '相关记忆'): string {
  const lines = selection.kept.map((item) => item.text);
  if (selection.truncated) {
    lines.push(`…（${label}另有 ${selection.dropped} 条因预算未放入，可缩小查询范围）`);
  }
  return lines.join('\n');
}
