/**
 * Core type definitions for mnemo.
 *
 * The model deliberately separates three things most memory libraries conflate:
 *   1. the gist trace (what survives) vs the verbatim trace (what expires);
 *   2. the record's decay state (stability, access count) from its content;
 *   3. **who a memory is about** (subject) from **who wrote it** (speaker).
 */

/** Memory kinds. Each maps to a storage directory; see store/file-store.ts. */
export type MemoryType =
  | 'fact'
  | 'preference'
  | 'skill'
  | 'hearsay'
  | 'event'
  | 'persona'
  | 'intention';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'fact',
  'preference',
  'skill',
  'hearsay',
  'event',
  'persona',
  'intention',
];

/**
 * A principal is a stable identity, e.g. `user:jincheng` or `agent:self`.
 * Preferences must be bound to a principal at write time, never to the
 * context-relative role word "user" — see memory/attribution.ts.
 */
export type Principal = string;

/** A cue is a handle that can trigger recall without a query string. */
export type Cue =
  | { kind: 'entity'; value: string }
  | { kind: 'topic'; value: string }
  | { kind: 'time'; value: string }
  | { kind: 'emotion'; value: string }
  | { kind: 'goal'; value: string };

export type CueKind = Cue['kind'];

/** Format a cue as the single string stored in frontmatter, e.g. `entity:金呈`. */
export function cueToString(cue: Cue): string {
  return `${cue.kind}:${cue.value}`;
}

/** Parse `entity:金呈` back into a cue. Returns null when malformed. */
export function parseCue(raw: string): Cue | null {
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const kind = raw.slice(0, i);
  const value = raw.slice(i + 1).trim();
  if (!value) return null;
  if (kind !== 'entity' && kind !== 'topic' && kind !== 'time' && kind !== 'emotion' && kind !== 'goal') {
    return null;
  }
  return { kind, value } as Cue;
}

/** Where a claim came from. Stored as `sessionId#messageIndex`. */
export type Provenance = string;

export interface MemoryRecord {
  /** Unique slug, `[a-z0-9-]`. Also the file name. */
  name: string;
  /** L0 trace. One line, <= abstractMaxChars. This is 90% of all reads. */
  abstract: string;
  type: MemoryType;
  /** Free-form bucket used for scoping, e.g. `user-tone`, `work/ai-memory`. */
  group: string;
  /** L2 trace. Free Markdown. Only read when detail is actually needed. */
  body: string;

  /** ISO timestamp. When the described state became true. */
  validFrom: string;
  /** ISO timestamp when superseded, or null. Records are never deleted for this. */
  invalidAt: string | null;

  /** Retrieval weight, 0..1. Hand-tunable prior. */
  weight: number;
  /** Emotional / practical importance, 1..10. Set at write time. */
  salience: number;
  /** Power-law stability S, in days. Grows on every successful recall. */
  stability: number;
  /** How many times this record has been retrieved. */
  accessCount: number;
  /** ISO timestamp of the last retrieval. Recency is measured from here, not created. */
  lastAccess: string | null;
  /** Calibrated confidence, 0..1. Eroded each time the gist is reconstructed. */
  confidence: number;

  /** Whose preference/fact this is. */
  subject: Principal | null;
  /** Who asserted it. */
  speaker: Principal | null;
  /** Who it was told to. */
  addressee: Principal | null;
  /** Testimony depth: 0 = first-hand, 1 = retold, >=2 = hearsay. Gates decisions. */
  hop: number;

  /** Prospective hooks: the future questions this memory should answer. */
  future: string[];
  /**
   * Encoded trigger for `intention` records. Format: `time@2026-11-18T09:00`
   * or `event@交报告,截稿`. Null for ordinary memories.
   */
  trigger: string | null;
  /** Lifecycle for intentions: pending | done | abandoned. Null otherwise. */
  status: string | null;
  /** Graph edges to other records, by name. */
  links: string[];
  provenance: Provenance[];
  cues: string[];

  createdAt: string;
  updatedAt: string;
}

/** Free-text input accepted by `write`. Only `name` and `body` are required. */
export interface WriteInput {
  name: string;
  body: string;
  abstract?: string;
  type?: MemoryType;
  group?: string;
  salience?: number;
  weight?: number;
  confidence?: number;
  subject?: Principal | null;
  speaker?: Principal | null;
  addressee?: Principal | null;
  hop?: number;
  future?: string[];
  links?: string[];
  provenance?: Provenance[];
  cues?: Array<Cue | string>;
  validFrom?: string;
  /** For `intention` records: `time@ISO` or `event@keyword,keyword`. */
  trigger?: string | null;
  /** For `intention` records: pending | done | abandoned. */
  status?: string | null;
  /** Names of records this one supersedes. They get `invalidAt` set. */
  invalidates?: string[];
}

export interface DecayConfig {
  /**
   * Power-law exponent d in R(t) = (1 + t/S)^-d.
   * Human retention is power-law, not exponential: Memoria (2026) measured
   * R^2 = 0.954 for power law vs 0.295 for exponential.
   */
  exponent: number;
  /** Multiplier applied to stability on each successful recall. */
  stabilityGrowth: number;
  /** Above this retention the record is normally retrievable. */
  activeThreshold: number;
  /** Between faint and active it is only reachable via a strong cue. */
  faintThreshold: number;
}

export interface RetrieveConfig {
  /** Signal weights. These are starting points, NOT doctrine — calibrate them. */
  weights: {
    recency: number;
    importance: number;
    relevance: number;
    goalFit: number;
  };
  /** Default number of L0 lines returned. */
  limit: number;
}

export interface BudgetConfig {
  /** Token budget per layer. Exceed => the assembler trims, loudly. */
  system: number;
  memoryIndex: number;
  retrieved: number;
  taskCanvas: number;
  userMessage: number;
}

export interface MnemoConfig {
  decay: DecayConfig;
  retrieve: RetrieveConfig;
  budget: BudgetConfig;
  /** Soft cap on `abstract`. Longer abstracts are rejected at write time. */
  abstractMaxChars: number;
  /** Days after which a verbatim/episodic body is condensed and archived. */
  verbatimTtlDays: number;
  /**
   * Tool outputs larger than this many tokens are written to disk and replaced
   * by a one-line reference. 0 disables offloading.
   */
  offloadThresholdTokens: number;
}

export const DEFAULT_CONFIG: MnemoConfig = {
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
  abstractMaxChars: 60,
  verbatimTtlDays: 90,
  offloadThresholdTokens: 400,
};

export function mergeConfig(partial?: Partial<MnemoConfig>): MnemoConfig {
  if (!partial) return structuredClone(DEFAULT_CONFIG);
  return {
    decay: { ...DEFAULT_CONFIG.decay, ...(partial.decay ?? {}) },
    retrieve: {
      weights: { ...DEFAULT_CONFIG.retrieve.weights, ...(partial.retrieve?.weights ?? {}) },
      limit: partial.retrieve?.limit ?? DEFAULT_CONFIG.retrieve.limit,
    },
    budget: { ...DEFAULT_CONFIG.budget, ...(partial.budget ?? {}) },
    abstractMaxChars: partial.abstractMaxChars ?? DEFAULT_CONFIG.abstractMaxChars,
    verbatimTtlDays: partial.verbatimTtlDays ?? DEFAULT_CONFIG.verbatimTtlDays,
    offloadThresholdTokens:
      partial.offloadThresholdTokens ?? DEFAULT_CONFIG.offloadThresholdTokens,
  };
}
