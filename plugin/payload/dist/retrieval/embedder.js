/**
 * Pluggable embeddings.
 *
 * Vectors are deliberately *not* the default. Measured in an existing
 * implementation: Recall@5 improved 79.0% -> 86.6% while median latency went
 * 5.1 ms -> 139.2 ms. At personal-agent scale that trade is bad, which is why
 * `vector.mode` defaults to `off` and only flips to `auto` above
 * `minRecords` (default 5,000).
 *
 * Anything implementing `Embedder` works — a hosted API, a local ONNX model, a
 * fake for tests. The library never assumes a provider.
 */
/** Cosine similarity. Returns 0 for zero-length or mismatched vectors. */
export function cosine(a, b) {
    if (a.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0)
        return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
/** Normalise to unit length so cosine reduces to a dot product. Returns a new array. */
export function normalize(vec) {
    let sum = 0;
    for (const v of vec)
        sum += v * v;
    const norm = Math.sqrt(sum);
    if (norm === 0)
        return vec.slice();
    return vec.map((v) => v / norm);
}
/** Adapter for any OpenAI-compatible `/embeddings` endpoint. */
export class OpenAIEmbedder {
    id;
    endpoint;
    model;
    apiKey;
    extraHeaders;
    timeoutMs;
    batchSize;
    fetchImpl;
    constructor(options) {
        const base = options.baseUrl.replace(/\/+$/, '');
        this.endpoint = base.endsWith('/embeddings') ? base : `${base}/embeddings`;
        this.model = options.model;
        const envName = options.apiKeyEnv ?? 'OPENAI_API_KEY';
        this.apiKey = options.apiKey ?? process.env[envName] ?? '';
        if (!this.apiKey)
            throw new Error(`no API key: pass options.apiKey or set ${envName}`);
        this.extraHeaders = options.headers ?? {};
        this.timeoutMs = options.timeoutMs ?? 60_000;
        this.batchSize = options.batchSize ?? 64;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.id = `openai:${options.model}`;
    }
    async embed(texts) {
        const out = [];
        for (let i = 0; i < texts.length; i += this.batchSize) {
            const batch = texts.slice(i, i + this.batchSize);
            out.push(...(await this.embedBatch(batch)));
        }
        return out;
    }
    async embedBatch(texts) {
        if (texts.length === 0)
            return [];
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(this.endpoint, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.apiKey}`,
                    ...this.extraHeaders,
                },
                body: JSON.stringify({ model: this.model, input: texts }),
                signal: controller.signal,
            });
            if (!res.ok)
                throw new Error(`embedding request failed with HTTP ${res.status}`);
            const data = (await res.json());
            if (data.error?.message)
                throw new Error(`embedding error: ${data.error.message}`);
            const vectors = (data.data ?? []).map((d) => d.embedding ?? []);
            if (vectors.length !== texts.length) {
                throw new Error(`embedding count mismatch: ${vectors.length} for ${texts.length} inputs`);
            }
            return vectors.map(normalize);
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/**
 * Deterministic hash-based pseudo-embedding.
 *
 * ⚠️ This carries **no semantics**. It exists so the vector plumbing can be
 * exercised in tests and offline demos without a provider. Two texts that share
 * tokens will be closer than two that do not, but it is a lexical sketch, not a
 * semantic model. Never ship it as your embedder and expect quality gains.
 */
export class HashingEmbedder {
    id = 'hashing:debug-not-semantic';
    dim;
    constructor(dim = 64) {
        this.dim = dim;
    }
    async embed(texts) {
        return texts.map((text) => {
            const vec = new Array(this.dim).fill(0);
            for (const token of text.toLowerCase().match(/[a-z0-9_]+|[\u3400-\u9FFF]/g) ?? []) {
                let h = 0x811c9dc5;
                for (let i = 0; i < token.length; i++) {
                    h ^= token.charCodeAt(i);
                    h = Math.imul(h, 0x01000193) >>> 0;
                }
                vec[h % this.dim] += 1;
            }
            return normalize(vec);
        });
    }
}
//# sourceMappingURL=embedder.js.map