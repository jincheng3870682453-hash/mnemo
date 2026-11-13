/**
 * Mnemo: the facade.
 *
 * Six tools, not sixty. Every extra tool definition inflates the cacheable prefix,
 * makes tool ordering less stable and raises the chance of a wrong call — which
 * costs more than the tokens it was meant to save.
 *
 *   write      remember something
 *   recall     get L0 pointers (cheap)
 *   read       get L1 outline or L2 body (expensive, explicit)
 *   forget     let something degrade
 *   cue        bind a situational trigger to a memory
 *   intend     register something to remember to do later
 */

import path from 'node:path';
import type {
  Cue,
  MemoryRecord,
  MnemoConfig,
  WriteInput,
} from './types.js';
import { mergeConfig } from './types.js';
import { FileStore, matchSafeName } from './store/file-store.js';
import { BM25Index } from './index/bm25.js';
import { bindAttribution, attributionLabel, decisionEligible } from './memory/attribution.js';
import { encodeGist, heuristicGist } from './memory/gist.js';
import { createRecord, indexableText, RecordValidationError } from './memory/record.js';
import { erodeConfidence, reinforce, tier as retentionTier } from './memory/decay.js';
import { coerceCue, harvestCues, mergeCues } from './memory/cues.js';
import { bestMatch, mergeIntoRecord, refineWithLLM, supersedeRecord } from './memory/consolidation.js';
import { retrieve, renderL0, type RetrieveQuery, type ScoredMemory } from './retrieval/retrieve.js';
import { assemble, buildMemoryIndex, stableToolBlock, type AssembledContext, type ContextInput } from './context/assembler.js';
import { maybeOffload, readOffload as readOffloadFile, type OffloadReadOptions, type OffloadResult } from './context/offload.js';
import { dueIntentions, encodeTrigger, isUpcoming, renderPending, type Trigger } from './prospective/intentions.js';
import { NullLLM, type LLM } from './llm/types.js';
import { tokenize } from './util/text.js';
import { estimateTokens } from './util/text.js';
import { isValidSlug } from './util/id.js';
import { nowIso } from './util/time.js';

export interface MnemoOptions {
  config?: Partial<MnemoConfig>;
  llm?: LLM;
  /** Principal representing the assistant itself. Defaults to `agent:self`. */
  agentPrincipal?: string;
  /** Default principal of the human(s) this agent serves, if there is one. */
  userPrincipal?: string;
}

export interface WriteResult {
  record: MemoryRecord;
  /** What consolidation decided to do with this claim. */
  relation: 'created' | 'duplicate' | 'refines' | 'supersedes';
  /** Records that were invalidated as a result. */
  invalidated: string[];
  /** Attribution notes: demotions and unbound subjects are never silent. */
  notes: string[];
  /** Path relative to the store root. */
  path: string;
}

export interface ReadResult {
  name: string;
  depth: 'l1' | 'l2';
  abstract: string;
  body: string;
  tokens: number;
  decisionEligible: boolean;
  attribution: string;
  invalidAt: string | null;
}

export interface ReconstructResult {
  name: string;
  text: string;
  confidence: number;
  usedLLM: boolean;
  /** True when the model was told the material was a gist, not a transcript. */
  labelledAsGist: boolean;
}

export interface ConsolidateReport {
  archived: string[];
  scanned: number;
}

export interface Metrics {
  total: number;
  byType: Record<string, number>;
  byTier: Record<string, number>;
  pendingIntentions: number;
  decisionEligible: number;
  relayed: number;
  /** Mean confidence across live records. Drops as memories are retold. */
  meanConfidence: number;
}

export class Mnemo {
  readonly store: FileStore;
  readonly config: MnemoConfig;
  readonly agentPrincipal: string;
  readonly userPrincipal: string | null;

  private llm: LLM;
  private index = new BM25Index();
  private records = new Map<string, MemoryRecord>();

  private constructor(store: FileStore, config: MnemoConfig, options: MnemoOptions) {
    this.store = store;
    this.config = config;
    this.llm = options.llm ?? new NullLLM();
    this.agentPrincipal = options.agentPrincipal ?? 'agent:self';
    this.userPrincipal = options.userPrincipal ?? null;
  }

  /** Open (or create) a memory store at `root`. */
  static async open(root: string, options: MnemoOptions = {}): Promise<Mnemo> {
    const store = new FileStore(root);
    await store.init();
    const mnemo = new Mnemo(store, mergeConfig(options.config), options);
    await mnemo.reload();
    return mnemo;
  }

  /** Re-read every record from disk and rebuild the index. Discards nothing. */
  async reload(): Promise<void> {
    const records = await this.store.loadAll();
    this.records.clear();
    this.index.clear();
    for (const record of records) {
      this.records.set(record.name, record);
      this.index.add(record.name, tokenize(indexableText(record)));
    }
  }

  /**
   * Look up a live record by name.
   *
   * The slug check is not redundant with the store's own check: it means a
   * caller-supplied string can never reach a path-building code path at all,
   * even if a future refactor removes the store-level guard.
   */
  private find(name: string): MemoryRecord | null {
    const safe = matchSafeName(name);
    if (!safe) return null;
    return this.records.get(safe) ?? null;
  }

  // ---------------------------------------------------------------- write --

  async write(input: WriteInput): Promise<WriteResult> {
    const now = new Date();
    const notes: string[] = [];

    if (!input.body?.trim() && !input.abstract?.trim()) {
      throw new RecordValidationError('write needs a body or an abstract');
    }

    const gist = await encodeGist({
      content: input.body || input.abstract || '',
      now,
      maxChars: this.config.abstractMaxChars,
      llm: this.llm,
      hints: {
        type: input.type,
        salience: input.salience,
        future: input.future,
      },
    });

    // An explicit abstract wins: the caller knows what the L0 handle should say,
    // and the heuristic can only guess from the first clause.
    if (input.abstract?.trim()) {
      gist.abstract = input.abstract.trim();
    }

    const attribution = bindAttribution({
      type: input.type ?? gist.type,
      subject: input.subject ?? this.userPrincipal,
      speaker: input.speaker ?? this.userPrincipal,
      addressee: input.addressee ?? this.agentPrincipal,
      hop: input.hop ?? 0,
    });
    notes.push(...attribution.notes);

    // Explicit cue registration in the input wins over harvested cues.
    const explicitCues = (input.cues ?? [])
      .map(coerceCue)
      .filter((c): c is Cue => c !== null);
    const harvested = harvestCues(input.body ?? input.abstract ?? '', now);
    const cues = mergeCues(explicitCues, harvested);
    const gistWithCues = { ...gist, cues };

    let record = createRecord({
      input,
      gist: gistWithCues,
      attribution,
      config: this.config,
      now,
    });

    // ---- consolidation ----------------------------------------------------
    const candidates = [...this.records.values()].filter(
      (r) => !r.invalidAt && r.name !== record.name && r.type === record.type,
    );
    const match = bestMatch(record, candidates);
    let relation: WriteResult['relation'] = 'created';
    const invalidated: string[] = [];

    if (match) {
      const plan = await refineWithLLM(match.plan, record, match.record, this.llm);
      if (plan.relation === 'duplicate') {
        relation = 'duplicate';
        match.record.salience = Math.max(match.record.salience, record.salience);
        match.record.updatedAt = nowIso(now);
        await this.store.save(match.record);
        this.reindexOne(match.record);
        record = match.record;
        notes.push(`duplicate of "${match.record.name}": kept the original`);
      } else if (plan.relation === 'refines') {
        relation = 'refines';
        mergeIntoRecord(match.record, record, now);
        await this.store.save(match.record);
        this.reindexOne(match.record);
        record = match.record;
        notes.push(`merged into "${match.record.name}": ${plan.reason}`);
      } else if (plan.relation === 'supersedes') {
        relation = 'supersedes';
        supersedeRecord(match.record, now);
        await this.store.save(match.record);
        this.reindexOne(match.record);
        invalidated.push(match.record.name);
        record.links = Array.from(new Set([...record.links, match.record.name]));
        notes.push(`supersedes "${match.record.name}": ${plan.reason}`);
      }
    }

    // Explicit invalidations requested by the caller.
    for (const name of input.invalidates ?? []) {
      const target = this.find(name);
      if (!target) {
        notes.push(`invalidates: no such record "${name}"`);
        continue;
      }
      supersedeRecord(target, now);
      await this.store.save(target);
      this.reindexOne(target);
      invalidated.push(name);
    }

    const relPath = await this.store.save(record);
    this.reindexOne(record);

    return { record, relation, invalidated, notes, path: relPath };
  }

  private reindexOne(record: MemoryRecord): void {
    this.records.set(record.name, record);
    if (record.invalidAt) {
      // Invalidated records stay in the index: `--as-of` must still find them.
      this.index.add(record.name, tokenize(indexableText(record)));
    } else {
      this.index.add(record.name, tokenize(indexableText(record)));
    }
  }

  // --------------------------------------------------------------- recall --

  /**
   * Return L0 pointers. Cheap by construction: abstracts and paths, ~30 tokens
   * each. Bodies are never included.
   */
  recall(query: RetrieveQuery = {}): ScoredMemory[] {
    const engine = {
      records: [...this.records.values()],
      index: this.index,
      config: this.config,
      pathOf: (name: string): string => {
        const record = this.find(name);
        if (!record) return '';
        return this.store.relativePathFor(record).split(path.sep).join('/');
      },
    };
    const hits = retrieve(engine, query);
    for (const hit of hits) {
      reinforce(hit.record, new Date(), this.config.decay);
      void this.store.save(hit.record).catch(() => {
        // A failed access-count update must never fail a read.
      });
    }
    return hits;
  }

  /** Same as recall, but returns the rendered one-line handles. */
  recallLines(query: RetrieveQuery = {}): string[] {
    const now = new Date();
    return this.recall(query).map((hit) => renderL0(hit, now));
  }

  // ----------------------------------------------------------------- read --

  async read(name: string, depth: 'l1' | 'l2' = 'l1'): Promise<ReadResult | null> {
    const record = this.find(name);
    if (!record) return null;

    const body = depth === 'l2' ? record.body : outlineOf(record.body);
    return {
      name,
      depth,
      abstract: record.abstract,
      body,
      tokens: estimateTokens(body) + estimateTokens(record.abstract),
      decisionEligible: decisionEligible(record),
      attribution: attributionLabel(record),
      invalidAt: record.invalidAt,
    };
  }

  /**
   * Reconstruct a memory in the light of a situation, and erode its confidence.
   *
   * This is the Loftus mechanism made explicit: retrieval rewrites. The returned
   * text is always labelled as a gist, never as a quote, and repeated
   * reconstruction visibly lowers confidence rather than silently drifting.
   */
  async reconstruct(name: string, situation = ''): Promise<ReconstructResult | null> {
    const record = this.find(name);
    if (!record) return null;
    const now = new Date();

    let text: string;
    let usedLLM = false;
    if (this.llm.name !== 'null') {
      const prompt = `你在回忆"${record.abstract}"。当前情境：${situation || '（无）'}。
记忆正文：${record.body.slice(0, 1200)}
用一到两句话说明你记得什么。如果记不清就直说。不要声称这是原话，不要补充正文里没有的信息。`;
      try {
        const out = await this.llm.complete({ prompt, maxTokens: 160, temperature: 0.3 });
        text = out.trim() || record.abstract;
        usedLLM = text.length > 0;
      } catch {
        text = record.abstract;
      }
    } else {
      text = record.abstract;
    }

    erodeConfidence(record, 0.95);
    record.updatedAt = nowIso(now);
    await this.store.update(record);
    this.reindexOne(record);

    return {
      name,
      text,
      confidence: record.confidence,
      usedLLM,
      labelledAsGist: true,
    };
  }

  // --------------------------------------------------------------- forget --

  /**
   * Let a memory degrade. Sets `invalidAt`; the file stays on disk and stays
   * answerable by `--as-of` queries. Nothing in mnemo hard-deletes by default.
   */
  async forget(name: string, reason = ''): Promise<boolean> {
    const record = this.find(name);
    if (!record) return false;
    const now = new Date();
    supersedeRecord(record, now);
    if (reason) {
      record.body = `${record.body}\n\n> 失效原因：${reason}`.trim();
    }
    await this.store.update(record);
    this.reindexOne(record);
    return true;
  }

  /** Move physically decayed records into archive/. Recoverable, just off the hot path. */
  async consolidate(now: Date = new Date()): Promise<ConsolidateReport> {
    const archived: string[] = [];
    const live = [...this.records.values()];
    for (const record of live) {
      if (record.invalidAt) continue;
      if (record.type === 'persona' || record.type === 'intention') continue;
      if (retentionTier(record, now, this.config.decay) !== 'archived') continue;
      await this.store.archive(record);
      archived.push(record.name);
      this.records.delete(record.name);
      this.index.remove(record.name);
    }
    return { archived, scanned: live.length };
  }

  // ------------------------------------------------------------------ cue --

  async cue(name: string, cues: Array<Cue | string>): Promise<boolean> {
    const record = this.find(name);
    if (!record) return false;
    const normalised = cues
      .map(coerceCue)
      .filter((c): c is Cue => c !== null)
      .map((c) => `${c.kind}:${c.value}`);
    record.cues = Array.from(new Set([...record.cues, ...normalised]));
    record.updatedAt = nowIso(new Date());
    await this.store.update(record);
    this.reindexOne(record);
    return true;
  }

  // --------------------------------------------------------------- intend --

  /** Register a delayed intention. Triggers on a timestamp or on event keywords. */
  async intend(input: {
    name?: string;
    what: string;
    trigger: Trigger;
    salience?: number;
    group?: string;
  }): Promise<WriteResult> {
    return this.write({
      name: input.name ?? '',
      body: input.what,
      abstract: input.what,
      type: 'intention',
      group: input.group ?? 'intention',
      trigger: encodeTrigger(input.trigger),
      status: 'pending',
      salience: input.salience ?? 7,
      future: ['到了触发时间时'],
      subject: this.userPrincipal,
      speaker: this.userPrincipal,
      hop: 0,
    });
  }

  /** Intentions whose time has come, or whose event keywords appear in `contextText`. */
  due(now: Date = new Date(), contextText = ''): MemoryRecord[] {
    return dueIntentions([...this.records.values()], now, contextText);
  }

  /** The resident "things you are keeping an eye on" block. Empty when nothing is close. */
  pendingLines(now: Date = new Date(), opts: { withinDays?: number; limit?: number } = {}): string {
    return renderPending([...this.records.values()], now, opts);
  }

  // -------------------------------------------------------------- context --

  /** Assemble a cache-aware prompt with a stable prefix and a volatile suffix. */
  buildContext(input: ContextInput): AssembledContext {
    return assemble(input, this.config.budget);
  }

  /** The resident MEMORY.md index, capped to the configured line budget. */
  memoryIndex(now: Date = new Date()): string {
    return buildMemoryIndex([...this.records.values()], { now });
  }

  /** Deterministic tool serialisation. Use this, not JSON.stringify, in the prefix. */
  toolBlock(tools: ReadonlyArray<Record<string, unknown>>): string {
    return stableToolBlock(tools);
  }

  // -------------------------------------------------------------- offload --

  async offload(sessionId: string, toolName: string, output: string): Promise<OffloadResult> {
    return maybeOffload(this.store, sessionId, toolName, output, {
      thresholdTokens: this.config.offloadThresholdTokens,
    });
  }

  async readOffload(sessionId: string, ref: string, options: OffloadReadOptions = {}) {
    return readOffloadFile(this.store, sessionId, ref, options);
  }

  // -------------------------------------------------------------- metrics --

  metrics(now: Date = new Date()): Metrics {
    const live = [...this.records.values()].filter((r) => !r.invalidAt);
    const byType: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    let eligible = 0;
    let relayed = 0;
    let confidenceSum = 0;

    for (const record of live) {
      byType[record.type] = (byType[record.type] ?? 0) + 1;
      const t = retentionTier(record, now, this.config.decay);
      byTier[t] = (byTier[t] ?? 0) + 1;
      if (decisionEligible(record)) eligible++;
      if (record.hop > 0) relayed++;
      confidenceSum += record.confidence;
    }

    return {
      total: live.length,
      byType,
      byTier,
      pendingIntentions: [...this.records.values()].filter(
        (r) => r.type === 'intention' && (r.status ?? 'pending') === 'pending' && isUpcoming(r, now, 3650),
      ).length,
      decisionEligible: eligible,
      relayed,
      meanConfidence: live.length > 0 ? confidenceSum / live.length : 0,
    };
  }

  /** Raw record access, for tooling and tests. Returns a copy. */
  get(name: string): MemoryRecord | null {
    const record = this.find(name);
    return record ? structuredClone(record) : null;
  }

  /** All live (non-superseded) records. Returns copies. */
  all(): MemoryRecord[] {
    return [...this.records.values()]
      .filter((r) => !r.invalidAt)
      .map((r) => structuredClone(r));
  }

  /**
   * A one-shot summary used by the CLI and by tests: what a model would see at
   * session start, and how much of it is cacheable.
   */
  bootContext(options: { system?: string; userMessage?: string } = {}): AssembledContext {
    const pending = this.pendingLines();
    const retrieved = this.recallLines({ limit: this.config.retrieve.limit });
    return this.buildContext({
      system: options.system ?? DEFAULT_SYSTEM,
      memoryIndex: this.memoryIndex(),
      pending: pending || undefined,
      retrieved,
      userMessage: options.userMessage ?? '',
    });
  }
}

export const DEFAULT_SYSTEM =
  '你是一个有长期记忆的助手。\n' +
  '下面给你的记忆索引只是指针，不是原文。需要细节时读取对应文件，不要凭摘要编造内容。\n' +
  '标注 relayed 的记忆是别人转述的，只能提及，不能据此做决定。';

/** Minimal outline: headings plus the first line under each. Costs ~1/8 of the body. */
export function outlineOf(body: string): string {
  if (!body) return '';
  const lines = body.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#')) {
      out.push(line);
      const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
      if (next && !next.startsWith('#')) out.push(next.trim().slice(0, 80));
    }
  }
  if (out.length === 0) {
    // No structure to outline: a prefix of the body beats a full read.
    return lines.slice(0, 6).join('\n');
  }
  return out.join('\n');
}

export { heuristicGist };
