# mnemo

**让 AI 会忘、会想起来、也会惦记事——顺带把上下文成本降一个数量级。**

零运行时依赖 · TypeScript · Node 20+ · 库 + MCP 服务 + 插件

[![CI](https://github.com/jincheng3870682453-hash/mnemo/actions/workflows/ci.yml/badge.svg)](https://github.com/jincheng3870682453-hash/mnemo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

---

## 30 秒看懂

记忆库最常见的做法是"把历史/检索结果塞进上下文"。mnemo 反过来：**上下文里只放指针**，读不读、读多深，由调用方按当下的需要决定。

| | 朴素做法 | mnemo |
|---|---|---|
| 一轮里放的记忆 | 全文，几十 K token | 8 行指针，**~188 token**（82% 可缓存） |
| 想知道"我记不记得" | 先检索再说 | **一行探针**，比检索省 **43%** |
| 同一件事被重复写入 | 记录不断堆积 | 合并/推翻，**记录数 −75%** |
| 旧认知 | 和新的混在一起 | 标失效，`asOf` 仍可回溯 |

三个数字都可用 `npm run bench` 复现（语料是合成的，见下）。

```bash
npm install mnemo-memory
```

---

## 60 秒上手

```ts
import { Mnemo } from 'mnemo-memory';

const mem = await Mnemo.open('./.mnemo', { userPrincipal: 'user:me' });

// 记：abstract 是"三个月后还会记得的那句话"
await mem.write({
  abstract: '金呈不喜欢客套开场白',
  body: '他说过：直接说结论，带评级和优先级。',
  type: 'preference',
  salience: 9,
});

// 探：我到底记不记得？只花一行
mem.feelLine('说话风格');
// [memory·yes] 金呈不喜欢客套开场白 · 0d · facts/default/pref-direct.md — read it before asserting detail

// 找：返回指针
await mem.recallLines({ query: '说话风格' });
// - 金呈不喜欢客套开场白 · preference · 0d · 3.85 · facts/default/pref-direct.md

// 读：显式、计费、自己决定值不值
await mem.read('pref-direct', 'l2');

// 拼：可缓存的稳定前缀 + 每轮变化的尾段
const ctx = await mem.bootContext({ userMessage: '帮我看看这个设计' });
```

---

## 五种用法

| 形态 | 适合 | 开始方式 |
|---|---|---|
| **库** | 自己写 agent 循环 | `npm i mnemo-memory` |
| **MCP 服务** | ZCode / Claude Code / Cursor | `npx mnemo-memory`（见下） |
| **插件** | 想开箱即用 | 从本仓库安装 `plugin/` |
| **CLI** | 手工查看与追加 | `npx mnemo-memory --help` |
| **子路径** | 只要协议层 | `mnemo-memory/mcp` |

<details>
<summary><b>MCP 配置</b></summary>

```jsonc
{
  "mcpServers": {
    "mnemo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mnemo-memory"],
      "env": { "MNEMO_DIR": ".mnemo", "MNEMO_USER_PRINCIPAL": "user:me" }
    }
  }
}
```

六个工具：`memory_recall`（可带 `probe: true` 走探针）、`memory_read`、`memory_write`、`memory_forget`、`memory_intend`、`memory_context`。

</details>

<details>
<summary><b>插件安装</b></summary>

```
plugin/
  .zcode-plugin/plugin.json      # 也可用 .claude-plugin/
  .mcp.json
  payload/
    skills/mnemo-memory/SKILL.md # 教模型什么时候写、读多深
    commands/memory-status.md    # /memory-status
    dist/                        # 已编译，装即可用
```

`payload/dist` 提交进仓库，所以从仓库直接装就能跑；`npm run verify:plugin` 会在 CI 里校验它和源码一致。

</details>

---

## 它凭什么"既省又像人"

这两件事是一回事。数据库追求"记得全、记得准、随时调得出"；人脑追求"记得住要点、忘得掉细节、靠线索想起来、用来预测下一步"——后者天然更省。

| 机制 | 像人的哪一面 | 省在哪 | 细节 |
|---|---|---|---|
| **要点/原文双轨** | 只记得住大意，原话几天就没 | 上下文只放要点 | [ARCHITECTURE §2](ARCHITECTURE.md) |
| **幂律遗忘** | 三档：想得起 / 话到嘴边 / 想不起来 | 候选集自然收窄 | [§3](ARCHITECTURE.md) |
| **情境触发召回** | 被味道、名字、情绪勾起来 | 不用每轮全量检索 | [§4](ARCHITECTURE.md) |
| **元记忆探针** | "我好像知道" | 一次探针替代一轮检索 | [§4.5](ARCHITECTURE.md) |
| **提取诱发遗忘** | 想起这个，那个一时想不起 | 近似重复项自己让路 | [§4.6](ARCHITECTURE.md) |
| **前瞻记忆** | 会惦记还没做的事 | 常驻一行，不用反复查 | [§6](ARCHITECTURE.md) |
| **归属绑定** | 分得清"你说的"和"别人说的" | 防止二手偏好污染决策 | [§8](ARCHITECTURE.md) |
| **按价值/千 token 装填** | — | 预算买最大价值 | [§7](ARCHITECTURE.md) |

再往下还有一批没做完的想法，写在 [IDEAS.md](IDEAS.md)。

---

## 配置一览

| 键 | 默认 | 说明 |
|---|---|---|
| `decay.exponent` | `0.7` | 幂律指数 `R=(1+t/S)^-d`。**未标定，请 A/B** |
| `decay.stabilityGrowth` | `1.3` | 每次取用后稳定性倍数（间隔效应） |
| `retrieve.weights` | `0.5/1.5/2/2` | 四信号权重。**起点，不是结论** |
| `retrieve.limit` | `8` | 默认返回几行指针 |
| `competition.enabled` | `true` | 提取诱发遗忘 |
| `competition.maxPenalty` | `0.4` | 最多削掉四成分数，且几天内恢复 |
| `consolidation.enabled` | `true` | 合并/推翻。**收益未获证实，可关** |
| `vector.mode` | `auto` | `off` / `auto`（5000 条以上才开）/ `on` |
| `budget.*` | 见代码 | 各层 token 预算，超了会**明确告警** |

---

## 诚实的局限

**如果只读一节，读这一节。** 每一条都来自核实过的负结果。

| 事项 | 状态 |
|---|---|
| **固化收益** | 2026 年一项 2,532 个答案单元的研究：固化质量分与下游准确率**不相关**（ρ = −0.24）。一份独立复现：加固化后准确率**下降** 1.9 个点。所以它是可关的。 |
| **元记忆校准** | 检索前的置信在 LLM 上是**弱校准**的。探针只给三档粗判 + 一个指针，从不声称确定。 |
| **提取诱发遗忘** | 抑制"反复有用"的记忆是已记录的失败模式。默认只削 40%、5 天恢复、且不碰高频或高重要度记录。 |
| **衰减参数** | 全部手调，没有一个是标定出来的。 |
| **基准数字** | 语料是合成的、和实现一起写的。**当回归检查看，别当证据。** |
| **CJK 实体抽取** | 没词典就不可靠，只抽显式标记。中文人名请用 `mem.cue()` 显式注册。 |
| **拟人度** | 建议做成 0-3 档。工具场景里"会主动挑话题、说话带不确定"是灾难。 |

---

## 开发

```bash
npm ci
npm run build          # tsc → dist/
npm test               # build + 136 个测试
npm run bench          # 固化 / 探针基准
npm run build:plugin   # 同步 plugin/payload/dist
npm run verify:plugin  # 校验 payload 未漂移（CI 也跑）
```

贡献前请读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题见 [SECURITY.md](SECURITY.md)。

---

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md) — 每个决定的理由与证据
- [IDEAS.md](IDEAS.md) — 还没实现的方向，以及为什么值得做
- [CHANGELOG.md](CHANGELOG.md) — 版本变更
- [examples/basic.ts](examples/basic.ts) — 可运行的完整tour

---

## 致谢与出处

**认知科学**：Reyna & Brainerd（模糊痕迹，1995）· Bartlett（1932）· Loftus & Palmer（1974）· Schacter（记忆七宗罪，2001）· Wixted & Ebbesen（幂律遗忘，1991）· Nelson & Narens（元记忆，1990）

**工程**：Park et al., *Generative Agents*, arXiv:2304.03442 · *HeLa-Mem*, ACL 2026 · *FADE*, IEEE 2026 · *Pro-Memory*, arXiv:2611.05731 · *Agent Memory as Recommendation*, arXiv:2610.34673

**安全**：*Is it my preference? Role Grounding Attack*, arXiv:2610.38209

**负结果**：*The Epistemics of Agent Memory*, arXiv:2609.33013

---

MIT © 2026 金呈
