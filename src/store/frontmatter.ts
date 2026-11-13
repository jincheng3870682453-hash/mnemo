/**
 * MemoryRecord <-> on-disk frontmatter mapping.
 *
 * On disk the fields are snake_case (readable in any Markdown editor); in memory
 * they are camelCase. This module is the only place that knows both.
 */

import type {
  MemoryRecord,
  MemoryType,
  Principal,
  Provenance,
} from '../types.js';
import { MEMORY_TYPES, parseCue } from '../types.js';
import type { Frontmatter } from '../util/yaml.js';
import { FrontmatterError, parse, serialize } from '../util/yaml.js';

function str(data: Frontmatter, key: string, fallback = ''): string {
  const v = data[key];
  return typeof v === 'string' ? v : fallback;
}

function optionalStr(data: Frontmatter, key: string): string | null {
  const v = data[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function num(data: Frontmatter, key: string, fallback: number): number {
  const v = data[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function strList(data: Frontmatter, key: string): string[] {
  const v = data[key];
  if (Array.isArray(v)) return v.slice();
  if (typeof v === 'string' && v.length > 0) return [v];
  return [];
}

export function recordToFrontmatter(record: MemoryRecord): Frontmatter {
  return {
    name: record.name,
    abstract: record.abstract,
    type: record.type,
    group: record.group,
    valid_from: record.validFrom,
    invalid_at: record.invalidAt,
    weight: record.weight,
    salience: record.salience,
    stability: record.stability,
    access_count: record.accessCount,
    last_access: record.lastAccess,
    suppressed_at: record.suppressedAt,
    confidence: record.confidence,
    subject: record.subject,
    speaker: record.speaker,
    addressee: record.addressee,
    hop: record.hop,
    future: record.future,
    trigger: record.trigger,
    status: record.status,
    links: record.links,
    provenance: record.provenance,
    cues: record.cues,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

export function frontmatterToRecord(data: Frontmatter, body: string): MemoryRecord {
  const name = str(data, 'name');
  if (!name) throw new FrontmatterError('frontmatter is missing `name`');

  const rawType = str(data, 'type', 'fact') as MemoryType;
  const type: MemoryType = MEMORY_TYPES.includes(rawType) ? rawType : 'fact';

  return {
    name,
    abstract: str(data, 'abstract'),
    type,
    group: str(data, 'group', 'default') || 'default',
    body: body.replace(/\r\n/g, '\n').trim(),
    validFrom: str(data, 'valid_from', new Date(0).toISOString()),
    invalidAt: optionalStr(data, 'invalid_at'),
    weight: clamp(num(data, 'weight', 1), 0, 1),
    salience: clamp(num(data, 'salience', 5), 1, 10),
    stability: Math.max(0.1, num(data, 'stability', 1)),
    accessCount: Math.max(0, Math.floor(num(data, 'access_count', 0))),
    lastAccess: optionalStr(data, 'last_access'),
    suppressedAt: optionalStr(data, 'suppressed_at'),
    confidence: clamp(num(data, 'confidence', 0.9), 0, 1),
    subject: optionalStr(data, 'subject') as Principal | null,
    speaker: optionalStr(data, 'speaker') as Principal | null,
    addressee: optionalStr(data, 'addressee') as Principal | null,
    hop: Math.max(0, Math.floor(num(data, 'hop', 0))),
    future: strList(data, 'future'),
    trigger: optionalStr(data, 'trigger'),
    status: optionalStr(data, 'status'),
    links: strList(data, 'links'),
    provenance: strList(data, 'provenance') as Provenance[],
    cues: strList(data, 'cues').filter((c) => parseCue(c) !== null),
    createdAt: str(data, 'created_at', new Date(0).toISOString()),
    updatedAt: str(data, 'updated_at', new Date(0).toISOString()),
  };
}

export function serializeRecord(record: MemoryRecord): string {
  return serialize(recordToFrontmatter(record), record.body);
}

export function deserializeRecord(raw: string): MemoryRecord {
  const { data, body } = parse(raw);
  return frontmatterToRecord(data, body);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
