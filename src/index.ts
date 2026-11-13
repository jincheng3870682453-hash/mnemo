/**
 * mnemo — token-thrifty, human-like long-term memory for AI agents.
 *
 * Two ideas, one library:
 *   1. Do not put content in the context. Put a pointer, and let the agent decide
 *      whether to spend a read on it. (progressive disclosure)
 *   2. Do not remember like a database. Remember like a person: keep the gist,
 *      let the detail decay, let context trigger recall, and keep track of what
 *      you are supposed to do next. (fuzzy-trace + prospective memory)
 */

export { Mnemo, DEFAULT_SYSTEM, outlineOf } from './mnemo.js';
export type {
  MnemoOptions,
  WriteResult,
  ReadResult,
  ReconstructResult,
  ConsolidateReport,
  Metrics,
  CheckpointInput,
  EpisodeSummary,
} from './mnemo.js';

export {
  DEFAULT_CONFIG,
  mergeConfig,
  MEMORY_TYPES,
  cueToString,
  parseCue,
} from './types.js';
export type {
  MemoryRecord,
  MemoryType,
  MnemoConfig,
  DecayConfig,
  RetrieveConfig,
  BudgetConfig,
  VectorConfig,
  ConsolidationConfig,
  CompetitionConfig,
  AdaptiveConfig,
  WriteInput,
  Cue,
  Principal,
  Provenance,
} from './types.js';

export { AdaptiveTuner, ARMS, FEATURE_DIM, normaliseFeatures, mergeOverrides } from './adaptive/tuner.js';
export type { AdaptiveChoice, ArmStats, Arm, TunerState } from './adaptive/tuner.js';

export { FileStore, PathEscapeError, dirForType } from './store/file-store.js';
export { serializeRecord, deserializeRecord } from './store/frontmatter.js';

export { BM25Index } from './index/bm25.js';

export { retention, tier, initialStability, reinforce, erodeConfidence, daysUntil } from './memory/decay.js';
export type { RetentionTier } from './memory/decay.js';
export { bindAttribution, decisionEligible, attributionLabel, contradicts } from './memory/attribution.js';
export type { AttributionInput, AttributionResult } from './memory/attribution.js';
export { encodeGist, heuristicGist, inferType } from './memory/gist.js';
export type { EncodeInput, GistResult } from './memory/gist.js';
export { harvestCues, mergeCues, coerceCue } from './memory/cues.js';
export { decideRelation, bestMatch, mergeIntoRecord, supersedeRecord } from './memory/consolidation.js';
export type { Relation, ConsolidationPlan } from './memory/consolidation.js';
export { createRecord, indexableText, RecordValidationError } from './memory/record.js';
export { probeMetamemory, renderProbe } from './memory/metamemory.js';
export type { Feeling, MetamemoryHint, MetamemoryProbe, ProbeInput } from './memory/metamemory.js';
export {
  competitionFactor,
  shouldSuppress,
  findCompetitors,
  suppressCompetitors,
} from './memory/competition.js';

export { retrieve, renderL0 } from './retrieval/retrieve.js';
export type { RetrieveQuery, ScoredMemory, Signals, RetrievalEngine } from './retrieval/retrieve.js';
export { cosine, normalize, OpenAIEmbedder, HashingEmbedder } from './retrieval/embedder.js';
export type { Embedder, OpenAIEmbedderOptions } from './retrieval/embedder.js';
export { VectorIndex } from './retrieval/vector-index.js';
export type { VectorHit } from './retrieval/vector-index.js';

export { assemble, trimToBudget, stableToolBlock, buildMemoryIndex } from './context/assembler.js';
export type { AssembledContext, ContextInput } from './context/assembler.js';
export { selectByValuePerToken, renderSelection } from './context/budget.js';
export type { BudgetItem, BudgetSelection } from './context/budget.js';
export { maybeOffload, readOffload } from './context/offload.js';
export type { OffloadResult, OffloadReadOptions } from './context/offload.js';

export {
  encodeTrigger,
  parseTrigger,
  isDue,
  isUpcoming,
  matchesEvent,
  dueIntentions,
  renderPending,
} from './prospective/intentions.js';
export type { Trigger, TriggerKind } from './prospective/intentions.js';

export { NullLLM } from './llm/types.js';export type { LLM, LLMRequest } from './llm/types.js';
export { OpenAICompatibleLLM } from './llm/openai.js';
export type { OpenAICompatibleOptions } from './llm/openai.js';
export { GIST_PROMPT, RECONSTRUCT_PROMPT, CONSOLIDATE_PROMPT } from './llm/prompts.js';

export { estimateTokens, tokenize, truncate, normalizeSpace } from './util/text.js';
export { slugify, isValidSlug, shortHash, newRef } from './util/id.js';
export { daysBetween, parseIso, nowIso, addDays } from './util/time.js';
