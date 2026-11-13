/**
 * A brute-force vector index with JSONL persistence.
 *
 * No HNSW, no FAISS, no native module. At the sizes where vectors are worth
 * using here (5k–100k records) a linear scan over unit vectors is a few
 * milliseconds and costs nothing to maintain, and it keeps the "zero runtime
 * dependencies" promise intact.
 *
 * The index lives in `store/index/vectors.jsonl`, which is disposable: it can be
 * rebuilt from the records with one embedder call per record.
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { cosine, normalize } from './embedder.js';
export class VectorIndex {
    vectors = new Map();
    embedderId = null;
    get size() {
        return this.vectors.size;
    }
    /** Which embedder produced the stored vectors, if any. */
    get producer() {
        return this.embedderId;
    }
    add(id, vec, embedderId) {
        if (embedderId && this.embedderId && embedderId !== this.embedderId) {
            throw new Error(`vector index already holds ${this.embedderId} vectors; refusing to mix ${embedderId}`);
        }
        if (embedderId)
            this.embedderId = embedderId;
        this.vectors.set(id, normalize(vec));
    }
    remove(id) {
        this.vectors.delete(id);
    }
    has(id) {
        return this.vectors.has(id);
    }
    clear() {
        this.vectors.clear();
        this.embedderId = null;
    }
    ids() {
        return [...this.vectors.keys()];
    }
    search(query, limit = 50) {
        if (this.vectors.size === 0)
            return [];
        const q = normalize(query);
        const hits = [];
        for (const [id, vec] of this.vectors) {
            const score = cosine(q, vec);
            if (score > 0)
                hits.push({ id, score, norm: 0 });
        }
        hits.sort((a, b) => b.score - a.score);
        const top = hits.slice(0, limit);
        const max = top.length > 0 ? top[0].score : 0;
        if (max > 0)
            for (const hit of top)
                hit.norm = Math.max(0, hit.score / max);
        return top;
    }
    // ------------------------------------------------------------ persistence --
    static async load(file, embedderId) {
        const index = new VectorIndex();
        let raw;
        try {
            raw = await readFile(file, 'utf8');
        }
        catch {
            return index;
        }
        for (const line of raw.split('\n')) {
            if (!line.trim())
                continue;
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue; // Corrupt line: skip. The index is a cache, not the truth.
            }
            // Vectors from a different model are incomparable; reject rather than
            // silently mixing spaces, which would produce plausible-looking garbage.
            if (row.embedder !== embedderId) {
                index.clear();
                return index;
            }
            if (Array.isArray(row.vec) && row.vec.length > 0)
                index.add(row.id, row.vec, embedderId);
        }
        return index;
    }
    async save(file, embedderId) {
        await mkdir(path.dirname(file), { recursive: true });
        const lines = [];
        for (const [id, vec] of this.vectors) {
            lines.push(JSON.stringify({ id, embedder: embedderId, vec }));
        }
        const tmp = `${file}.tmp-${process.pid}`;
        await writeFile(tmp, lines.join('\n'), 'utf8');
        await rename(tmp, file);
    }
}
//# sourceMappingURL=vector-index.js.map