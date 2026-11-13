/**
 * Adaptive tuning tests.
 *
 * The bandit is deliberately small and deterministic, so the tests assert
 * behaviour rather than exact scores: warm-up forces the baseline arm, rewards
 * move the policy, state survives a restart, and the live config is never
 * mutated by an arm override.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Mnemo } from '../src/index.js';
import {
  AdaptiveTuner,
  ARMS,
  FEATURE_DIM,
  mergeOverrides,
  normaliseFeatures,
} from '../src/adaptive/tuner.js';
import { DEFAULT_CONFIG } from '../src/types.js';

test('warm-up forces the default arm until enough observations exist', () => {
  const tuner = new AdaptiveTuner(1.0, 3, undefined);
  const x = [1, 0.5, 0.5, 0.5, 0.2, 0, 0, 0.5];
  for (let i = 0; i < 3; i++) {
    assert.equal(tuner.select(x).arm, 0);
    tuner.update(0, x, 0.8);
  }
  // After warm-up the policy is free to choose; arm 0 must still be reachable.
  const choice = tuner.select(x);
  assert.ok(choice.arm >= 0 && choice.arm < ARMS.length);
});

test('rewards are attributed to the chosen arm', () => {
  const tuner = new AdaptiveTuner(0.5, 0, undefined);
  const x = normaliseFeatures([1, 0.3, 0.4, 0.5, 0.1, 1, 0, 0.5]);
  assert.equal(x.length, FEATURE_DIM);
  tuner.update(2, x, 0.9);
  tuner.update(2, x, 0.7);
  const stats = tuner.stats();
  assert.equal(stats[2].pulls, 2);
  assert.ok(Math.abs(stats[2].meanReward - 0.8) < 1e-9);
  assert.equal(stats[0].pulls, 0);
});

test('state round-trips through JSON', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-tuner-'));
  const file = path.join(dir, 'adaptive.json');
  try {
    const tuner = new AdaptiveTuner(1.0, 0, undefined);
    const x = normaliseFeatures([1, 0.2, 0.3, 0.4, 0.1, 0, 0, 0.5]);
    tuner.update(1, x, 0.6);
    await tuner.save(file);

    const loaded = await AdaptiveTuner.load(file, 1.0, 0);
    assert.equal(loaded.observations, 1);
    assert.equal(loaded.stats()[1].pulls, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('mergeOverrides does not mutate the base config', () => {
  const before = JSON.stringify(DEFAULT_CONFIG);
  const merged = mergeOverrides(DEFAULT_CONFIG, {
    decay: { exponent: 0.33 },
    retrieve: { weights: { relevance: 9 } },
  });
  assert.equal(JSON.stringify(DEFAULT_CONFIG), before);
  assert.equal(merged.decay.exponent, 0.33);
  assert.equal(merged.retrieve.weights.relevance, 9);
  // Untouched knobs keep their values.
  assert.equal(merged.decay.stabilityGrowth, DEFAULT_CONFIG.decay.stabilityGrowth);
  assert.equal(merged.retrieve.weights.recency, DEFAULT_CONFIG.retrieve.weights.recency);
});

test('adaptive mode is off by default and does not persist state', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-adaptive-'));
  try {
    const mem = await Mnemo.open(path.join(dir, 'store'), { userPrincipal: 'user:test' });
    assert.equal(mem.adaptiveEnabled(), false);
    assert.equal(mem.adaptiveStats().enabled, false);
    await mem.write({ name: 'a', body: '用户喜欢空格缩进', abstract: '用户喜欢空格缩进', type: 'preference' });
    const hits = await mem.recall({ query: '缩进' });
    assert.ok(hits.length > 0);
    mem.endTurn();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('adaptive mode selects arms, learns from read() and persists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-adaptive-'));
  try {
    const store = path.join(dir, 'store');
    const mem = await Mnemo.open(store, {
      userPrincipal: 'user:test',
      adaptive: { enabled: true, warmup: 0 },
    });
    assert.equal(mem.adaptiveEnabled(), true);

    await mem.write({ name: 'style', body: '用户偏好直接给结论', abstract: '用户偏好直接给结论', type: 'preference', salience: 8 });
    await mem.write({ name: 'tool', body: '用户用 VSCode', abstract: '用户用 VSCode', type: 'fact' });

    const hits = await mem.recall({ query: '结论' });
    assert.ok(hits.length > 0);
    // read() of a returned pointer should produce a positive reward internally.
    await mem.read(hits[0].record.name);

    const stats = mem.adaptiveStats();
    assert.equal(stats.enabled, true);
    assert.ok(stats.observations >= 1);
    const pulls = stats.arms.reduce((sum, arm) => sum + arm.pulls, 0);
    assert.ok(pulls >= 1);

    // Policy survives a restart.
    await mem.feedback(0.5); // no-op when the turn was already adjudicated
    await new Promise((resolve) => setTimeout(resolve, 30));
    const reopened = await Mnemo.open(store, {
      userPrincipal: 'user:test',
      adaptive: { enabled: true, warmup: 0 },
    });
    assert.ok(reopened.adaptiveStats().observations >= stats.observations);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('endTurn adjudicates an unused recall as a weak negative', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-adaptive-'));
  try {
    const mem = await Mnemo.open(path.join(dir, 'store'), {
      userPrincipal: 'user:test',
      adaptive: { enabled: true, warmup: 0 },
    });
    await mem.write({ name: 'x', body: '用户喜欢猫', abstract: '用户喜欢猫', type: 'preference' });
    const before = mem.adaptiveStats().observations;
    await mem.recall({ query: '猫' });
    mem.endTurn();
    assert.ok(mem.adaptiveStats().observations >= before + 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
