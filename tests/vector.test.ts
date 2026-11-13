import test from 'node:test';
import assert from 'node:assert/strict';
import { cosine, normalize, HashingEmbedder, type Embedder } from '../src/retrieval/embedder.js';
import { VectorIndex } from '../src/retrieval/vector-index.js';
import { Mnemo } from '../src/mnemo.js';
import { tempDir } from './helpers.js';
import path from 'node:path';

test('cosine is bounded, symmetric and zero for empty input', () => {
  const a = [1, 0, 0];
  const b = [0, 1, 0];
  assert.equal(cosine(a, a), 1);
  assert.equal(cosine(a, b), 0);
  assert.equal(cosine(a, b), cosine(b, a));
  assert.equal(cosine([], []), 0);
  assert.equal(cosine([1, 2], [1, 2, 3]), 0);
});

test('normalize produces unit length and tolerates the zero vector', () => {
  const n = normalize([3, 4]);
  assert.ok(Math.abs(n[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(n[1] - 0.8) < 1e-9);
  assert.deepEqual(normalize([0, 0]), [0, 0]);
});

test('hashing embedder is deterministic and token-sensitive', async () => {
  const e = new HashingEmbedder(32);
  const [a1] = await e.embed(['上下文记忆']);
  const [a2] = await e.embed(['上下文记忆']);
  const [b] = await e.embed(['完全无关的内容']);
  assert.deepEqual(a1, a2);
  assert.ok(cosine(a1, a1) > cosine(a1, b));
});

test('vector index ranks by similarity and removes cleanly', () => {
  const index = new VectorIndex();
  index.add('near', [1, 0, 0], 'test');
  index.add('also-near', [1, 0.2, 0], 'test');
  index.add('orthogonal', [0, 1, 0], 'test');
  assert.equal(index.size, 3);

  const hits = index.search([1, 0, 0], 10);
  assert.equal(hits[0].id, 'near');
  assert.equal(hits[0].norm, 1);
  assert.deepEqual(hits.map((h) => h.id), ['near', 'also-near'], 'orthogonal vectors score 0 and are dropped');

  index.remove('near');
  assert.equal(index.search([1, 0, 0], 10)[0].id, 'also-near');
});

test('mixing embedders is refused rather than silently blended', () => {
  const index = new VectorIndex();
  index.add('a', [1, 0], 'model-a');
  assert.throws(() => index.add('b', [1, 0], 'model-b'), /refusing to mix/);
});

test('persistence round-trips and discards vectors from another model', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const file = path.join(dir, 'vectors.jsonl');
    const index = new VectorIndex();
    index.add('a', [1, 0, 0], 'model-a');
    index.add('b', [0, 1, 0], 'model-a');
    await index.save(file, 'model-a');

    const reloaded = await VectorIndex.load(file, 'model-a');
    assert.equal(reloaded.size, 2);
    assert.equal(reloaded.producer, 'model-a');

    const otherModel = await VectorIndex.load(file, 'model-b');
    assert.equal(otherModel.size, 0, 'vectors from a different model must be dropped');
  } finally {
    await cleanup();
  }
});

/** Embeds by lookup, so synonyms can be given identical vectors deliberately. */
class SynonymEmbedder implements Embedder {
  readonly id = 'stub:synonyms';
  private readonly table: Record<string, number[]> = {
    冰箱: [1, 0, 0],
    雪柜: [1, 0, 0],
    空调: [0, 1, 0],
  };

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      for (const [key, vec] of Object.entries(this.table)) {
        if (text.includes(key)) return normalize(vec);
      }
      return normalize([0, 0, 1]);
    });
  }
}

test('semantic retrieval finds a record with no lexical overlap', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, {
      embedder: new SynonymEmbedder(),
      config: { vector: { mode: 'on', minRecords: 5000, blend: 1, batchSize: 8 } },
    });

    await mem.write({ name: 'fridge', abstract: '冰箱坏了要修', body: '压缩机不制冷', type: 'fact' });

    // "雪柜" shares no character with the record, so BM25 alone cannot find it.
    const lexicalOnly = await Mnemo.open(dir);
    assert.equal((await lexicalOnly.recall({ query: '雪柜' })).length, 0);

    const semantic = await mem.recall({ query: '雪柜' });
    assert.equal(semantic.length, 1);
    assert.equal(semantic[0].record.name, 'fridge');
    assert.ok(semantic[0].signals.relevance > 0);
  } finally {
    await cleanup();
  }
});

test('vector mode off keeps retrieval purely lexical even with an embedder', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, {
      embedder: new SynonymEmbedder(),
      config: { vector: { mode: 'off', minRecords: 1, blend: 1, batchSize: 8 } },
    });
    await mem.write({ name: 'fridge', abstract: '冰箱坏了要修', body: '压缩机不制冷', type: 'fact' });

    assert.equal(mem.vectorStatus().enabled, false);
    assert.equal((await mem.recall({ query: '雪柜' })).length, 0);
  } finally {
    await cleanup();
  }
});

test('auto mode stays off below the record threshold', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, {
      embedder: new HashingEmbedder(16),
      config: { vector: { mode: 'auto', minRecords: 5000, blend: 0.4, batchSize: 8 } },
    });
    await mem.write({ name: 'a', abstract: '一条记忆', body: '内容', type: 'fact' });
    assert.equal(mem.vectorStatus().enabled, false);
  } finally {
    await cleanup();
  }
});

test('warmVectors embeds missing records and persists them', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const options = {
      embedder: new HashingEmbedder(16),
      config: { vector: { mode: 'on' as const, minRecords: 1, blend: 0.4, batchSize: 8 } },
    };
    const first = await Mnemo.open(dir, options);
    await first.write({ name: 'a', abstract: '一条记忆', body: '内容', type: 'fact' });
    assert.equal(first.vectorStatus().indexed, 1);

    // Reopening loads the cache instead of re-embedding.
    const second = await Mnemo.open(dir, options);
    assert.equal(second.vectorStatus().indexed, 1);
    assert.equal(await second.warmVectors(), 0, 'nothing should need embedding again');
  } finally {
    await cleanup();
  }
});
