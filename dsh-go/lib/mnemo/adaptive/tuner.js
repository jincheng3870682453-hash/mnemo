/**
 * Contextual bandit for decay/retrieval parameters.
 *
 * Why a bandit and not an LLM
 * ---------------------------
 * The library's own README lists "every decay parameter is hand-tuned, none is
 * calibrated" as a limitation. The obvious fix — call a model to pick the
 * parameters — adds latency, cost and a dependency to the hot path, and makes
 * every ranking decision unauditable. A contextual bandit, by contrast:
 *
 *   • costs a few microseconds of linear algebra;
 *   • is deterministic given its state file, so a benchmark can replay it;
 *   • keeps its entire policy in `adaptive.json`, which is plain JSON;
 *   • explores explicitly instead of trusting a one-shot guess.
 *
 * Model
 * -----
 * LinUCB (Li et al., 2010). For each arm a:
 *
 *   theta_a = A_a^-1 b_a
 *   p_a     = theta_a^T x + alpha * sqrt(x^T A_a^-1 x)
 *   reward  = caller feedback, 0..1
 *
 * A_a starts at the identity (a weak prior that keeps the inverse well-defined),
 * b_a at zero. Every reward updates A_a and b_a. The arm set is a small,
 * human-readable list of parameter presets — see `ARMS` — so the bandit can
 * only choose among policies the author is willing to defend.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
/** Feature vector length. Kept small on purpose: fewer dimensions, faster inverse. */
export const FEATURE_DIM = 8;
/**
 * The arm set.
 *
 * These are not magic numbers: each is a readable hypothesis about what kind of
 * workload the agent is in. `default` is arm 0 and stays in the mix — if the
 * bandit cannot beat the hand-tuned baseline, it must be able to return to it.
 */
export const ARMS = [
    { label: 'default', params: {} },
    {
        label: 'recency-first',
        params: {
            retrieve: {
                weights: { recency: 1.4, importance: 1.2, relevance: 1.8, goalFit: 1.4 },
                limit: 8,
            },
        },
    },
    {
        label: 'relevance-first',
        params: {
            retrieve: {
                weights: { recency: 0.4, importance: 1.2, relevance: 3.2, goalFit: 1.6 },
                limit: 8,
            },
        },
    },
    {
        label: 'goal-first',
        params: {
            retrieve: {
                weights: { recency: 0.4, importance: 1.2, relevance: 1.8, goalFit: 3.0 },
                limit: 8,
            },
        },
    },
    {
        label: 'slow-forgetting',
        params: { decay: { exponent: 0.5, stabilityGrowth: 1.6 } },
    },
    {
        label: 'fast-forgetting',
        params: { decay: { exponent: 0.95, stabilityGrowth: 1.15 } },
    },
];
// --------------------------------------------------------------- linear algebra --
function identity(d) {
    const m = [];
    for (let i = 0; i < d; i++) {
        const row = new Array(d).fill(0);
        row[i] = 1;
        m.push(row);
    }
    return m;
}
function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++)
        s += a[i] * b[i];
    return s;
}
/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solve(A, b) {
    const n = b.length;
    const m = A.map((row) => row.slice());
    const rhs = b.slice();
    for (let col = 0; col < n; col++) {
        let pivot = col;
        for (let row = col + 1; row < n; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col]))
                pivot = row;
        }
        if (Math.abs(m[pivot][col]) < 1e-12)
            continue;
        if (pivot !== col) {
            [m[pivot], m[col]] = [m[col], m[pivot]];
            [rhs[pivot], rhs[col]] = [rhs[col], rhs[pivot]];
        }
        const pv = m[col][col];
        for (let row = col + 1; row < n; row++) {
            const factor = m[row][col] / pv;
            if (factor === 0)
                continue;
            for (let k = col; k < n; k++)
                m[row][k] -= factor * m[col][k];
            rhs[row] -= factor * rhs[col];
        }
    }
    const x = new Array(n).fill(0);
    for (let row = n - 1; row >= 0; row--) {
        let sum = rhs[row];
        for (let k = row + 1; k < n; k++)
            sum -= m[row][k] * x[k];
        const diag = m[row][row];
        x[row] = Math.abs(diag) < 1e-12 ? 0 : sum / diag;
    }
    return x;
}
/** A^-1 x, without materialising A^-1. */
function applyInverse(A, x) {
    return solve(A, x);
}
// ------------------------------------------------------------------- tuner --
export class AdaptiveTuner {
    alpha;
    warmup;
    arms;
    pulls;
    rewardSum;
    constructor(alpha = 1.0, warmup = 8, state) {
        this.alpha = Math.max(0, alpha);
        this.warmup = Math.max(0, warmup);
        if (state && state.version === 1 && state.arms.length === ARMS.length) {
            this.arms = state.arms.map((a) => ({ A: a.A.map((row) => row.slice()), b: a.b.slice() }));
            this.pulls = state.pulls.slice();
            this.rewardSum = state.rewardSum.slice();
        }
        else {
            this.arms = ARMS.map(() => ({ A: identity(FEATURE_DIM), b: new Array(FEATURE_DIM).fill(0) }));
            this.pulls = new Array(ARMS.length).fill(0);
            this.rewardSum = new Array(ARMS.length).fill(0);
        }
    }
    /** Load persisted state, or start fresh when the file is missing/corrupt. */
    static async load(file, alpha = 1.0, warmup = 8) {
        try {
            const raw = await readFile(file, 'utf8');
            const parsed = JSON.parse(raw);
            return new AdaptiveTuner(alpha, warmup, parsed);
        }
        catch {
            return new AdaptiveTuner(alpha, warmup);
        }
    }
    async save(file) {
        await mkdir(path.dirname(file), { recursive: true });
        const state = {
            version: 1,
            arms: this.arms,
            pulls: this.pulls,
            rewardSum: this.rewardSum,
        };
        await writeFile(file, JSON.stringify(state), 'utf8');
    }
    /** Total pulls across all arms. */
    get observations() {
        return this.pulls.reduce((sum, n) => sum + n, 0);
    }
    /**
     * Choose an arm. During warm-up the default arm is forced so the caller's own
     * configuration gets a fair sample before the bandit starts steering.
     */
    select(features) {
        const x = normaliseFeatures(features);
        if (this.observations < this.warmup) {
            return { arm: 0, label: ARMS[0].label, ucb: 0 };
        }
        let best = 0;
        let bestUcb = -Infinity;
        for (let arm = 0; arm < this.arms.length; arm++) {
            const { A, b } = this.arms[arm];
            const theta = solve(A, b);
            const exploit = dot(theta, x);
            const invx = applyInverse(A, x);
            const explore = Math.sqrt(Math.max(0, dot(x, invx)));
            const ucb = exploit + this.alpha * explore;
            if (ucb > bestUcb) {
                bestUcb = ucb;
                best = arm;
            }
        }
        return { arm: best, label: ARMS[best].label, ucb: bestUcb };
    }
    /** Record a reward in 0..1 for the arm that was chosen. */
    update(arm, features, reward) {
        if (arm < 0 || arm >= this.arms.length)
            return;
        const x = normaliseFeatures(features);
        const r = Math.min(1, Math.max(0, reward));
        const { A, b } = this.arms[arm];
        // A <- A + x x^T ; b <- b + r x
        for (let i = 0; i < FEATURE_DIM; i++) {
            for (let j = 0; j < FEATURE_DIM; j++) {
                A[i][j] += x[i] * x[j];
            }
            b[i] += r * x[i];
        }
        this.pulls[arm] += 1;
        this.rewardSum[arm] += r;
    }
    /** Per-arm diagnostics for the CLI, the demo and `npm run bench:adaptive`. */
    stats() {
        return this.arms.map((arm, index) => {
            const theta = solve(arm.A, arm.b);
            return {
                arm: index,
                label: ARMS[index].label,
                pulls: this.pulls[index],
                meanReward: this.pulls[index] > 0 ? this.rewardSum[index] / this.pulls[index] : 0,
                thetaNorm: Math.sqrt(dot(theta, theta)),
            };
        });
    }
    /** Merge the chosen arm's overrides over a live config without mutating it. */
    applyConfig(base, arm) {
        const params = ARMS[arm]?.params ?? {};
        return mergeOverrides(base, params);
    }
    toJSON() {
        return {
            version: 1,
            arms: this.arms,
            pulls: this.pulls,
            rewardSum: this.rewardSum,
        };
    }
}
/**
 * Clamp and rescale features.
 *
 * The first feature is a bias term fixed at 1. Everything else is put in 0..1 so
 * one signal cannot dominate the covariance matrix by being large. Retrieval
 * calls this on every recall, so it stays allocation-light.
 */
export function normaliseFeatures(raw) {
    const out = new Array(FEATURE_DIM).fill(0);
    out[0] = 1;
    for (let i = 1; i < FEATURE_DIM; i++) {
        const v = raw[i] ?? 0;
        out[i] = Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
    }
    return out;
}
/** Deep-ish merge used by both the tuner and `Mnemo` to apply arm overrides. */
export function mergeOverrides(base, patch) {
    const out = structuredClone(base);
    if (patch.decay)
        Object.assign(out.decay, patch.decay);
    if (patch.retrieve) {
        const { weights, ...rest } = patch.retrieve;
        Object.assign(out.retrieve, rest);
        if (weights)
            Object.assign(out.retrieve.weights, weights);
    }
    if (patch.budget)
        Object.assign(out.budget, patch.budget);
    if (patch.vector)
        Object.assign(out.vector, patch.vector);
    if (patch.consolidation)
        Object.assign(out.consolidation, patch.consolidation);
    if (patch.competition)
        Object.assign(out.competition, patch.competition);
    if (patch.adaptive)
        Object.assign(out.adaptive, patch.adaptive);
    if (patch.abstractMaxChars !== undefined)
        out.abstractMaxChars = patch.abstractMaxChars;
    if (patch.verbatimTtlDays !== undefined)
        out.verbatimTtlDays = patch.verbatimTtlDays;
    if (patch.offloadThresholdTokens !== undefined) {
        out.offloadThresholdTokens = patch.offloadThresholdTokens;
    }
    return out;
}
//# sourceMappingURL=tuner.js.map