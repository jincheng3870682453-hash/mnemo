/**
 * Encoding: turn raw content into a gist trace plus a verbatim trace.
 *
 * Fuzzy-trace theory says a person stores the *gist* (what it meant) and the
 * *verbatim* (exactly what was said) as separate traces. The gist survives for
 * years; the verbatim fades in days. mnemo mirrors that split:
 *
 *   abstract + body  -> the gist trace, permanent, ~30 + ~200 chars
 *   episodic/        -> the verbatim trace, TTL'd and then condensed
 *
 * Encoding runs through a model when one is configured, and through a deterministic
 * heuristic when it is not. The heuristic is not a stub: it is the documented
 * behaviour for offline use, and every model path falls back to it on bad output.
 */

import type { MemoryType } from '../types.js';
import type { Cue } from '../types.js';
import type { LLM } from '../llm/types.js';
import { GIST_PROMPT } from '../llm/prompts.js';
import { harvestCues } from './cues.js';
import { firstClause, normalizeSpace, truncate } from '../util/text.js';

export interface EncodeInput {
  content: string;
  now?: Date;
  maxChars?: number;
  llm?: LLM;
  hints?: {
    type?: MemoryType;
    salience?: number;
    future?: string[];
  };
}

export interface GistResult {
  abstract: string;
  body: string;
  salience: number;
  future: string[];
  type: MemoryType;
  emotion: string[];
  cues: Cue[];
  /** False when the heuristic was used (no model, or the model returned junk). */
  usedLLM: boolean;
}

const EMOTION_SALIENCE_BOOST = 2;

const DEFAULT_FUTURE: Record<string, string[]> = {
  preference: ['用户再次表达偏好时', '生成内容需要贴合个人风格时'],
  event: ['复盘这段时间发生了什么时'],
  episode: ['用户说"上次那次"时', '需要回忆起某段对话的来龙去脉时'],
  skill: ['遇到同类任务时'],
  fact: ['用户问起相关背景时'],
  hearsay: ['需要交叉验证某个说法时'],
  persona: ['需要决定说话方式时'],
  intention: ['到了触发时间时'],
};

/** Deterministic encoding. No network, no model, stable output. */
export function heuristicGist(input: EncodeInput): GistResult {
  const now = input.now ?? new Date();
  const maxChars = input.maxChars ?? 60;
  const content = input.content.trim();
  const normalized = normalizeSpace(content);

  const cues = harvestCues(content, now);
  const emotion = cues.filter((c) => c.kind === 'emotion').map((c) => c.value);

  const abstract = firstClause(normalized, maxChars);
  const body = truncate(normalized, 600);

  // Emotion raises salience: something that made someone angry is not "mundane".
  const base = input.hints?.salience ?? 5;
  const salience = Math.min(10, Math.max(1, base + (emotion.length > 0 ? EMOTION_SALIENCE_BOOST : 0)));

  const type: MemoryType = input.hints?.type ?? inferType(content);
  const future = input.hints?.future ?? DEFAULT_FUTURE[type] ?? [];

  return { abstract, body, salience, future, type, emotion, cues, usedLLM: false };
}

/** Cheap type inference from surface cues so callers can pass raw text. */
export function inferType(content: string): MemoryType {
  if (/偏好|喜欢|讨厌|习惯|不要|别|prefer|like|dislike|hate/i.test(content)) return 'preference';
  if (/怎么做|步骤|流程|方法|how to|step/i.test(content)) return 'skill';
  if (/昨天|今天|刚才|当时|那次|happened|yesterday/i.test(content)) return 'event';
  return 'fact';
}

interface RawGist {
  abstract?: unknown;
  body?: unknown;
  salience?: unknown;
  future?: unknown;
  type?: unknown;
  emotion?: unknown;
}

function parseJsonBlock(text: string): RawGist | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as RawGist;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

/**
 * Model-assisted encoding with a guaranteed fallback.
 *
 * A malformed response, a network error, or a model that ignores the schema all
 * resolve to the heuristic. Encoding must never throw: a failed write is worse
 * than a mediocre gist.
 */
export async function encodeGist(input: EncodeInput): Promise<GistResult> {
  const fallback = heuristicGist(input);
  const llm = input.llm;
  if (!llm || llm.name === 'null') return fallback;

  const now = input.now ?? new Date();
  const prompt = GIST_PROMPT.replace('{today}', now.toISOString().slice(0, 10))
    .replace('{maxChars}', String(input.maxChars ?? 60))
    .replace('{content}', truncate(input.content, 4000));

  let text = '';
  try {
    text = await llm.complete({ prompt, maxTokens: 400, temperature: 0.1, json: true });
  } catch {
    return fallback;
  }

  const raw = parseJsonBlock(text);
  if (!raw) return fallback;

  const abstract = asString(raw.abstract, fallback.abstract);
  const body = asString(raw.body, fallback.body);
  const salienceRaw = typeof raw.salience === 'number' ? raw.salience : fallback.salience;
  const salience = Math.min(10, Math.max(1, Math.round(salienceRaw)));
  const future = asStringArray(raw.future);
  const emotion = asStringArray(raw.emotion);
  const typeRaw = asString(raw.type, fallback.type) as MemoryType;
  const type: MemoryType = (
    ['fact', 'preference', 'event', 'episode', 'skill', 'hearsay', 'persona', 'intention'] as const
  ).includes(typeRaw)
    ? typeRaw
    : fallback.type;

  return {
    abstract,
    body,
    salience,
    future: future.length > 0 ? future : (DEFAULT_FUTURE[type] ?? []),
    type,
    emotion: emotion.length > 0 ? emotion : fallback.emotion,
    cues: fallback.cues,
    usedLLM: true,
  };
}
