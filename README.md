# mnemo

**让 AI 的记忆又省又像人。零运行时依赖的 TypeScript 长期记忆层，附带 MCP 服务与插件。**

`113 tests` · `TypeScript` · `0 runtime deps` · `Node 20+` · [English](#english)

---

## 它解决两个问题

**问题一：上下文越来越贵。**
大多数 agent 每轮把历史全塞进去，token 线性增长。mnemo 反过来：**上下文里只放指针，不放内容**。

**问题二：记忆不像人。**
向量库里存着一堆完美的事实，永远不忘、永远精确、永远不会主动想起什么。那不是人的记忆，是档案柜。
mnemo 记的是：**记住要点、让细节褪色、被情境唤起、并且惦记着还没做的事。**

省 token 和像人，其实是同一件事的两面。

| 维度 | 数据库 | mnemo |
|---|---|---|
| 编码 | 存原文 | 存 **gist**（要点）+ 原文分轨 |
| 保持 | 永久 | **幂律衰减**（不是指数） |
| 提取 | 按 query 查 | **按情境线索触发重建** |
| 用途 | 回忆过去 | **预测你下一步要什么** |
| 上下文 | 塞内容 | 塞**指针** |

---

## 四种用法

| 入口 | 适合 | 装法 |
|---|---|---|
| **库** | 自己写 agent 循环 | `npm i mnemo-memory` |
| **MCP 服务** | 已经用 ZCode / Claude Code / Cursor | `npx mnemo-memory` 或插件 |
| **插件** | 想开箱即用 | 从本仓库安装（见下） |
| **CLI** | 手工查看与追加 | `npx mnemo-memory --help` |

### 1. 当库用

```bash
npm install mnemo-memory
```

```ts
import { Mnemo } from 'mnemo-memory';

const mem = await Mnemo.open('./.mnemo', { userPrincipal: 'user:jincheng' });

await mem.write({
  name: 'pref-direct',
  abstract: '金呈不喜欢客套开场白',       // L0：一行，只有这个进上下文
  body: '他说过：直接说结论，带评级和优先级。', // L2：需要时才读
  type: 'preference',
  salience: 9,
  future: ['生成任何回复前'],
});

const hits = await mem.recallLines({ query: '说话风格' });
// - 金呈不喜欢客套开场白 · preference · 0d · 3.85 · facts/user-tone/pref-direct.md

const detail = await mem.read('pref-direct', 'l2');
const ctx = await mem.bootContext({ userMessage: '帮我看看这个设计' });
// ctx.prefix  → 缓存断点之前，逐字节稳定
// ctx.suffix  → 每轮变化
```

实测：6 条记忆 + 完整系统提示 + 记忆索引 + 相关指针 = **188 token，82% 可缓存**。

### 2. 当 MCP 服务用

```jsonc
// .mcp.json
{
  "mcpServers": {
    "mnemo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mnemo-memory"],
      "env": {
        "MNEMO_DIR": ".mnemo",
        "MNEMO_USER_PRINCIPAL": "user:me"
      }
    }
  }
}
```

**六个工具**，刻意保持少：

| 工具 | 作用 | 成本 |
|---|---|---|
| `memory_recall` | 返回 L0 指针 | ~30 tok/条 |
| `memory_read` | L1 大纲 / L2 全文 | 1/8 ~ 全文 |
| `memory_write` | 写入（自动合并/推翻） | — |
| `memory_forget` | 标记失效，不删除 | — |
| `memory_intend` | 登记延迟意图 | — |
| `memory_context` | 装配缓存友好的 prompt | — |

环境变量：`MNEMO_DIR`、`MNEMO_AGENT_PRINCIPAL`、`MNEMO_USER_PRINCIPAL`、`MNEMO_VECTOR_MODE`、`MNEMO_LLM_BASE_URL`/`MNEMO_LLM_MODEL`（可选）、`MNEMO_EMBED_BASE_URL`/`MNEMO_EMBED_MODEL`（可选）。

### 3. 当插件用

仓库里的 `plugin/` 是完整的插件包，`.zcode-plugin/` 与 `.claude-plugin/` 两份清单都在：

```
plugin/
  .zcode-plugin/plugin.json     # 清单 + userConfig
  .claude-plugin/plugin.json
  .mcp.json                     # 指向 payload/dist/mcp/server.js
  payload/
    skills/mnemo-memory/SKILL.md   # 教模型怎么用记忆（写什么、何时读）
    commands/memory-status.md      # /memory-status
    dist/                          # 已编译，装即可用
```

payload 是提交进仓库的，所以直接从仓库安装就能跑。`npm run verify:plugin` 会重新构建并 `git diff`，CI 里也跑这一步——防止 payload 变成旧构建的残骸。

### 4. 当 CLI 用

```bash
npx mnemo-memory write  --dir ./mem --body "金呈不喜欢客套" --type preference
npx mnemo-memory recall --dir ./mem --query "说话风格"
npx mnemo-memory read   --dir ./mem --name pref-direct --l2
npx mnemo-memory intend --dir ./mem --what "提醒他交报告" --at 2026-11-18T09:00
npx mnemo-memory ctx    --dir ./mem --user "帮我看看这个设计"
npx mnemo-memory stats  --dir ./mem
```

`reconstruct` / `forget` / `cue` 只提供库 API，不在 CLI 里。凡是"命令行参数 → 变更已有文件"的形态都会让静态分析（合理地）怀疑，与其为一个个例辩护，不如让这一类问题不存在。

---

## 六件事

### 1. 渐进式披露 —— 上下文只放指针

`recall()` 返回摘要 + 路径 + 分数，一条约 30 token。读正文是另一次**显式**调用：L1 大纲约 1/8 成本，L2 全文最贵。让花钱的人决定花不花。

### 2. 前缀缓存纪律 —— 免费的钱

同一个 prompt 前缀，缓存命中价可能只有未命中的 2%。`assemble()` 因此返回**两个字符串**：

- `prefix`：系统提示 + 工具定义 + 人格 + 记忆索引。**逐字节稳定**，绝不含时间戳或 session id。
- `suffix`：意图、检索结果、任务画布、用户输入。

工具定义用 `stableToolBlock()` 序列化（key 排序 + 数组排序），避免"同一份 schema、不同字节、每次都 miss"。

### 3. 幂律衰减 —— 人不是指数忘的

```
R(t) = (1 + t / S) ^ -d
```

多数实现用 `e^(-t/S)`。人的记忆符合幂律：有研究测到 R² = 0.954（幂律）vs 0.295（指数）。差别在尾巴——指数说你忘了，幂律说你只是不太好想起来。

衰减只降权，不删除。低于阈值进 `archive/`，仍然 `--as-of` 可查。**每取用一次，稳定性 ×1.3**（间隔效应）。

### 4. 情境触发 —— 像被什么勾起来

`recall()` 不只需要 query，还接受 **cue**：实体、话题、时间、情绪、目标。

```ts
await mem.recall({
  cues: [{ kind: 'emotion', value: 'anxiety' }],  // 用户在焦虑 → 想起上次焦虑的事
  goal: '写正式文档',                              // 这条记忆对不对眼下有用
});
```

第四个信号 `goalFit` 是大多数记忆库缺的，也是唯一能让人主动想起点什么的。

### 5. 前瞻记忆 —— 人会惦记事

事实是被查的，意图是**到点自己蹦出来的**。

```ts
await mem.intend({ what: '提醒他周三交审计报告', trigger: { kind: 'time', at: '2026-11-18T09:00' } });
await mem.intend({ what: '聊到审计时问一句进展', trigger: { kind: 'event', keywords: ['审计'] } });

mem.pendingLines();
// - 提醒他周三交审计报告（还有 5 天）
```

### 6. 归属 —— 这不是拟人化，是正确性

2026 年 10 月的论文 *Is it my preference? Role Grounding Attack against Agent's Memory*（arXiv:2610.38209）发现：记忆系统记了"**谁写的**"，但没记"**这是谁的**偏好"。

攻击者发一条**内容真实、来源诚实**的帖子，引用它自己用户的对话。受害者保留里面的角色词 `user`，丢掉绑定，于是这条偏好被重新归到自己用户头上。

实测直接错误归属率：**Mem0 78.1% / A-MEM 75.7% / Hindsight 99.0%**，攻击成功率 92.37%。

mnemo 的修法：写入时绑 `subject / speaker / addressee / hop`，并且

```ts
bindAttribution({ type: 'preference', hop: 1 })
// → { type: 'hearsay', downgraded: true }
```

`decisionEligible()` 要求三条全满足：`hop === 0`、非 hearsay、偏好必须绑定主体。

---

## 记忆是一等公民的文件

```
store/
  facts/<group>/<name>.md      一条事实一个文件
  episodic/<group>/<name>.md   一件事一个文件
  persona/<name>.md            人格与风格
  intentions/<name>.md         还没做的事
  archive/<name>.md            褪色了，但还在
  index/                       纯缓存（BM25 + 向量），删了不丢任何知识
  session/<sid>/               任务画布 + 卸载的工具输出
```

**删掉 `index/` 重建，记忆零丢失。** 这条有测试守着。

---

## 会变心，而且记得自己变过

```ts
await mem.write({ abstract: '金呈喜欢详细解释', type: 'preference', validFrom: '2026-11-10' });
await mem.write({ abstract: '金呈不喜欢详细解释', type: 'preference' });
// → supersedes，旧记录填 invalidAt，新记录 links 指回去

await mem.recall({ query: '详细解释' });                       // 今天：不喜欢
await mem.recall({ query: '详细解释', asOf: new Date('2026-11-11') }); // 那天：喜欢
```

---

## 语义检索（可选，默认关）

向量是**可插拔**的，但默认关闭——有实现测到 Recall@5 从 79.0% → 86.6%，而中位延迟 5.1ms → 139.2ms（27×）。个人 agent 规模下这笔账不划算。

```ts
import { Mnemo, OpenAIEmbedder } from 'mnemo-memory';

const mem = await Mnemo.open('./.mnemo', {
  embedder: new OpenAIEmbedder({
    baseUrl: 'https://api.openai.com/v1',
    model: 'text-embedding-3-small',
    apiKeyEnv: 'OPENAI_API_KEY',
  }),
  config: { vector: { mode: 'auto', minRecords: 5000, blend: 0.4, batchSize: 64 } },
});
```

`mode`: `off` 永不加载 / `auto` 超过阈值才开 / `on` 强制。向量按 embedder id 打标，换模型即失效而不是悄悄混用。

---

## 工具输出卸载

超过阈值就写盘，上下文里只留一行：

```
[offload:d6b517] web_search · 300 行 · 4323 tok · 首行: 搜索结果 0: ...
（用 readOffload("d6b517") 取回全文，可分页）
```

一个 2026 年的生产报告实测：WideSearch token **-61.4%**，SWE-bench **-33.1%**，AA-LCR **-31.0%**——**同时成功率上升**。噪声本来就在害它。

> 厂商自报、特定集成下的长时会话结果。短对话收益接近零。别拿它做容量规划，先量自己的。

---

## 基准：固化到底有没有用

```bash
npm run bench
```

```
  metric                  off           on
  records                  80           20
  stale live               60            0
  stale top-1              20            0
  current top-1            0%         100%
  ctx tokens              388          392
  merges                    0           40
  supersedes                0           20

store 75% smaller · stale beliefs at top-1: 20 -> 0
```

语料是 20 个主题 × 4 条陈述（原始 / 重复 / 细化 / 反转）。

**但请把这段当成回归检查，不是证据。** 语料是我和固化器一起写的，它不能证明固化在你的场景里有收益。所以我把它做成了开关：

```ts
config: { consolidation: { enabled: false } }
```

这也是写这个基准的原因——文献对这块并不友好（见下）。

---

## 诚实的局限

这一节的每一行都来自核实过的负结果。**如果只读一个章节，读这个。**

| 事项 | 状态 |
|---|---|
| **固化收益** | 2026 年一项 2,532 个答案单元的研究：固化质量分与下游准确率**不相关**（ρ = **−0.24**）。一份独立复现：加固化后准确率**下降** 1.9 个点。所以它是可关的，且 `npm run bench` 只当作回归检查。 |
| **衰减参数** | 全部手调，没有一个是标定出来的。`d=0.7`、`S×1.3` 都是起点。已放进 config，请 A/B。 |
| **信号权重** | Generative Agents 论文说 1:1:1，参考实现是 0.5/3/2，互相矛盾。默认 `0.5/1.5/2/2` 同样只是起点。 |
| **基准数字** | LongMemEval / LoCoMo 上各家结果互相矛盾，跨系统比较基本无意义。只看自己的场景。 |
| **CJK 实体抽取** | 没词典就是不可靠。只抽显式标记（`@name`、`「…」`、`"…"`、`《…》`）和首字母大写的英文词。中文人名请用 `mem.cue()` 显式注册。 |
| **拟人度** | 建议做成 0-3 档。工具场景里一个"说话带不确定性、会主动挑话题"的 AI 是灾难。拟人是表达层，事实层必须硬。 |
| **一致性检测** | `contradicts()` 是启发式：去否定词后的相似度 + 否定词数量差。它能处理谓词本身含"不"的情况，但处理不了真正的同义改写（"喜欢" vs "偏好"）。 |

---

## 开发

```bash
npm ci
npm run build          # tsc → dist/
npm test               # build + 113 个测试
npm run bench          # 固化基准
npm run build:plugin   # 把 dist 收进 plugin/payload/dist
npm run verify:plugin  # 校验提交的 payload 与源码一致（CI 也跑）
```

CI 在 GitHub Actions：Node 20/22/24 + Windows、MCP 握手（真管道）、payload 新鲜度、基准回归、打包内容。

---

## API

| 方法 | 作用 |
|---|---|
| `Mnemo.open(dir, opts)` | 打开或创建记忆库 |
| `write(input)` | 写入；内部跑编码 → 归属绑定 → 合并判定 |
| `recall(query)` / `recallLines(query)` | **async**。返回 L0 指针，不走内容 |
| `read(name, 'l1' \| 'l2')` | 显式读取，返回成本 |
| `reconstruct(name, situation)` | 按情境重建，并侵蚀置信度 |
| `forget(name, reason)` | 标记失效，不删除 |
| `cue(name, cues)` | 绑定情境线索 |
| `intend({ what, trigger })` | 登记延迟意图 |
| `due(now, ctx)` / `pendingLines()` | 到点的 / 惦记着的 |
| `buildContext(input)` / `bootContext()` | 装配缓存友好的 prompt |
| `offload(sid, tool, output)` / `readOffload` | 卸载与取回 |
| `consolidate()` / `metrics()` / `vectorStatus()` | 维护与诊断 |

完整导出见 [`src/index.ts`](src/index.ts)。

---

## 参考资料

**认知科学**
Reyna & Brainerd, *Fuzzy-Trace Theory*, 1995 · Bartlett, *Remembering*, 1932 · Loftus & Palmer, 1974 · Schacter, *The Seven Sins of Memory*, 2001 · Wixted & Ebbesen, *On the form of forgetting*, 1991

**工程实现**
Park et al., *Generative Agents*, arXiv:2304.03442 · *HeLa-Mem*, ACL 2026 · *FADE*, IEEE 2026 · *MM-Mem*, arXiv:2603.01455 · *Pro-Memory*, arXiv:2611.05731

**安全**
*Is it my preference? Role Grounding Attack*, arXiv:2610.38209

**负结果**
*The Epistemics of Agent Memory*, arXiv:2609.33013

---

## License

MIT © 2026 金呈

---

<a id="english"></a>

## English

**mnemo** is a token-thrifty, human-like long-term memory layer for AI agents — a library, an MCP server, and a ready-to-install plugin. Zero runtime dependencies; plain Markdown on disk; TypeScript.

Two ideas:

1. **Do not put content in the context — put a pointer.** Recall returns ~30-token L0 handles (abstract + path + score). Reading a body is a separate, costed call. Assemble returns a byte-stable cacheable prefix plus a volatile suffix. A booted session in the example costs **188 tokens**, 82% cacheable.

2. **Do not remember like a database — remember like a person.** Fuzzy-trace encoding, power-law forgetting (`R = (1 + t/S)^-d`), cue-triggered recall on four signals, and prospective memory for things you have to remember to do.

It also fixes a real vulnerability: systems record *who wrote* a memory but not *whose preference* it expresses, so an honest third-party post can re-ground its author's preferences onto you (measured misattribution: Mem0 78.1%, A-MEM 75.7%, Hindsight 99.0%). Principals are bound at write time; second-hand preferences become hearsay and never steer behaviour.

The [limitations section](#诚实的局限) is the honest half: consolidation is behind a config flag and measured by `npm run bench` rather than assumed, decay parameters are uncalibrated, and the published benchmarks disagree with each other.

```bash
npm install mnemo-memory
npx mnemo-memory --help
```
