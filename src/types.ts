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
  | 'episode'
  | 'persona'
  | 'intention';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'fact',
  'preference',
  'skill',
  'hearsay',
  'event',
  'episode',
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
  /**
   * ISO timestamp of the last time this record was suppressed as a *competitor*
   * of a stronger, similar memory. Retrieval-induced forgetting, made reversible:
   * the penalty fades over days and is never applied to a record that is itself
   * frequently retrieved. See memory/competition.ts.
   */
  suppressedAt: string | null;
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

export interface VectorConfig {
  /**
   * `off` never loads an embedder. `auto` switches on once the store reaches
   * `minRecords`. `on` always uses vectors when an embedder is configured.
   */
  mode: 'off' | 'auto' | 'on';
  /** Record count at which `auto` flips on. */
  minRecords: number;
  /** 0 = pure BM25, 1 = pure vector. Blended into the relevance signal. */
  blend: number;
  /** How many records to embed per warm-up batch. */
  batchSize: number;
}

export interface ConsolidationConfig {
  /**
   * Whether a new claim is merged into / allowed to supersede an existing one.
   *
   * Default true, but it is the least proven mechanism in this library: a 2026
   * study found consolidation quality scores did not predict downstream accuracy
   * (Spearman rho -0.24), and an independent replication found a nightly
   * consolidation cycle made results slightly worse. `npm run bench` measures it
   * on a synthetic corpus so you can decide for your own workload.
   */
  enabled: boolean;
}

/**
 * Retrieval-induced forgetting.
 *
 * Recalling one memory temporarily quiets its near-duplicates, the way retrieving
 * one fact makes the wrong answer harder to reach for a while. It sharpens recall
 * and keeps twelve near-identical candidates out of the prompt.
 *
 * It is deliberately weak and reversible: a 2026 study found that suppressing
 * persistent competitors helps, while suppressing *repeatedly useful* memories is
 * the complementary failure mode. `shouldSuppress()` refuses to touch a record
 * that is itself frequently retrieved or highly salient.
 */
export interface CompetitionConfig {
  enabled: boolean;
  /** Abstract token overlap above which two records are rivals. */
  threshold: number;
  /** Days for the penalty to fade. Short on purpose: this is not forgetting. */
  fadeDays: number;
  /** Maximum share of score removed right after suppression, 0..1. */
  maxPenalty: number;
}

/**
 * Mention-based reinforcement: the weak sibling of the spacing effect.
 *
 * A conversation can *name* a memory without ever asking a question about it.
 * That mention deserves something — being thought about makes a memory more
 * durable — but far less than a full recall earns, and it must never fire on
 * records whose only match was their importance weight. `growth` is applied to
 * stability (recall uses `decay.stabilityGrowth`, deliberately higher); `limit`
 * caps how many records one mention may renew.
 */
export interface MentionConfig {
  /** Stability multiplier on a mere mention. Below `decay.stabilityGrowth` on purpose. */
  growth: number;
  /** Max records one reinforce() call may renew. */
  limit: number;
}

/** Recursive partial: lets a caller override one nested knob without restating it. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/**
 * Online parameter tuning.
 *
 * The decay and retrieval defaults are hand-tuned starting points, and the
 * project's own documentation says so. This turns the *choice among* those
 * starting points into a contextual bandit: every recall measures a small
 * feature vector, one arm is tried, and the reward the caller reports moves the
 * choice. It is deliberately a bandit and not a model call — no LLM, no network,
 * no training set, and it keeps working when the workload shifts.
 *
 * Off by default: a hidden adaptive layer deciding rankings is exactly the kind
 * of thing that should be opt-in and inspectable (`mnemo.adaptiveStats()`).
 */
export interface AdaptiveConfig {
  enabled: boolean;
  /** UCB exploration strength. Higher explores more, 0 is greedy. */
  alpha: number;
  /** Recalls observed before the bandit may leave the default arm. */
  warmup: number;
  /** Persisted tuner state, relative to the store root. */
  stateFile: string;
}

export interface MnemoConfig {
  decay: DecayConfig;
  retrieve: RetrieveConfig;
  budget: BudgetConfig;
  vector: VectorConfig;
  consolidation: ConsolidationConfig;
  competition: CompetitionConfig;
  /** Mention-based renewal knobs, see reinforce(). */
  mention: MentionConfig;
  /** Optional online tuning of decay/retrieval params. Off by default. */
  adaptive: AdaptiveConfig;
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
  mention: {
    growth: 1.15,
    limit: 3,
  },
  adaptive: {
    enabled: false,
    alpha: 1.0,
    warmup: 8,
    stateFile: 'adaptive.json',
  },
  abstractMaxChars: 60,
  verbatimTtlDays: 90,
  offloadThresholdTokens: 400,
};

export function mergeConfig(partial?: DeepPartial<MnemoConfig>): MnemoConfig {
  if (!partial) return structuredClone(DEFAULT_CONFIG);
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
  mention: { ...DEFAULT_CONFIG.mention, ...(partial.mention ?? {}) },
    adaptive: { ...DEFAULT_CONFIG.adaptive, ...(partial.adaptive ?? {}) },
    abstractMaxChars: partial.abstractMaxChars ?? DEFAULT_CONFIG.abstractMaxChars,
    verbatimTtlDays: partial.verbatimTtlDays ?? DEFAULT_CONFIG.verbatimTtlDays,
    offloadThresholdTokens:
      partial.offloadThresholdTokens ?? DEFAULT_CONFIG.offloadThresholdTokens,
  };
}
