/**
 * Record construction and validation: the one place a MemoryRecord is born.
 *
 * Invariants enforced here, so nothing downstream has to re-check them:
 *   - `name` is a filesystem-safe slug
 *   - `abstract` respects `abstractMaxChars` (it is the L0 handle; if it is long,
 *     the whole progressive-disclosure economy collapses)
 *   - stability is derived from salience at birth
 *   - attribution has already been bound by `bindAttribution`
 */
import { initialStability } from './decay.js';
import { isValidSlug, slugify } from '../util/id.js';
import { truncate } from '../util/text.js';
import { nowIso } from '../util/time.js';
export class RecordValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RecordValidationError';
    }
}
export function createRecord({ input, gist, attribution, config, now }) {
    const rawName = input.name?.trim() || slugify(gist.abstract);
    if (!rawName)
        throw new RecordValidationError('record needs a name or a non-empty abstract');
    // A caller-supplied name that is not a slug would become a path; derive instead.
    const name = isValidSlug(rawName) ? rawName : slugify(rawName);
    const abstract = truncate(gist.abstract.trim(), config.abstractMaxChars);
    if (!abstract)
        throw new RecordValidationError('record needs a non-empty abstract');
    const salience = clamp(input.salience ?? gist.salience, 1, 10);
    const type = attribution.type;
    // The body is the L2 verbatim trace: if the caller supplied one, it is
    // authoritative. Only fall back to the condensed gist body otherwise. Truncating
    // a caller's body would silently destroy the thing progressive disclosure exists
    // to let you fetch.
    const body = (input.body?.trim() || gist.body).trim();
    return {
        name,
        abstract,
        type,
        group: (input.group ?? 'default').trim() || 'default',
        body,
        validFrom: input.validFrom ?? nowIso(now),
        invalidAt: null,
        weight: clamp(input.weight ?? 1, 0, 1),
        salience,
        stability: initialStability(salience),
        accessCount: 0,
        lastAccess: null,
        confidence: clamp(input.confidence ?? 0.9, 0, 1),
        subject: attribution.subject,
        speaker: attribution.speaker,
        addressee: attribution.addressee,
        hop: attribution.hop,
        future: input.future ?? gist.future,
        trigger: input.trigger ?? null,
        status: input.status ?? (type === 'intention' ? 'pending' : null),
        links: input.links ?? [],
        provenance: input.provenance ?? [],
        cues: gist.cues.map((c) => `${c.kind}:${c.value}`),
        createdAt: nowIso(now),
        updatedAt: nowIso(now),
    };
}
export function clamp(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, value));
}
/** Full-text used for the BM25 index: the abstract carries the most signal, so it is repeated. */
export function indexableText(record) {
    return [
        record.abstract,
        record.abstract,
        record.name,
        record.group,
        record.body,
        record.future.join(' '),
        record.links.join(' '),
    ].join('\n');
}
//# sourceMappingURL=record.js.map