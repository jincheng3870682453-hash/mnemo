/**
 * Cue harvesting.
 *
 * Human recall is triggered by context, not by a query string: a smell, a place,
 * a name, a mood, the same time of year. This module turns the current situation
 * into cues that can fire recall without the caller composing a query.
 *
 * Honest limitation: entity extraction for CJK without a dictionary is unreliable,
 * so only *marked* entities are auto-extracted (@name, 「…」, "…", 《…》) plus
 * capitalised ASCII words. Anything else should be registered explicitly with
 * `Mnemo.cue()`. Guessing names would create noise that looks like signal.
 */

import type { Cue } from '../types.js';
import { cueToString } from '../types.js';
import { extractTimeExpressions, tokenize } from '../util/text.js';

const EMOTION_LEXICON: ReadonlyArray<readonly [string, string]> = [
  ['生气', 'anger'],
  ['愤怒', 'anger'],
  ['恼火', 'anger'],
  ['开心', 'joy'],
  ['高兴', 'joy'],
  ['兴奋', 'joy'],
  ['难过', 'sadness'],
  ['沮丧', 'sadness'],
  ['失望', 'disappointment'],
  ['焦虑', 'anxiety'],
  ['担心', 'anxiety'],
  ['紧张', 'anxiety'],
  ['害怕', 'fear'],
  ['恐惧', 'fear'],
  ['讨厌', 'dislike'],
  ['反感', 'dislike'],
  ['喜欢', 'like'],
  ['满意', 'satisfaction'],
  ['angry', 'anger'],
  ['furious', 'anger'],
  ['happy', 'joy'],
  ['excited', 'joy'],
  ['sad', 'sadness'],
  ['anxious', 'anxiety'],
  ['worried', 'anxiety'],
  ['afraid', 'fear'],
  ['hate', 'dislike'],
  ['love', 'like'],
];

const CJK_STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '可以', '就是',
  '因为', '所以', '但是', '而且', '然后', '如果', '已经', '还是', '一个',
  '现在', '时候', '这样', '那样', '不是', '没有', '自己', '知道', '觉得',
]);

const ASCII_STOP = new Set([
  'the', 'and', 'for', 'you', 'that', 'this', 'with', 'have', 'from',
  'are', 'was', 'were', 'but', 'not', 'can', 'will', 'would', 'there',
  'what', 'when', 'how', 'why', 'who', 'its', 'his', 'her', 'their',
]);

/** A cue is a weak hint; a *strong* cue is one the caller asserted explicitly. */
export interface HarvestedCue {
  cue: Cue;
  strength: number;
}

export function harvestCues(text: string, now: Date = new Date(), maxTopics = 6): Cue[] {
  const cues: Cue[] = [];
  const seen = new Set<string>();

  const push = (cue: Cue): void => {
    const key = cueToString(cue);
    if (seen.has(key)) return;
    seen.add(key);
    cues.push(cue);
  };

  // --- entities from explicit markers -------------------------------------
  for (const m of text.matchAll(/@([\p{L}\p{N}_-]{1,32})/gu)) push({ kind: 'entity', value: m[1] });
  for (const m of text.matchAll(/[「《【"]([^」》】"]{2,32})[」》】"]/gu)) {
    const value = m[1].trim();
    if (value.length >= 2) push({ kind: 'entity', value });
  }
  for (const m of text.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g)) {
    if (!ASCII_STOP.has(m[1].toLowerCase())) push({ kind: 'entity', value: m[1] });
  }

  // --- time expressions ---------------------------------------------------
  for (const iso of extractTimeExpressions(text, now)) {
    push({ kind: 'time', value: iso });
  }

  // --- emotions -----------------------------------------------------------
  const lower = text.toLowerCase();
  for (const [word, label] of EMOTION_LEXICON) {
    if (lower.includes(word)) push({ kind: 'emotion', value: label });
  }

  // --- topics: frequent, non-stopword bigrams / words ----------------------
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    const keep = /^[\u3400-\u9FFF]{2}$/.test(token)
      ? !CJK_STOP_BIGRAMS.has(token)
      : /^[a-z][a-z0-9_]{2,}$/.test(token) && !ASCII_STOP.has(token);
    if (!keep) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  const topics = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTopics)
    .map(([t]) => t);
  for (const topic of topics) push({ kind: 'topic', value: topic });

  return cues;
}

/** Union of cue lists, preserving first-seen order and dropping duplicates. */
export function mergeCues(...lists: ReadonlyArray<ReadonlyArray<Cue>>): Cue[] {
  const out: Cue[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const cue of list) {
      const key = cueToString(cue);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cue);
    }
  }
  return out;
}

/** Normalise a caller-supplied cue (string `kind:value` or object) to a Cue. */
export function coerceCue(input: Cue | string): Cue | null {
  if (typeof input !== 'string') return input;
  const i = input.indexOf(':');
  if (i <= 0) return { kind: 'topic', value: input.trim() };
  const kind = input.slice(0, i);
  const value = input.slice(i + 1).trim();
  if (!value) return null;
  if (kind !== 'entity' && kind !== 'topic' && kind !== 'time' && kind !== 'emotion' && kind !== 'goal') {
    return { kind: 'topic', value };
  }
  return { kind, value } as Cue;
}
