/**
 * A deliberately tiny YAML subset for frontmatter.
 *
 * Why not `js-yaml`? Because this library's whole pitch is zero dependencies and
 * byte-stable output. A full YAML parser brings anchors, tags, multi-line scalars
 * and merge keys — none of which memory frontmatter needs, all of which are an
 * attack surface and a source of non-determinism.
 *
 * Supported grammar (nothing else):
 *
 *   ---
 *   key: scalar
 *   key: "quoted scalar: with colon"
 *   key: []
 *   key:
 *     - item
 *     - item
 *   ---
 *   body markdown...
 *
 * Scalars are string | number | boolean | null. Values are never nested objects.
 * Keys are emitted **sorted** so identical records serialise to identical bytes.
 */

export type FrontmatterValue = string | number | boolean | null | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

const KEY_RE = /^([A-Za-z0-9_-]+):(.*)$/;
const ITEM_RE = /^\s{2,}-\s?(.*)$/;

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    const inner = raw.slice(1, -1);
    return inner.replace(/\\(["\\])/g, '$1');
  }
  return raw;
}

function quoteIfNeeded(value: string): string {
  if (value === '') return '""';
  // Quote when the raw form would be misread: leading/trailing space, YAML
  // sigils, embedded colon, or a token that looks like null/bool/number.
  const needsQuote =
    /^\s|\s$/.test(value) ||
    /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
    value.includes(': ') ||
    value.endsWith(':') ||
    value.includes('#') ||
    value === 'null' ||
    value === 'true' ||
    value === 'false' ||
    /^-?\d+(\.\d+)?$/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function parseScalar(raw: string): FrontmatterValue {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === '[]') return [];
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return unquote(trimmed);
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  return trimmed;
}

export function parse(raw: string): { data: Frontmatter; body: string } {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    throw new FrontmatterError('frontmatter must start with ---');
  }
  const afterOpen = text.indexOf('\n', text.indexOf('---'));
  if (afterOpen === -1) throw new FrontmatterError('unterminated frontmatter');

  const rest = text.slice(afterOpen + 1);
  const closeMatch = rest.match(/^---[ \t]*$/m);
  if (!closeMatch || closeMatch.index === undefined) {
    throw new FrontmatterError('missing closing --- for frontmatter');
  }
  const head = rest.slice(0, closeMatch.index);
  const body = rest.slice(closeMatch.index + closeMatch[0].length).replace(/^[ \t]*\r?\n/, '');

  const data: Frontmatter = {};
  const lines = head.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i++;
      continue;
    }
    const m = line.match(KEY_RE);
    if (!m) {
      throw new FrontmatterError(`unparseable frontmatter line ${i + 1}: ${line}`);
    }
    const key = m[1];
    const inline = m[2];

    if (inline.trim() !== '') {
      data[key] = parseScalar(inline);
      i++;
      continue;
    }

    // Possible block list.
    const items: string[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const itemMatch = lines[j].match(ITEM_RE);
      if (!itemMatch) break;
      items.push(unquote(itemMatch[1].trim()));
      j++;
    }
    data[key] = items.length > 0 ? items : null;
    i = j;
  }

  return { data, body };
}

export function stringify(data: Frontmatter): string {
  const keys = Object.keys(data).sort();
  const lines: string[] = ['---'];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${quoteIfNeeded(item)}`);
      }
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${quoteIfNeeded(value)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

export function serialize(data: Frontmatter, body: string): string {
  const head = stringify(data);
  const cleanBody = body.replace(/\r\n/g, '\n');
  return `${head}${cleanBody.startsWith('\n') ? '' : '\n'}${cleanBody.replace(/^\n+/, '')}\n`;
}
