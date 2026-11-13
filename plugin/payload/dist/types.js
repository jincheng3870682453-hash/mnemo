/**
 * Core type definitions for mnemo.
 *
 * The model deliberately separates three things most memory libraries conflate:
 *   1. the gist trace (what survives) vs the verbatim trace (what expires);
 *   2. the record's decay state (stability, access count) from its content;
 *   3. **who a memory is about** (subject) from **who wrote it** (speaker).
 */
export const MEMORY_TYPES = [
    'fact',
    'preference',
    'skill',
    'hearsay',
    'event',
    'persona',
    'intention',
];
/** Format a cue as the single string stored in frontmatter, e.g. `entity:金呈`. */
export function cueToString(cue) {
    return `${cue.kind}:${cue.value}`;
}
/** Parse `entity:金呈` back into a cue. Returns null when malformed. */
export function parseCue(raw) {
    const i = raw.indexOf(':');
    if (i <= 0)
        return null;
    const kind = raw.slice(0, i);
    const value = raw.slice(i + 1).trim();
    if (!value)
        return null;
    if (kind !== 'entity' && kind !== 'topic' && kind !== 'time' && kind !== 'emotion' && kind !== 'goal') {
        return null;
    }
    return { kind, value };
}
export const DEFAULT_CONFIG = {
    decay: {
        exponent: 0.7,
        stabilityGrowth: 1.3,
        activeThreshold: 0.3,
        faintThreshold: 0.1,
    },
    retrieve: {
        weights: { recency: 0.5, importance: 1.5, relevance: 2.0, goalFit: 2.0 },
        limit: 8,
    },
    budget: {
        system: 800,
        memoryIndex: 300,
        retrieved: 240,
        taskCanvas: 800,
        userMessage: 2000,
    },
    vector: {
        mode: 'auto',
        minRecords: 5000,
        blend: 0.4,
        batchSize: 64,
    },
    consolidation: {
        enabled: true,
    },
    competition: {
        enabled: true,
        threshold: 0.75,
        fadeDays: 5,
        maxPenalty: 0.4,
    },
    abstractMaxChars: 60,
    verbatimTtlDays: 90,
    offloadThresholdTokens: 400,
};
export function mergeConfig(partial) {
    if (!partial)
        return structuredClone(DEFAULT_CONFIG);
    return {
        decay: { ...DEFAULT_CONFIG.decay, ...(partial.decay ?? {}) },
        retrieve: {
            weights: { ...DEFAULT_CONFIG.retrieve.weights, ...(partial.retrieve?.weights ?? {}) },
            limit: partial.retrieve?.limit ?? DEFAULT_CONFIG.retrieve.limit,
        },
        budget: { ...DEFAULT_CONFIG.budget, ...(partial.budget ?? {}) },
        vector: { ...DEFAULT_CONFIG.vector, ...(partial.vector ?? {}) },
        consolidation: { ...DEFAULT_CONFIG.consolidation, ...(partial.consolidation ?? {}) },
        competition: { ...DEFAULT_CONFIG.competition, ...(partial.competition ?? {}) },
        abstractMaxChars: partial.abstractMaxChars ?? DEFAULT_CONFIG.abstractMaxChars,
        verbatimTtlDays: partial.verbatimTtlDays ?? DEFAULT_CONFIG.verbatimTtlDays,
        offloadThresholdTokens: partial.offloadThresholdTokens ?? DEFAULT_CONFIG.offloadThresholdTokens,
    };
}
//# sourceMappingURL=types.js.map