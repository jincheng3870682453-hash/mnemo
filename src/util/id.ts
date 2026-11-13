/** Identifier helpers: slugs and offload references. */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$|^[a-z0-9]$/;

export function isValidSlug(name: string): boolean {
  return SLUG_RE.test(name);
}

/**
 * Turn arbitrary text into a slug. CJK has no ASCII form, so CJK input keeps a
 * short stable hash suffix — the name stays a valid filename while remaining
 * collision-resistant.
 */
export function slugify(text: string, fallback = 'memory'): string {
  const ascii = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  const hasCjk = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(text);
  if (ascii.length >= 2) return ascii;
  const base = fallback;
  const hash = shortHash(text);
  return hasCjk ? `${base}-${hash}` : `${fallback}-${hash}`;
}

/** FNV-1a, 6 hex chars. Cheap, stable, good enough for names and refs. */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

let counter = 0;

/** Short unique reference for offloaded tool output, e.g. `7f3a9c`. */
export function newRef(seed = ''): string {
  counter = (counter + 1) % 0xffff;
  return shortHash(`${Date.now()}-${counter}-${seed}`).slice(0, 6);
}
