/**
 * Text utilities: token estimation and tokenisation.
 *
 * Both are deliberately dependency-free and *approximate*. An exact tokenizer
 * would pin the library to one vendor's tokenisation; a good approximation keeps
 * the library portable and errs on the conservative side (over-estimates).
 */

const CJK_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/;
const CJK_RUN_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]+/g;
const ASCII_WORD_RE = /[a-z0-9_]+/g;

/**
 * Estimate tokens. CJK counts ~1 token/char (slightly conservative), other
 * scripts ~0.25 tokens/char. Never returns 0 for non-empty input.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

export function isCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/**
 * Tokenise for BM25.
 *
 * ASCII: lowercased word runs.
 * CJK: unigrams *and* bigrams. Unigrams give recall on single-character queries;
 * bigrams give precision. This is a cheap stand-in for a real CJK segmenter and
 * avoids a 2MB dictionary dependency.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const out: string[] = [];

  const ascii = lower.match(ASCII_WORD_RE);
  if (ascii) out.push(...ascii);

  const runs = lower.match(CJK_RUN_RE);
  if (runs) {
    for (const run of runs) {
      const chars = Array.from(run);
      for (let i = 0; i < chars.length; i++) {
        out.push(chars[i]);
        if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1]);
      }
    }
  }
  return out;
}

/** Collapse whitespace and trim. Used before length checks. */
export function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate on a character boundary, appending an ellipsis when cut. */
export function truncate(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, Math.max(1, maxChars - 1)).join('') + '…';
}

/** First sentence-ish fragment, used by the offline gist heuristic. */
export function firstClause(text: string, maxChars: number): string {
  const normalized = normalizeSpace(text);
  const m = normalized.match(/^(.{1,200}?)[。！？.!?\n]/);
  const candidate = m ? m[1] : normalized;
  return truncate(candidate, maxChars);
}

/** Jaccard overlap on token sets, 0..1. Used for goal-fit scoring. */
export function tokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Simple date extraction for cue harvesting. Returns ISO strings. */
export function extractTimeExpressions(text: string, now: Date): string[] {
  const found: string[] = [];
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g);
  if (iso) for (const s of iso) found.push(s);

  const slash = text.match(/\b(20\d{2})\/(\d{1,2})\/(\d{1,2})\b/g);
  if (slash) {
    for (const s of slash) {
      const [y, m, d] = s.split('/');
      found.push(`${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`);
    }
  }

  // Relative expressions are anchored against `now`; the caller passes the
  // current time so this stays deterministic in tests.
  const rel = text.match(/(今天|明天|后天|昨天|前天|下周|上周|下个月|上个月)/g);
  if (rel) {
    for (const word of rel) {
      const d = new Date(now.getTime());
      switch (word) {
        case '今天':
          break;
        case '明天':
          d.setDate(d.getDate() + 1);
          break;
        case '后天':
          d.setDate(d.getDate() + 2);
          break;
        case '昨天':
          d.setDate(d.getDate() - 1);
          break;
        case '前天':
          d.setDate(d.getDate() - 2);
          break;
        case '下周':
          d.setDate(d.getDate() + 7);
          break;
        case '上周':
          d.setDate(d.getDate() - 7);
          break;
        case '下个月':
          d.setMonth(d.getMonth() + 1);
          break;
        case '上个月':
          d.setMonth(d.getMonth() - 1);
          break;
      }
      found.push(d.toISOString().slice(0, 10));
    }
  }
  return Array.from(new Set(found));
}
