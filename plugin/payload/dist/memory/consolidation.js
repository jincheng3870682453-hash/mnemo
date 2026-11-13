/**
 * Consolidation: what to do when a new claim arrives that resembles an old one.
 *
 * Four outcomes, and only four:
 *
 *   duplicate  the same claim again        -> touch it, do not duplicate
 *   refines    more detail on the same thing -> merge into the existing body
 *   supersedes the new claim contradicts   -> invalidate the old one, keep the link
 *   unrelated  nothing to do              -> write a new record
 *
 * "supersedes" never deletes. The old record gets `invalidAt` and the new record
 * links back to it, because changing your mind while remembering that you changed
 * it is a defining property of human memory — and because it makes `--as-of`
 * queries answerable.
 *
 * Caution from the literature: a 2026 study found that consolidation *quality
 * scores* do not predict downstream answer accuracy (Spearman rho -0.24), and an
 * independent replication found a nightly consolidation cycle made results
 * slightly worse. So this module is conservative by design and exposes its
 * decisions as a plan you can log, diff and disable.
 */
import { CONSOLIDATE_PROMPT } from '../llm/prompts.js';
import { tokenOverlap, tokenize } from '../util/text.js';
import { contradicts } from './attribution.js';
import { nowIso } from '../util/time.js';
const DUPLICATE_THRESHOLD = 0.85;
const REFINE_THRESHOLD = 0.5;
const CONTRADICT_THRESHOLD = 0.3;
/**
 * Deterministic relation decision. Used directly offline, and as the fallback
 * whenever a model response cannot be parsed.
 */
export function decideRelation(incoming, existing) {
    const similarity = tokenOverlap(tokenize(incoming.abstract), tokenize(existing.abstract));
    // Contradiction is checked before duplication on purpose: "likes X" and
    // "dislikes X" are lexically near-identical, and reporting the second as a
    // duplicate would silently keep a belief the person has already abandoned.
    if (contradicts(incoming, existing) && similarity >= CONTRADICT_THRESHOLD) {
        return {
            relation: 'supersedes',
            invalidate: [],
            mergeInto: null,
            reason: 'opposite polarity on the same subject',
            similarity,
        };
    }
    if (similarity >= DUPLICATE_THRESHOLD) {
        return { relation: 'duplicate', invalidate: [], mergeInto: null, reason: 'same claim, near-identical wording', similarity };
    }
    if (similarity >= REFINE_THRESHOLD) {
        return { relation: 'refines', invalidate: [], mergeInto: null, reason: 'same topic, more specific', similarity };
    }
    return { relation: 'unrelated', invalidate: [], mergeInto: null, reason: 'no meaningful overlap', similarity };
}
/** Pick the best existing match for an incoming record. */
export function bestMatch(incoming, candidates) {
    let best = null;
    for (const candidate of candidates) {
        if (candidate.invalidAt)
            continue;
        const plan = decideRelation(incoming, candidate);
        if (plan.relation === 'unrelated')
            continue;
        if (!best || plan.similarity > best.plan.similarity) {
            best = { record: candidate, plan };
        }
    }
    return best;
}
/**
 * Optional model-in-the-loop refinement of the relation. The deterministic
 * decision is computed first and is returned unchanged if the model disagrees
 * with an unparseable response — the model may only *upgrade* a decision it
 * understands, never silently overturn one it does not.
 */
export async function refineWithLLM(plan, incoming, existing, llm) {
    if (!llm || llm.name === 'null')
        return plan;
    const prompt = CONSOLIDATE_PROMPT
        .replace('{existing}', existing.abstract)
        .replace('{incoming}', incoming.abstract);
    try {
        const text = await llm.complete({ prompt, maxTokens: 120, temperature: 0, json: true });
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end <= start)
            return plan;
        const parsed = JSON.parse(text.slice(start, end + 1));
        const allowed = ['duplicate', 'refines', 'supersedes', 'unrelated'];
        if (typeof parsed.relation !== 'string' || !allowed.includes(parsed.relation)) {
            return plan;
        }
        return {
            ...plan,
            relation: parsed.relation,
            reason: typeof parsed.reason === 'string' ? parsed.reason : plan.reason,
        };
    }
    catch {
        return plan;
    }
}
/**
 * Merge a refining claim into an existing record in place.
 * The abstract is kept (it is the stable L0 handle); only the body grows.
 */
export function mergeIntoRecord(target, incoming, now) {
    const addition = incoming.body.trim();
    if (addition.length > 0 && !target.body.includes(addition)) {
        target.body = `${target.body}\n\n---\n\n${addition}`.trim();
    }
    target.salience = Math.max(target.salience, incoming.salience);
    target.future = Array.from(new Set([...target.future, ...incoming.future]));
    target.cues = Array.from(new Set([...target.cues, ...incoming.cues]));
    target.provenance = Array.from(new Set([...target.provenance, ...incoming.provenance]));
    target.updatedAt = nowIso(now);
    return target;
}
/** Mark a record as superseded without deleting it. */
export function supersedeRecord(target, now) {
    target.invalidAt = nowIso(now);
    target.updatedAt = nowIso(now);
    return target;
}
//# sourceMappingURL=consolidation.js.map