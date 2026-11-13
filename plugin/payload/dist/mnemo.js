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
import { mergeConfig } from './types.js';
import { FileStore, matchSafeName } from './store/file-store.js';
import { deserializeRecord } from './store/frontmatter.js';
import { BM25Index } from './index/bm25.js';
import { AdaptiveTuner } from './adaptive/tuner.js';
import { bindAttribution, attributionLabel, decisionEligible } from './memory/attribution.js';
import { encodeGist, heuristicGist } from './memory/gist.js';
import { createRecord, indexableText, RecordValidationError } from './memory/record.js';
import { erodeConfidence, reinforce, retention, tier as retentionTier } from './memory/decay.js';
import { probeMetamemory, renderProbe } from './memory/metamemory.js';
import { suppressCompetitors } from './memory/competition.js';
import { coerceCue, harvestCues, mergeCues } from './memory/cues.js';
import { bestMatch, mergeIntoRecord, refineWithLLM, supersedeRecord } from './memory/consolidation.js';
import { retrieve, renderL0 } from './retrieval/retrieve.js';
import { VectorIndex } from './retrieval/vector-index.js';
import { assemble, buildMemoryIndex, stableToolBlock } from './context/assembler.js';
import { maybeOffload, readOffload as readOffloadFile } from './context/offload.js';
import { dueIntentions, encodeTrigger, isUpcoming, renderPending } from './prospective/intentions.js';
import { NullLLM } from './llm/types.js';
import { tokenize } from './util/text.js';
import { estimateTokens } from './util/text.js';
import { nowIso } from './util/time.js';
export const SELF_TEST_CAVEAT = 'Self-retrieval uses each record\'s own abstract as the query, which is easier ' +
    'than a real user query: there is no paraphrase and no vocabulary gap. Treat ' +
    'hitRate as a relative health signal and a detector for competition or index ' +
    'damage, not as an estimate of how often the agent will find what it needs.';
export class Mnemo {
    store;
    config;
    agentPrincipal;
    userPrincipal;
    llm;
    embedder;
    index = new BM25Index();
    vectors = new VectorIndex();
    records = new Map();
    adaptiveTuner = null;
    lastAdaptive = null;
    constructor(store, config, options) {
        this.store = store;
        this.config = config;
        this.llm = options.llm ?? new NullLLM();
        this.embedder = options.embedder ?? null;
        this.agentPrincipal = options.agentPrincipal ?? 'agent:self';
        this.userPrincipal = options.userPrincipal ?? null;
    }
    /** Open (or create) a memory store at `root`. */
    static async open(root, options = {}) {
        const store = new FileStore(root);
        await store.init();
        const merged = mergeConfig({
            ...(options.config ?? {}),
            adaptive: { ...(options.config?.adaptive ?? {}), ...(options.adaptive ?? {}) },
        });
        const mnemo = new Mnemo(store, merged, options);
        await mnemo.reload();
        if (mnemo.vectorEnabled())
            await mnemo.warmVectors();
        if (mnemo.config.adaptive.enabled)
            await mnemo.initAdaptive();
        return mnemo;
    }
    // --------------------------------------------------------------- adaptive --
    adaptiveStatePath() {
        return path.join(this.store.root, this.config.adaptive.stateFile);
    }
    async initAdaptive() {
        this.adaptiveTuner = await AdaptiveTuner.load(this.adaptiveStatePath(), this.config.adaptive.alpha, this.config.adaptive.warmup);
    }
    /** Whether online parameter tuning is active for this store. */
    adaptiveEnabled() {
        return this.adaptiveTuner !== null;
    }
    /**
     * Report the bandit's state. This exists so adaptive behaviour is auditable:
     * every arm's pull count and mean reward, not just the winning parameters.
     */
    adaptiveStats() {
        if (!this.adaptiveTuner)
            return { enabled: false, observations: 0, arms: [] };
        return {
            enabled: true,
            observations: this.adaptiveTuner.observations,
            arms: this.adaptiveTuner.stats(),
        };
    }
    /**
     * Tell the tuner how the last recall turned out, 0..1.
     *
     * Call it after acting on a recall: 1.0 when the memory actually answered the
     * turn, 0.0 when it was noise. The library cannot infer this without an
     * answer key, so this is the honest interface — and `read()` supplies a
     * conservative heuristic automatically (see below).
     */
    feedback(reward) {
        if (!this.adaptiveTuner || !this.lastAdaptive)
            return;
        this.adaptiveTuner.update(this.lastAdaptive.arm, this.lastAdaptive.context, reward);
        this.lastAdaptive = null;
        void this.saveAdaptiveState();
    }
    /**
     * Close the current turn. Any recall that was never adjudicated counts as a
     * weak negative: the pointers were not used.
     */
    endTurn() {
        if (this.lastAdaptive)
            this.feedback(0.4);
    }
    async saveAdaptiveState() {
        if (!this.adaptiveTuner)
            return;
        try {
            await this.adaptiveTuner.save(this.adaptiveStatePath());
        }
        catch {
            // A failed policy write must not fail a recall. The in-memory state is
            // still correct; the next turn tries again.
        }
    }
    /**
     * Feature vector for the bandit.
     *
     * Deliberately small and cheap to compute: store size, mean retention, mean
     * salience, query length, whether intentions are pending, and how much of the
     * store is competition-suppressed. Normalisation happens in the tuner.
     */
    adaptiveFeatures(query) {
        const now = new Date();
        const live = [...this.records.values()].filter((r) => !r.invalidAt);
        const meanRetention = live.length > 0
            ? live.reduce((sum, r) => sum + retention(r, now, this.config.decay), 0) / live.length
            : 0;
        const meanSalience = live.length > 0 ? live.reduce((sum, r) => sum + r.salience, 0) / live.length / 10 : 0;
        const queryTokens = estimateTokens(query.query ?? '');
        const pending = this.pendingLines(now).trim().length > 0 ? 1 : 0;
        const size = Math.log1p(live.length) / Math.log1p(5000);
        const suppressed = live.length > 0 ? live.filter((r) => r.suppressedAt !== null).length / live.length : 0;
        return [1, size, meanRetention, meanSalience, Math.min(1, queryTokens / 64), pending, suppressed, 0.5];
    }
    /** Re-read every record from disk and rebuild the indexes. Discards nothing. */
    async reload() {
        const records = await this.store.loadAll();
        this.records.clear();
        this.index.clear();
        for (const record of records) {
            this.records.set(record.name, record);
            this.index.add(record.name, tokenize(indexableText(record)));
        }
    }
    // --------------------------------------------------------------- vectors --
    /** Whether semantic retrieval is active given the config, embedder and store size. */
    vectorEnabled() {
        if (!this.embedder)
            return false;
        const { mode, minRecords } = this.config.vector;
        if (mode === 'off')
            return false;
        if (mode === 'on')
            return true;
        return this.records.size >= minRecords;
    }
    vectorPath() {
        return path.join(this.store.root, 'index', 'vectors.jsonl');
    }
    /**
     * Load persisted vectors and embed anything missing.
     *
     * Vectors are a disposable cache keyed by embedder id: switching models
     * invalidates them rather than silently mixing incompatible spaces. Returns
     * how many records were newly embedded.
     */
    async warmVectors() {
        if (!this.embedder)
            return 0;
        const embedderId = this.embedder.id;
        this.vectors = await VectorIndex.load(this.vectorPath(), embedderId);
        const missing = [...this.records.values()].filter((r) => !this.vectors.has(r.name));
        if (missing.length === 0)
            return 0;
        let embedded = 0;
        const batchSize = Math.max(1, this.config.vector.batchSize);
        for (let i = 0; i < missing.length; i += batchSize) {
            const batch = missing.slice(i, i + batchSize);
            const texts = batch.map((r) => `${r.abstract}\n${r.body}`);
            const vectors = await this.embedder.embed(texts);
            for (let j = 0; j < batch.length; j++) {
                const vec = vectors[j];
                if (Array.isArray(vec) && vec.length > 0) {
                    this.vectors.add(batch[j].name, vec, embedderId);
                    embedded++;
                }
            }
        }
        await this.vectors.save(this.vectorPath(), embedderId);
        return embedded;
    }
    /** Embed one record after a write. Silently skips if vectors are off. */
    async embedRecord(record) {
        if (!this.embedder || !this.vectorEnabled())
            return;
        try {
            const [vec] = await this.embedder.embed([`${record.abstract}\n${record.body}`]);
            if (Array.isArray(vec) && vec.length > 0) {
                this.vectors.add(record.name, vec, this.embedder.id);
            }
        }
        catch {
            // An embedding failure must not fail a write. BM25 still works.
        }
    }
    /** Diagnostics for the CLI and for `mnemo stats`. */
    vectorStatus() {
        return {
            enabled: this.vectorEnabled(),
            embedder: this.embedder?.id ?? null,
            indexed: this.vectors.size,
            records: this.records.size,
        };
    }
    /**
     * Look up a live record by name.
     *
     * The slug check is not redundant with the store's own check: it means a
     * caller-supplied string can never reach a path-building code path at all,
     * even if a future refactor removes the store-level guard.
     */
    find(name) {
        const safe = matchSafeName(name);
        if (!safe)
            return null;
        return this.records.get(safe) ?? null;
    }
    // ---------------------------------------------------------------- write --
    async write(input) {
        const now = new Date();
        const notes = [];
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
            .filter((c) => c !== null);
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
        // Disabling this writes every claim as a new record: duplicates pile up and a
        // changed mind leaves two live beliefs. `npm run bench` quantifies the cost.
        const candidates = this.config.consolidation.enabled
            ? [...this.records.values()].filter((r) => !r.invalidAt &&
                r.name !== record.name &&
                r.type === record.type &&
                // Episodes are unique by nature: two conversations about the same
                // topic are two events, not a duplicate claim.
                r.type !== 'episode')
            : [];
        const match = bestMatch(record, candidates);
        let relation = 'created';
        const invalidated = [];
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
            }
            else if (plan.relation === 'refines') {
                relation = 'refines';
                // Merging destroys the old body. Keep a version first: consolidation is
                // the least-proven mechanism here, so it must be reversible.
                await this.store.snapshot(match.record, now);
                mergeIntoRecord(match.record, record, now);
                await this.store.save(match.record);
                this.reindexOne(match.record);
                record = match.record;
                notes.push(`merged into "${match.record.name}": ${plan.reason}`);
            }
            else if (plan.relation === 'supersedes') {
                relation = 'supersedes';
                await this.store.snapshot(match.record, now);
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
        await this.embedRecord(record);
        return { record, relation, invalidated, notes, path: relPath };
    }
    reindexOne(record) {
        this.records.set(record.name, record);
        if (record.invalidAt) {
            // Invalidated records stay in the index: `--as-of` must still find them.
            this.index.add(record.name, tokenize(indexableText(record)));
        }
        else {
            this.index.add(record.name, tokenize(indexableText(record)));
        }
    }
    // --------------------------------------------------------------- recall --
    /**
     * Return L0 pointers. Cheap by construction: abstracts and paths, ~30 tokens
     * each. Bodies are never included.
     *
     * Async because semantic retrieval needs to embed the query. When no embedder
     * is configured the promise resolves immediately on the lexical path.
     */
    async recall(query = {}) {
        // Adaptive path: choose a parameter preset for this turn, then rank with it.
        // The live config is never mutated; `applyConfig` returns a merged copy.
        let effective = this.config;
        if (this.adaptiveTuner) {
            const context = this.adaptiveFeatures(query);
            const choice = this.adaptiveTuner.select(context);
            effective = this.adaptiveTuner.applyConfig(this.config, choice.arm);
            this.lastAdaptive = { arm: choice.arm, context, hits: [] };
        }
        const engine = {
            records: [...this.records.values()],
            index: this.index,
            config: effective,
            pathOf: (name) => {
                const record = this.find(name);
                if (!record)
                    return '';
                return this.store.relativePathFor(record).split(path.sep).join('/');
            },
        };
        let vectorHits;
        if (this.embedder && this.vectorEnabled() && query.query?.trim() && this.vectors.size > 0) {
            try {
                const [qVec] = await this.embedder.embed([query.query]);
                if (Array.isArray(qVec) && qVec.length > 0) {
                    vectorHits = new Map(this.vectors.search(qVec, 200).map((h) => [h.id, h.norm]));
                }
            }
            catch {
                // Vector search is an enhancement: on failure, fall back to lexical.
                vectorHits = undefined;
            }
        }
        const hits = retrieve(engine, {
            ...query,
            vectorHits,
            vectorBlend: effective.vector.blend,
        });
        for (const hit of hits) {
            reinforce(hit.record, new Date(), effective.decay);
            void this.store.update(hit.record).catch(() => {
                // A failed access-count update must never fail a read.
            });
        }
        // Retrieval-induced forgetting: the winner quiets its near-duplicates for a
        // few days. Deliberately weak (see memory/competition.ts) so a real second
        // answer is never lost.
        if (effective.competition.enabled && hits.length > 0) {
            const now = new Date();
            const suppressed = suppressCompetitors(hits[0].record, [...this.records.values()], effective.competition, now);
            for (const record of suppressed) {
                void this.store.update(record).catch(() => undefined);
            }
        }
        if (this.lastAdaptive)
            this.lastAdaptive.hits = hits.map((hit) => hit.record.name);
        return hits;
    }
    /**
     * Feeling of knowing: ask whether memory has anything, without paying for a
     * full recall. Returns a pointer at most — never a body.
     *
     * Synchronous and lexical-only by design: the whole point is that this is
     * cheaper than the thing it might save you from doing.
     */
    feel(query) {
        return probeMetamemory({
            index: this.index,
            records: [...this.records.values()],
            query,
            now: new Date(),
            config: this.config,
            pathOf: (name) => {
                const record = this.find(name);
                return record ? this.store.relativePathFor(record).split(path.sep).join('/') : '';
            },
        });
    }
    /** The probe rendered as the single line a model sees. */
    feelLine(query) {
        return renderProbe(this.feel(query));
    }
    /** Same as recall, but returns the rendered one-line handles. */
    async recallLines(query = {}) {
        const now = new Date();
        const hits = await this.recall(query);
        return hits.map((hit) => renderL0(hit, now));
    }
    // ----------------------------------------------------------------- read --
    async read(name, depth = 'l1') {
        const record = this.find(name);
        // Reading one of the pointers a recall just returned is the honest, cheap
        // reward signal: the recall was good enough that a body was actually opened.
        const safe = matchSafeName(name);
        if (this.lastAdaptive && safe) {
            const hit = this.lastAdaptive.hits.includes(safe);
            this.feedback(hit ? 0.85 : 0.25);
        }
        if (!record)
            return null;
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
    async reconstruct(name, situation = '') {
        const record = this.find(name);
        if (!record)
            return null;
        const now = new Date();
        let text;
        let usedLLM = false;
        if (this.llm.name !== 'null') {
            const prompt = `你在回忆"${record.abstract}"。当前情境：${situation || '（无）'}。
记忆正文：${record.body.slice(0, 1200)}
用一到两句话说明你记得什么。如果记不清就直说。不要声称这是原话，不要补充正文里没有的信息。`;
            try {
                const out = await this.llm.complete({ prompt, maxTokens: 160, temperature: 0.3 });
                text = out.trim() || record.abstract;
                usedLLM = text.length > 0;
            }
            catch {
                text = record.abstract;
            }
        }
        else {
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
    async forget(name, reason = '') {
        const record = this.find(name);
        if (!record)
            return false;
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
    async consolidate(now = new Date()) {
        const archived = [];
        const live = [...this.records.values()];
        for (const record of live) {
            if (record.invalidAt)
                continue;
            if (record.type === 'persona' || record.type === 'intention')
                continue;
            if (retentionTier(record, now, this.config.decay) !== 'archived')
                continue;
            await this.store.archive(record);
            archived.push(record.name);
            this.records.delete(record.name);
            this.index.remove(record.name);
            this.vectors.remove(record.name);
        }
        return { archived, scanned: live.length };
    }
    // ------------------------------------------------------------------ cue --
    async cue(name, cues) {
        const record = this.find(name);
        if (!record)
            return false;
        const normalised = cues
            .map(coerceCue)
            .filter((c) => c !== null)
            .map((c) => `${c.kind}:${c.value}`);
        record.cues = Array.from(new Set([...record.cues, ...normalised]));
        record.updatedAt = nowIso(new Date());
        await this.store.update(record);
        this.reindexOne(record);
        return true;
    }
    // -------------------------------------------------------------- episode --
    /**
     * Collapse a stretch of conversation into one episode.
     *
     * This is the episodic layer: facts record what is true, episodes record that
     * something *happened* — who was there, what was decided, how it ended. It is
     * what lets "上次那次" resolve to anything at all, and it is the one form of
     * memory a flat fact store cannot express.
     *
     * The summary is the L0 handle *and* the basis for the file name, so listing
     * episodes is already an index: you can answer "when did we talk about this"
     * from the listing alone, without reading a single body.
     *
     * Episodes never consolidate with each other. Two conversations about the same
     * topic are two events, not a duplicate claim.
     */
    async checkpoint(input) {
        const summary = input.summary.trim();
        if (!summary)
            throw new RecordValidationError('checkpoint needs a summary');
        const result = await this.write({
            name: '',
            abstract: summary,
            body: input.body ?? summary,
            type: 'episode',
            group: 'episode',
            salience: input.salience ?? 6,
            links: input.facts ?? [],
            provenance: input.sessionId ? [`${input.sessionId}#episode`] : [],
            validFrom: input.at ? input.at.toISOString() : undefined,
        });
        return result;
    }
    /**
     * Episodes, newest first. Title-only by design: this is the listing an agent
     * reads before deciding whether to open one.
     */
    episodes(limit = 10) {
        return [...this.records.values()]
            .filter((r) => r.type === 'episode' && !r.invalidAt)
            .sort((a, b) => String(b.validFrom).localeCompare(String(a.validFrom)))
            .slice(0, Math.max(1, limit))
            .map((record) => ({
            name: record.name,
            title: record.abstract,
            at: record.validFrom,
            facts: record.links,
            path: this.store.relativePathFor(record).split(path.sep).join('/'),
        }));
    }
    /** Episodes as the one-line-per-item block a model can read cheaply. */
    episodeLines(limit = 10) {
        return this.episodes(limit).map((episode) => `- ${episode.title} · ${episode.at.slice(0, 10)} · ${episode.path}`);
    }
    // --------------------------------------------------------------- intend --
    /** Register a delayed intention. Triggers on a timestamp or on event keywords. */
    async intend(input) {
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
    due(now = new Date(), contextText = '') {
        return dueIntentions([...this.records.values()], now, contextText);
    }
    /** The resident "things you are keeping an eye on" block. Empty when nothing is close. */
    pendingLines(now = new Date(), opts = {}) {
        return renderPending([...this.records.values()], now, opts);
    }
    // -------------------------------------------------------------- context --
    /** Assemble a cache-aware prompt with a stable prefix and a volatile suffix. */
    buildContext(input) {
        return assemble(input, this.config.budget);
    }
    /** The resident MEMORY.md index, capped to the configured line budget. */
    memoryIndex(now = new Date()) {
        return buildMemoryIndex([...this.records.values()], { now });
    }
    /** Deterministic tool serialisation. Use this, not JSON.stringify, in the prefix. */
    toolBlock(tools) {
        return stableToolBlock(tools);
    }
    // -------------------------------------------------------------- offload --
    async offload(sessionId, toolName, output) {
        return maybeOffload(this.store, sessionId, toolName, output, {
            thresholdTokens: this.config.offloadThresholdTokens,
        });
    }
    async readOffload(sessionId, ref, options = {}) {
        return readOffloadFile(this.store, sessionId, ref, options);
    }
    // --------------------------------------------------------------- history --
    /**
     * Versions preserved for a record, newest first.
     *
     * Every merge and every supersede writes one before overwriting anything, so a
     * consolidation that turned out to be wrong can be undone instead of merely
     * being switched off next time.
     */
    async history(name) {
        return this.store.historyVersions(name);
    }
    /** Restore a record from a preserved version. Defaults to the newest one. */
    async restore(name, version) {
        const versions = await this.store.historyVersions(name);
        const chosen = version ?? versions[0];
        if (!chosen)
            return false;
        const raw = await this.store.readVersion(name, chosen);
        if (!raw)
            return false;
        const record = deserializeRecord(raw);
        await this.store.save(record);
        this.reindexOne(record);
        return true;
    }
    // ------------------------------------------------------------- self-test --
    /**
     * Calibrate confidence empirically: ask each record to find itself.
     *
     * Borrowed from decoy verification — instead of trusting a `confidence` value
     * that was set once at write time and has never been checked, run a probe whose
     * answer is known. If a record cannot be retrieved by its own abstract, either
     * something more relevant now outranks it or the index is unhealthy.
     *
     * Read the caveat in the report before treating the number as a user metric:
     * self-retrieval is easier than a real query, so this is a *relative* health
     * signal and a corruption detector, not an estimate of answer quality.
     *
     * Deterministic sampling: records are sorted and taken at a fixed stride, so the
     * same store produces the same sample.
     */
    async selfTest(options = {}) {
        const sampleSize = Math.max(1, options.samples ?? 20);
        const learningRate = Math.min(1, Math.max(0.01, options.learningRate ?? 0.3));
        const live = [...this.records.values()]
            .filter((r) => !r.invalidAt && r.type !== 'persona')
            .sort((a, b) => a.name.localeCompare(b.name));
        if (live.length === 0) {
            return {
                samples: 0,
                hits: 0,
                hitRate: 0,
                updated: 0,
                weakest: [],
                caveat: SELF_TEST_CAVEAT,
            };
        }
        const stride = Math.max(1, Math.floor(live.length / sampleSize));
        const sample = live.filter((_, index) => index % stride === 0).slice(0, sampleSize);
        const engine = {
            records: live,
            index: this.index,
            config: this.config,
            pathOf: (name) => {
                const record = this.find(name);
                return record ? this.store.relativePathFor(record).split(path.sep).join('/') : '';
            },
        };
        let hits = 0;
        let updated = 0;
        const weakest = [];
        for (const record of sample) {
            const top = retrieve(engine, { query: record.abstract, limit: 1 });
            const hit = top.length > 0 && top[0].record.name === record.name;
            if (hit)
                hits++;
            const before = record.confidence;
            record.confidence = Math.min(1, Math.max(0.05, before * (1 - learningRate) + (hit ? 1 : 0) * learningRate));
            if (Math.abs(record.confidence - before) > 1e-6) {
                await this.store.update(record);
                updated++;
            }
            if (!hit)
                weakest.push({ name: record.name, before, after: record.confidence });
        }
        weakest.sort((a, b) => a.after - b.after);
        return {
            samples: sample.length,
            hits,
            hitRate: sample.length > 0 ? hits / sample.length : 0,
            updated,
            weakest,
            caveat: SELF_TEST_CAVEAT,
        };
    }
    // -------------------------------------------------------------- metrics --
    metrics(now = new Date()) {
        const live = [...this.records.values()].filter((r) => !r.invalidAt);
        const byType = {};
        const byTier = {};
        let eligible = 0;
        let relayed = 0;
        let confidenceSum = 0;
        for (const record of live) {
            byType[record.type] = (byType[record.type] ?? 0) + 1;
            const t = retentionTier(record, now, this.config.decay);
            byTier[t] = (byTier[t] ?? 0) + 1;
            if (decisionEligible(record))
                eligible++;
            if (record.hop > 0)
                relayed++;
            confidenceSum += record.confidence;
        }
        return {
            total: live.length,
            byType,
            byTier,
            pendingIntentions: [...this.records.values()].filter((r) => r.type === 'intention' && (r.status ?? 'pending') === 'pending' && isUpcoming(r, now, 3650)).length,
            decisionEligible: eligible,
            relayed,
            meanConfidence: live.length > 0 ? confidenceSum / live.length : 0,
        };
    }
    /** Raw record access, for tooling and tests. Returns a copy. */
    get(name) {
        const record = this.find(name);
        return record ? structuredClone(record) : null;
    }
    /** All live (non-superseded) records. Returns copies. */
    all() {
        return [...this.records.values()]
            .filter((r) => !r.invalidAt)
            .map((r) => structuredClone(r));
    }
    /**
     * A one-shot summary used by the CLI and by tests: what a model would see at
     * session start, and how much of it is cacheable.
     */
    bootContext(options = {}) {
        return this.buildBootContext(options);
    }
    async buildBootContext(options = {}) {
        const pending = this.pendingLines();
        const now = new Date();
        // Fetch a wider candidate pool than the budget will hold, then let the
        // value-per-token allocator decide what is worth the tokens.
        const hits = await this.recall({
            limit: Math.max(this.config.retrieve.limit * 3, 12),
        });
        const retrievedItems = hits.map((hit) => ({
            id: hit.record.name,
            text: renderL0(hit, now),
            score: hit.score,
        }));
        return this.buildContext({
            system: options.system ?? DEFAULT_SYSTEM,
            memoryIndex: this.memoryIndex(),
            pending: pending || undefined,
            retrievedItems,
            userMessage: options.userMessage ?? '',
        });
    }
}
export const DEFAULT_SYSTEM = '你是一个有长期记忆的助手。\n' +
    '下面给你的记忆索引只是指针，不是原文。需要细节时读取对应文件，不要凭摘要编造内容。\n' +
    '标注 relayed 的记忆是别人转述的，只能提及，不能据此做决定。';
/** Minimal outline: headings plus the first line under each. Costs ~1/8 of the body. */
export function outlineOf(body) {
    if (!body)
        return '';
    const lines = body.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('#')) {
            out.push(line);
            const next = lines.slice(i + 1).find((l) => l.trim().length > 0);
            if (next && !next.startsWith('#'))
                out.push(next.trim().slice(0, 80));
        }
    }
    if (out.length === 0) {
        // No structure to outline: a prefix of the body beats a full read.
        return lines.slice(0, 6).join('\n');
    }
    return out.join('\n');
}
export { heuristicGist };
//# sourceMappingURL=mnemo.js.map