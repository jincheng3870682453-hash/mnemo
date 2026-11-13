<div align="center">

<img alt="STATUS" src="https://img.shields.io/badge/STATUS-BETA-ff9f1c?style=for-the-badge&labelColor=1a1a2e">
<img alt="RUNTIME DEPS" src="https://img.shields.io/badge/RUNTIME%20DEPS-ZERO-2ecc71?style=for-the-badge&labelColor=1a1a2e">
<img alt="TESTS" src="https://img.shields.io/badge/TESTS-156%20PASSING-2ecc71?style=for-the-badge&labelColor=1a1a2e">
<img alt="LICENSE" src="https://img.shields.io/badge/LICENSE-MIT-4b67b4?style=for-the-badge&labelColor=1a1a2e">

<img alt="NODE" src="https://img.shields.io/badge/NODE-%E2%89%A520-339933?style=for-the-badge&logo=nodedotjs&logoColor=white&labelColor=1a1a2e">
<img alt="VERSION" src="https://img.shields.io/badge/VERSION-0.6.0-22d3ee?style=for-the-badge&labelColor=1a1a2e">
<a href="https://github.com/jincheng3870682453-hash/mnemo/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jincheng3870682453-hash/mnemo/actions/workflows/ci.yml/badge.svg"></a>

<pre>
███╗   ███╗███╗   ██╗███████╗███╗   ███╗ ██████╗
████╗ ████║████╗  ██║██╔════╝████╗ ████║██╔═══██╗
██╔████╔██║██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║
██║╚██╔╝██║██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║
██║ ╚═╝ ██║██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝
╚═╝     ╚═╝╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝
</pre>

# 🧠 mnemo

**会忘、会想起来、也会惦记事的长期记忆**
*Long-term memory that forgets, recalls and remembers to follow up*

[快速开始](#-快速开始) · [机制](#-机制) · [基准](#-基准) · [配置](#-配置) · [局限](#-局限) · [English](#-english)

</div>

---

## 📌 一句话

记忆库通常把内容塞进上下文。mnemo 反过来：**上下文里只放指针**，读不读、读多深，由调用方按当下需要决定。

| 场景 | 朴素做法 | mnemo |
|:--|:--|:--|
| 一轮里放多少记忆 | 全文，几十 K token | 8 行指针，**~188 token** |
| 想知道"我记不记得" | 先检索再说 | **一行探针**，比检索省 **43%** |
| 同一件事重复写入 | 记录不断堆积 | 合并/推翻，**记录数 −75%** |
| 旧认知 | 和新的一起混着 | 标失效，`asOf` 仍可回溯 |

> 三个数字都由 `npm run bench` 复现（合成语料，见[基准](#-基准)）。

---

## 🚀 快速开始

```bash
npm install mnemo-memory
```

```ts
import { Mnemo } from 'mnemo-memory';

const mem = await Mnemo.open('./.mnemo', { userPrincipal: 'user:me' });

// 记：abstract 是"三个月后还记得的那句话"
await mem.write({
  abstract: '金呈不喜欢客套开场白',
  body: '他说过：直接说结论，带评级和优先级。',
  type: 'preference',
  salience: 9,
});

// 探：我到底记不记得？只花一行
mem.feelLine('客套 开场白');

// 找：返回指针
await mem.recallLines({ query: '客套' });

// 读：显式、计费
await mem.read('pref-direct', 'l2');

// 拼：可缓存前缀 + 每轮变化的尾段
const ctx = await mem.bootContext({ userMessage: '帮我看看这个设计' });

// 情节：把一段对话压成一条，标题就是概括
await mem.checkpoint({ summary: '讨论记忆分区与 JSON 方案', sessionId: 's-1', facts: ['pref-direct'] });
mem.episodeLines();   // 一行一条，列出来就是索引
```

---

## 📦 四种形态

| 形态 | 适合 | 入口 |
|:--|:--|:--|
| **库** | 自己写 agent 循环 | `npm i mnemo-memory` |
| **MCP 服务** | ZCode / Claude Code / Cursor | `npx mnemo-memory` |
| **DSH Go 插件** | 手机上的 DeepSeek Harness | `dsh plugin --profile web add ./dsh-go` |
| **CLI** | 手工查看与追加 | `npx mnemo-memory --help` |

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

六个工具：`memory_recall`（`probe: true` 走探针）、`memory_read`、`memory_write`、`memory_forget`、`memory_intend`、`memory_context`。

</details>

<details>
<summary><b>DSH Go 插件</b></summary>

App **只画 JSON，不执行插件代码**。三个界面，都只放指针：

| 界面 | 内容 |
|:--|:--|
| 状态条 | `记忆 12 · 惦记 2`（11 字） |
| 胶囊 ×2 | **记住这句** / **想起来**（探针→检索→插回输入框，不自动发送） |
| 面板 | 最近记录 / 可作依据数 / 一键自检 |

数据在 `$DSH_HOME/dsh-go/memory/`，仍是 Markdown；插件不联网、不调模型。

</details>

---

## ⚙️ 机制

省 token 和像人是一件事：人脑也是靠"只存要点 / 让细节褪色 / 用情境当键"来省预算的。

| 机制 | 人的对应 | 省在哪 |
|:--|:--|:--|
| 要点/原文双轨 | 只记得住大意 | 上下文只放要点 |
| 幂律遗忘 `R=(1+t/S)^-d` | 想得起 / 话到嘴边 / 想不起 | 候选集自然收窄 |
| 情境触发召回 | 被味道、名字、情绪勾起 | 不用每轮全量检索 |
| 元记忆探针 | "我好像知道" | 一行替代一轮检索 |
| 提取诱发遗忘 | 想起这个，那个一时想不起 | 近似重复项自己让路 |
| 前瞻记忆 | 惦记还没做的事 | 常驻一行 |
| 情节记忆 | 说得出"上次那次" | 列标题即索引，不用读正文 |
| 归属绑定 | 分得清谁说的 | 防二手偏好污染决策 |
| 合并前快照 | 改了主意还记得原来怎么想 | 固化错了能回滚 |
| 诱饵自检 | "我确定我记得"要经得起检验 | 本地计算，零模型调用 |
| 价值/千 token 装填 | — | 预算买最大价值 |

<details>
<summary><b>设计细节与证据</b></summary>

每个机制为什么这样做、失败模式是什么，都在 [ARCHITECTURE.md](ARCHITECTURE.md)。
还没实现的方向在 [IDEAS.md](IDEAS.md)。

</details>

---

## 📊 基准

```bash
npm run bench
```

| metric | off | on |
|:--|--:|--:|
| records | 80 | **20** |
| stale live | 60 | **0** |
| stale top-1 | 20 | **0** |
| current top-1 | 0% | **100%** |
| ctx tokens | 388 | 392 |

```
feeling-of-knowing probe over 20 queries
  probe 1181 tok · recall 2087 tok · 43% cheaper
```

> 语料是 20 个主题 × 4 条陈述，**和实现一起写的**。当回归检查看，别当证据。

---

## 🔧 配置

| 键 | 默认 | 说明 |
|:--|:--|:--|
| `decay.exponent` | `0.7` | 幂律指数，未标定，请 A/B |
| `decay.stabilityGrowth` | `1.3` | 每次取用后稳定性倍数 |
| `retrieve.weights` | `0.5/1.5/2/2` | 四信号权重，起点不是结论 |
| `competition.enabled` | `true` | 提取诱发遗忘 |
| `consolidation.enabled` | `true` | 合并/推翻，收益未证实，可关 |
| `vector.mode` | `auto` | `off` / `auto`(≥5000 条) / `on` |
| `budget.*` | 见代码 | 各层 token 预算，超了明确告警 |

---

## ⚠️ 局限

| 事项 | 状态 |
|:--|:--|
| 固化收益 | 质量分与下游准确率**不相关**（ρ = −0.24）。可关，也可回滚 |
| 探针校准 | 检索前置信在 LLM 上**弱校准**，只给三档粗判 |
| 自检 hitRate | 自检索比真实查询容易，是相对健康信号，不是召回率 |
| 衰减参数 | 全部手调，没有一个是标定出来的 |
| 基准 | 合成语料，跨系统比较无意义 |

---

## 🛠 开发

```bash
npm ci
npm run build          # tsc → dist/
npm test               # 148 个测试
npm run bench          # 固化 / 探针基准
npm run build:plugin   # 同步 plugin/ 与 dsh-go/ 产物
npm run check:dsh-go   # DSH Go 清单 lint + handler 冒烟
```

贡献前读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题走 [SECURITY.md](SECURITY.md)。

---

## 📚 文档

| 文件 | 内容 |
|:--|:--|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 每个决定的理由与证据 |
| [IDEAS.md](IDEAS.md) | 未实现方向 + 失败模式 + 价值/风险 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更 |
| [examples/basic.ts](examples/basic.ts) | 可运行的完整 tour |

---

## 🙏 出处

**认知科学**：Reyna & Brainerd 1995 · Bartlett 1932 · Loftus & Palmer 1974 · Schacter 2001 · Wixted & Ebbesen 1991 · Nelson & Narens 1990

**工程**：Park et al. arXiv:2304.03442 · HeLa-Mem ACL 2026 · FADE IEEE 2026 · Pro-Memory arXiv:2611.05731

**安全**：Role Grounding Attack arXiv:2610.38209　**负结果**：The Epistemics of Agent Memory arXiv:2609.33013

---

<div align="center">

## 🌐 English

**mnemo** is a token-thrifty, human-like long-term memory layer for AI agents. Zero runtime dependencies; plain Markdown on disk; TypeScript.

**Do not put content in the context — put a pointer.** Recall returns ~30-token L0 handles; reading a body is a separate, costed call. A booted session costs **188 tokens**, 82% cacheable.

**Do not remember like a database — remember like a person.** Fuzzy-trace encoding, power-law forgetting, cue-triggered recall, prospective memory for pending intentions.

It also fixes a real vulnerability: systems record *who wrote* a memory but not *whose preference* it expresses, so an honest third-party post can re-ground its author's preferences onto you (measured misattribution: Mem0 78.1%, A-MEM 75.7%, Hindsight 99.0%).

Ships a library, an MCP server, a DSH Go native plugin, and a CLI.

```bash
npm install mnemo-memory
```

MIT © 2026 金呈

</div>
