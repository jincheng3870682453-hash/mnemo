/**
 * MemoryRecord <-> on-disk frontmatter mapping.
 *
 * On disk the fields are snake_case (readable in any Markdown editor); in memory
 * they are camelCase. This module is the only place that knows both.
 */
import { MEMORY_TYPES, parseCue } from '../types.js';
import { FrontmatterError, parse, serialize } from '../util/yaml.js';
function str(data, key, fallback = '') {
    const v = data[key];
    return typeof v === 'string' ? v : fallback;
}
function optionalStr(data, key) {
    const v = data[key];
    return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(data, key, fallback) {
    const v = data[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
function strList(data, key) {
    const v = data[key];
    if (Array.isArray(v))
        return v.slice();
    if (typeof v === 'string' && v.length > 0)
        return [v];
    return [];
}
export function recordToFrontmatter(record) {
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
export function frontmatterToRecord(data, body) {
    const name = str(data, 'name');
    if (!name)
        throw new FrontmatterError('frontmatter is missing `name`');
    const rawType = str(data, 'type', 'fact');
    const type = MEMORY_TYPES.includes(rawType) ? rawType : 'fact';
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
        subject: optionalStr(data, 'subject'),
        speaker: optionalStr(data, 'speaker'),
        addressee: optionalStr(data, 'addressee'),
        hop: Math.max(0, Math.floor(num(data, 'hop', 0))),
        future: strList(data, 'future'),
        trigger: optionalStr(data, 'trigger'),
        status: optionalStr(data, 'status'),
        links: strList(data, 'links'),
        provenance: strList(data, 'provenance'),
        cues: strList(data, 'cues').filter((c) => parseCue(c) !== null),
        createdAt: str(data, 'created_at', new Date(0).toISOString()),
        updatedAt: str(data, 'updated_at', new Date(0).toISOString()),
    };
}
export function serializeRecord(record) {
    return serialize(recordToFrontmatter(record), record.body);
}
export function deserializeRecord(raw) {
    const { data, body } = parse(raw);
    return frontmatterToRecord(data, body);
}
function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
//# sourceMappingURL=frontmatter.js.map