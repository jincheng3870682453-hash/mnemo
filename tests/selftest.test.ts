import test from 'node:test';
import assert from 'node:assert/strict';
import { Mnemo } from '../src/mnemo.js';
import { tempDir } from './helpers.js';

test('a healthy store retrieves every record by its own abstract', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    // Genuinely distinct claims: a shared template would be (correctly) merged by
    // consolidation and the sample count would silently drop.
    const claims = [
      '构建脚本使用 tsc 直接编译',
      '部署方式是单机 docker compose',
      '日志格式统一用 JSON',
      '备份方案是每日快照',
      '错误处理直接抛异常不吞掉',
    ];
    for (const [i, abstract] of claims.entries()) {
      await mem.write({
        name: `r${i}`,
        abstract,
        body: `${abstract} 的细节`,
        type: 'fact',
        salience: 6,
      });
    }

    const report = await mem.selfTest();
    assert.equal(report.samples, claims.length);
    assert.equal(report.hitRate, 1);
    assert.deepEqual(report.weakest, []);
    assert.ok(report.caveat.includes('easier than a real user query'));
  } finally {
    await cleanup();
  }
});

test('a record shadowed by a stronger twin is reported as weak', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, {
      userPrincipal: 'user:t',
      config: { consolidation: { enabled: false } },
    });
    await mem.write({
      name: 'quiet',
      abstract: '数据库选型用 SQLite',
      body: '弱记录',
      type: 'fact',
      salience: 2,
    });
    await mem.write({
      name: 'loud',
      abstract: '数据库选型用 SQLite 并且不上 Postgres',
      body: '强记录',
      type: 'fact',
      salience: 10,
    });

    const report = await mem.selfTest();
    assert.ok(report.hitRate < 1, 'one of them must lose to the other');
    assert.ok(report.weakest.length >= 1);
    assert.ok(report.weakest[0].after < report.weakest[0].before, 'confidence should fall');
  } finally {
    await cleanup();
  }
});

test('confidence moves toward the outcome and is persisted', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir, { userPrincipal: 'user:t' });
    await mem.write({ name: 'solo', abstract: '这是一条孤立的记录', body: 'x', type: 'fact' });
    const before = mem.get('solo')?.confidence ?? 0;

    const report = await mem.selfTest({ learningRate: 0.5 });
    assert.ok(report.updated >= 1);

    const after = mem.get('solo')?.confidence ?? 0;
    assert.ok(after > before, `confidence should rise on a hit: ${before} -> ${after}`);

    const reopened = await Mnemo.open(dir);
    assert.ok((reopened.get('solo')?.confidence ?? 0) > before, 'the change must survive a reopen');
  } finally {
    await cleanup();
  }
});

test('sampling is deterministic and bounded', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    // Consolidation off: this test is about sampling, not about merging.
    const mem = await Mnemo.open(dir, {
      userPrincipal: 'user:t',
      config: { consolidation: { enabled: false } },
    });
    for (let i = 0; i < 40; i++) {
      await mem.write({
        name: `r${String(i).padStart(2, '0')}`,
        abstract: `独立记录 ${i}`,
        body: 'x',
        type: 'fact',
      });
    }
    assert.equal(mem.all().length, 40);

    const first = await mem.selfTest({ samples: 5 });
    const second = await mem.selfTest({ samples: 5 });
    assert.equal(first.samples, 5);
    assert.deepEqual(
      first.weakest.map((w) => w.name),
      second.weakest.map((w) => w.name),
      'the same store must produce the same sample',
    );
  } finally {
    await cleanup();
  }
});

test('an empty store reports zero samples rather than dividing by zero', async () => {
  const { dir, cleanup } = await tempDir();
  try {
    const mem = await Mnemo.open(dir);
    const report = await mem.selfTest();
    assert.equal(report.samples, 0);
    assert.equal(report.hitRate, 0);
  } finally {
    await cleanup();
  }
});
