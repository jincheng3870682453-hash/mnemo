import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MemoryRecord } from '../src/types.js';

/** A valid record with everything defaulted, so tests only state what they mean. */
export function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date('2026-01-01T00:00:00.000Z').toISOString();
  return {
    name: 'sample',
    abstract: 'sample abstract',
    type: 'fact',
    group: 'default',
    body: 'sample body',
    validFrom: now,
    invalidAt: null,
    weight: 1,
    salience: 5,
    stability: 1,
    accessCount: 0,
    lastAccess: null,
    suppressedAt: null,
    confidence: 0.9,
    subject: null,
    speaker: null,
    addressee: null,
    hop: 0,
    future: [],
    trigger: null,
    status: null,
    links: [],
    provenance: [],
    cues: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Create a temp directory and return it plus a disposer. */
export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-test-'));
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
