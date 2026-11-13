/**
 * A small BM25 implementation with a hand-rolled inverted index.
 *
 * Why not embeddings by default? Because the measured trade-off is poor at the
 * sizes a personal agent actually reaches: an existing implementation reported
 * Recall@5 moving 79.0% -> 86.6% while median latency went 5.1ms -> 139.2ms.
 * BM25 keeps the read path at microseconds and needs no model, no network and no
 * native module. Vectors are an opt-in upgrade, not the foundation.
 */
export class BM25Index {
    postings = new Map();
    docLen = new Map();
    totalLen = 0;
    k1;
    b;
    constructor(opts = {}) {
        this.k1 = opts.k1 ?? 1.5;
        this.b = opts.b ?? 0.75;
    }
    get size() {
        return this.docLen.size;
    }
    add(id, tokens) {
        if (this.docLen.has(id))
            this.remove(id);
        if (tokens.length === 0) {
            this.docLen.set(id, 0);
            return;
        }
        const tf = new Map();
        for (const t of tokens)
            tf.set(t, (tf.get(t) ?? 0) + 1);
        for (const [term, count] of tf) {
            let docs = this.postings.get(term);
            if (!docs) {
                docs = new Map();
                this.postings.set(term, docs);
            }
            docs.set(id, count);
        }
        this.docLen.set(id, tokens.length);
        this.totalLen += tokens.length;
    }
    remove(id) {
        const len = this.docLen.get(id);
        if (len === undefined)
            return;
        this.totalLen -= len;
        this.docLen.delete(id);
        for (const [term, docs] of this.postings) {
            if (docs.delete(id) && docs.size === 0)
                this.postings.delete(term);
        }
    }
    clear() {
        this.postings.clear();
        this.docLen.clear();
        this.totalLen = 0;
    }
    idf(term) {
        const n = this.docLen.size;
        if (n === 0)
            return 0;
        const df = this.postings.get(term)?.size ?? 0;
        // BM25+ style floor keeps very common terms from going strongly negative.
        return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    }
    search(tokens, limit = 50) {
        if (tokens.length === 0 || this.docLen.size === 0)
            return [];
        const avgLen = this.totalLen / Math.max(1, this.docLen.size);
        const scores = new Map();
        for (const term of tokens) {
            const docs = this.postings.get(term);
            if (!docs)
                continue;
            const idf = this.idf(term);
            for (const [docId, tf] of docs) {
                const len = this.docLen.get(docId) ?? 0;
                const denom = tf + this.k1 * (1 - this.b + (this.b * len) / Math.max(1, avgLen));
                const contribution = (idf * (tf * (this.k1 + 1))) / denom;
                scores.set(docId, (scores.get(docId) ?? 0) + contribution);
            }
        }
        const hits = [];
        for (const [id, score] of scores) {
            if (score > 0)
                hits.push({ id, score, norm: 0 });
        }
        hits.sort((a, b) => b.score - a.score);
        const top = hits.slice(0, limit);
        const max = top.length > 0 ? top[0].score : 0;
        if (max > 0)
            for (const hit of top)
                hit.norm = hit.score / max;
        return top;
    }
}
//# sourceMappingURL=bm25.js.map