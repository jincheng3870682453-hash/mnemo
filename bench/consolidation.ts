/**
 * Consolidation benchmark.
 *
 *   npm run bench [topics]
 *
 * What this measures
 * ------------------
 * Whether letting a new claim merge into / supersede an existing one actually
 * helps retrieval, on a corpus where the right answer is unambiguous.
 *
 * Per topic the corpus writes four claims, in this order:
 *
 *   base       金呈喜欢 X           (first belief)
 *   duplicate  金呈喜欢 X           (the person repeats themselves)
 *   refinement 金呈喜欢 X，而且 Y     (same topic, more specific)
 *   current    金呈不喜欢 X          (they changed their mind)
 *
 * Metrics (lower is better except accuracy):
 *
 *   records     store size after identical writes
 *   staleLive   live records still asserting the abandoned belief
 *   staleTop1   queries whose top hit is the abandoned belief
 *   accuracy    top-1 is the current belief
 *   ctxTokens   resident context after all writes
 *
 * Honesty notes, and they matter
 * ------------------------------
 * • The corpus is synthetic and designed by the same person who wrote the
 *   consolidator. It cannot show that consolidation helps in your domain; it is
 *   a reproducible regression check, nothing more.
 * • It exists because the literature is unkind to this feature: consolidation
 *   quality has been measured as uncorrelated with downstream accuracy
 *   (rho = -0.24), and one replication found a nightly cycle made results worse.
 *   That is why consolidation is behind a config flag, off-switchable, and
 *   measured here rather than assumed.
 * • No model is used: the deterministic path runs, so results are reproducible.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Mnemo } from '../src/index.js';

/** Each entry is a distinct subject, so topics do not collapse into each other. */
const SUBJECTS: Array<[key: string, predicate: string]> = [
  ['回复风格', '先给结论再展开'],
  ['编辑器', '用 VSCode 的 vim 键位'],
  ['构建工具', '用 tsc 直接编译不打 bundle'],
  ['部署方式', '单机 docker compose 部署'],
  ['数据库选型', '继续用 SQLite 不上 Postgres'],
  ['日志格式', '结构化 JSON 日志'],
  ['错误处理', '直接抛异常不吞掉'],
  ['测试策略', '先写集成测试再补单测'],
  ['命名习惯', '变量名写全不缩写'],
  ['代码审查', '只看行为变更不看格式'],
  ['会议节奏', '每周一次十五分钟站会'],
  ['文档结构', '先说结论再写细节'],
  ['依赖管理', '保持零运行时依赖'],
  ['性能取舍', '先测再优化不提前设计'],
  ['安全基线', '默认拒绝白名单放行'],
  ['版本策略', '语义化版本但允许破坏性改动'],
  ['分支模型', '直接在主干开发不拉分支'],
  ['发布流程', '打 tag 自动发 npm'],
  ['监控告警', '只报错不报自定义指标'],
  ['备份方案', '每日快照保留三十天'],
];

interface Topic {
  key: string;
  base: string;
  duplicate: string;
  refinement: string;
  current: string;
}

function topicAt(index: number): Topic {
  const [key, predicate] = SUBJECTS[index % SUBJECTS.length];
  const suffix = index >= SUBJECTS.length ? `-${Math.floor(index / SUBJECTS.length)}` : '';
  const name = key + suffix;
  return {
    key: name,
    base: `${name}：金呈喜欢${predicate}`,
    duplicate: `${name}：金呈喜欢${predicate}`,
    refinement: `${name}：金呈喜欢${predicate}，这一点他很坚持`,
    current: `${name}：金呈不喜欢${predicate}`,
  };
}

/** True when `abstract` asserts the abandoned belief about `topic`. */
function isStale(abstract: string, topic: Topic): boolean {
  return abstract.startsWith(topic.key) && abstract.includes('喜欢') && !abstract.includes('不喜欢');
}

/** True when `abstract` asserts the current belief about `topic`. */
function isCurrent(abstract: string, topic: Topic): boolean {
  return abstract.startsWith(topic.key) && abstract.includes('不喜欢');
}

interface RunResult {
  label: string;
  records: number;
  staleLive: number;
  staleTop1: number;
  accuracy: number;
  contextTokens: number;
  merges: number;
  supersedes: number;
}

async function run(label: string, enabled: boolean, topicCount: number): Promise<RunResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mnemo-bench-'));
  try {
    const mem = await Mnemo.open(path.join(dir, 'store'), {
      userPrincipal: 'user:bench',
      config: { consolidation: { enabled } },
    });

    let merges = 0;
    let supersedes = 0;

    for (let i = 0; i < topicCount; i++) {
      const t = topicAt(i);
      const claims: Array<[string, string]> = [
        [`${t.key}-base`, t.base],
        [`${t.key}-dup`, t.duplicate],
        [`${t.key}-refined`, t.refinement],
        [`${t.key}-current`, t.current],
      ];
      for (const [name, abstract] of claims) {
        const result = await mem.write({
          name,
          abstract,
          body: `${abstract}（bench）`,
          type: 'preference',
          subject: 'user:bench',
          salience: 6,
        });
        if (result.relation === 'duplicate' || result.relation === 'refines') merges++;
        if (result.relation === 'supersedes') supersedes++;
      }
    }

    const live = mem.all();
    let staleLive = 0;
    for (let i = 0; i < topicCount; i++) {
      const t = topicAt(i);
      staleLive += live.filter((r) => isStale(r.abstract, t)).length;
    }

    let staleTop1 = 0;
    let correct = 0;
    for (let i = 0; i < topicCount; i++) {
      const t = topicAt(i);
      const hits = await mem.recall({ query: t.key, limit: 5 });
      const top = hits[0]?.record.abstract ?? '';
      if (isCurrent(top, t)) correct++;
      if (isStale(top, t)) staleTop1++;
    }

    const ctx = await mem.bootContext({ userMessage: '继续' });

    return {
      label,
      records: mem.metrics().total,
      staleLive,
      staleTop1,
      accuracy: correct / topicCount,
      contextTokens: ctx.tokens.total,
      merges,
      supersedes,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;

function row(label: string, off: string, on: string): string {
  return `  ${label.padEnd(14)} ${off.padStart(12)} ${on.padStart(12)}\n`;
}

async function main(): Promise<void> {
  const topicCount = Math.max(1, Math.min(SUBJECTS.length, Number.parseInt(process.argv[2] ?? '20', 10) || 20));

  process.stdout.write('\nmnemo consolidation benchmark\n');
  process.stdout.write(`corpus: ${topicCount} topics x 4 claims = ${topicCount * 4} writes\n`);
  process.stdout.write('model: none (deterministic consolidation path)\n\n');

  const off = await run('off', false, topicCount);
  const on = await run('on', true, topicCount);

  process.stdout.write(row('metric', 'off', 'on'));
  process.stdout.write(row('records', String(off.records), String(on.records)));
  process.stdout.write(row('stale live', String(off.staleLive), String(on.staleLive)));
  process.stdout.write(row('stale top-1', String(off.staleTop1), String(on.staleTop1)));
  process.stdout.write(row('current top-1', pct(off.accuracy), pct(on.accuracy)));
  process.stdout.write(row('ctx tokens', String(off.contextTokens), String(on.contextTokens)));
  process.stdout.write(row('merges', String(off.merges), String(on.merges)));
  process.stdout.write(row('supersedes', String(off.supersedes), String(on.supersedes)));

  const reduction = off.records === 0 ? 0 : (off.records - on.records) / off.records;
  process.stdout.write(
    `\nstore ${pct(reduction)} smaller · stale beliefs at top-1: ${off.staleTop1} -> ${on.staleTop1}\n`,
  );
  process.stdout.write(
    '\nCaveat: synthetic corpus authored alongside the consolidator. This is a\n' +
      'regression check, not evidence that consolidation helps your workload.\n\n',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
