# mnemo

**让 AI 的记忆又省又像人。零运行时依赖的 TypeScript 长期记忆层。**

[English](#english) · [设计说明](ARCHITECTURE.md) · [示例](examples/basic.ts)

```
87 tests passing · TypeScript · 0 runtime dependencies · Node 20+
```

---

## 它解决两个问题

**问题一：上下文越来越贵。**

大多数 agent 每轮把历史全塞进去，token 线性增长。mnemo 的做法是反过来的：**上下文里只放指针，不放内容**。

**问题二：记忆不像人。**

向量库里存着一堆完美的事实，永远不忘、永远精确、永远不会主动想起什么。那不是人的记忆，那是档案柜。

mnemo 记的是：**记住要点、让细节褪色、被情境唤起、并且惦记着还没做的事。**

---

## 核心思路

省 token 和像人，其实是同一件事的两面。

数据库追求"记得全、记得准、随时调得出"。人脑追求的是**记得住要点、忘得掉细节、靠线索想起来、用来预测下一步**。后者天然更省。

| 维度 | 数据库 | mnemo |
|---|---|---|
| 编码 | 存原文 | 存 **gist**（要点）+ 原文分轨 |
| 保持 | 永久 | **幂律衰减**（不是指数） |
| 提取 | 按 query 查 | **按情境线索触发重建** |
| 用途 | 回忆过去 | **预测你下一步要什么** |
| 上下文 | 塞内容 | 塞**指针** |

---

## 快速开始

```bash
npm install
npm run build
node dist/examples/basic.js
```

```ts
import { Mnemo } from 'mnemo';

const mem = await Mnemo.open('./.mnemo', { userPrincipal: 'user:jincheng' });

// 记
await mem.write({
  name: 'pref-direct',
  abstract: '金呈不喜欢客套开场白',      // L0：一行，永远只有这个进上下文
  body: '他说过：直接说结论，带评级和优先级。', // L2：需要时才读
  type: 'preference',
  salience: 9,
  future: ['生成任何回复前'],           // 前瞻钩子
});

// 找（返回指针，不返回正文）
const hits = mem.recallLines({ query: '说话风格' });
// - 金呈不喜欢客套开场白 · preference · 0d · 3.85 · facts/user-tone/pref-direct.md

// 读（显式、昂贵、自己决定值不值）
const detail = await mem.read('pref-direct', 'l2');

// 拼上下文（拿回一个可缓存的稳定前缀）
const ctx = mem.bootContext({ userMessage: '帮我看看这个设计' });
// ctx.prefix  → 放缓存断点之前，逐字节稳定
// ctx.suffix  → 每轮变化
```

实测：**6 条记忆、完整系统提示、记忆索引、相关指针，总共 188 token**，其中 82% 可缓存。

---

## 六件事

### 1. 渐进式披露 —— 上下文只放指针

`recall()` 返回摘要 + 路径 + 分数，一条约 30 token。读正文是另一次**显式**调用，L1 大纲约 1/8 成本，L2 全文最贵。让花钱的人决定花不花。

### 2. 前缀缓存纪律 —— 免费的钱

同一个 prompt 前缀，缓存命中价可能只有未命中的 2%。所以 `assemble()` 返回**两个字符串**：

- `prefix`：系统提示 + 工具定义 + 人格 + 记忆索引。**逐字节稳定**，绝不包含时间戳、session id。
- `suffix`：意图、检索结果、任务画布、用户输入。

工具定义用 `stableToolBlock()` 序列化（key 排序 + 数组排序），避免"同一份 schema、不同字节、每次 miss"。

### 3. 幂律衰减 —— 人不是指数忘的

```
R(t) = (1 + t / S) ^ -d
```

大多数实现用 `e^(-t/S)`。人的记忆符合幂律：有研究测到 R² = 0.954（幂律）vs 0.295（指数）。差别在尾巴——指数说你忘了，幂律说你只是不太好想起来。

衰减只降权，不删除。低于阈值进 `archive/`，仍然 `--as-of` 可查。

**每取用一次，稳定性 ×1.3**（间隔效应）。这就是为什么常想起的事忘不掉。

### 4. 情境触发 —— 像被什么勾起来

`recall()` 不只需要 query。它接受 **cue**：实体、话题、时间、情绪、目标。

```ts
mem.recall({
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

这一段会进常驻上下文，很短（<80 token），但它是"像真人"最关键的一处。

### 6. 归属 —— 这不是拟人化，是正确性

2026 年 10 月的论文 *Is it my preference? Role Grounding Attack against Agent's Memory*（arXiv:2610.38209）发现：

记忆系统记了"**谁写的**"，但没记"**这是谁的**偏好"。

攻击者发一条**内容完全真实、来源完全诚实**的帖子，里面引用它自己用户的对话。受害者保留里面的角色词 `user`，丢掉了绑定，于是这条偏好被重新归到受害者自己的用户头上。

实测直接错误归属率：**Mem0 78.1% / A-MEM 75.7% / Hindsight 99.0%**，攻击成功率 92.37%。

mnemo 的修法：写入时绑 `subject / speaker / addressee / hop`，并且

```ts
// 二手的"偏好"自动降级为传闻，永远不能改变行为
bindAttribution({ type: 'preference', hop: 1 })
// → { type: 'hearsay', downgraded: true }
```

`decisionEligible()` 只有一个条件：`hop === 0 && type !== 'hearsay'`。

---

## 记忆是一等公民的文件

```
store/
  facts/<group>/<name>.md      一条事实一个文件
  episodic/<group>/<name>.md   一件事一个文件
  persona/<name>.md            人格与风格
  intentions/<name>.md         还没做的事
  archive/<name>.md            褪色了，但还在
  index/                       纯缓存，删了不丢任何知识
  session/<sid>/               任务画布 + 卸载的工具输出
```

```markdown
---
abstract: 金呈不喜欢客套开场白
confidence: 0.9
hop: 0
last_access: 2026-11-13T10:00:00.000Z
salience: 9
stability: 4.5
subject: user:jincheng
type: preference
valid_from: 2026-11-13T09:00:00.000Z
invalid_at: null
---
他说过：直接说结论，带评级和优先级。
```

**删掉 `index/` 重建，记忆零丢失。** 这条有测试守着。

---

## 会变心，而且记得自己变过

```ts
await mem.write({ abstract: '金呈喜欢详细解释', type: 'preference', validFrom: '2026-11-10' });
await mem.write({ abstract: '金呈不喜欢详细解释', type: 'preference' });
// → supersedes，旧记录填 invalidAt，新记录 links 指回去

mem.recall({ query: '详细解释' });
// 今天：金呈不喜欢详细解释

mem.recall({ query: '详细解释', asOf: new Date('2026-11-11') });
// 那天：金呈喜欢详细解释
```

这是 `asOf` 存在的理由，也是"记忆是重建而不是回放"的落点。

---

## 工具输出卸载

长任务的上下文爆炸主要来自工具返回。超过阈值就写盘，上下文里只留一行：

```
[offload:d6b517] web_search · 300 行 · 4323 tok · 首行: 搜索结果 0: ...
（用 readOffload("d6b517") 取回全文，可分页）
```

一个 2026 年的生产报告实测：WideSearch token **-61.4%**，SWE-bench **-33.1%**，AA-LCR **-31.0%**——**同时成功率上升**（33%→50%、58.4%→64.2%、44.0%→47.5%）。噪声本来就在害它。

> 这组数字是厂商自报、特定集成下的长时会话结果。短对话收益接近零，长任务才显著。别拿它做容量规划，先量自己的。

---

## 可选的模型

零配置也能用：gist 提取会走确定性启发式，速度是微秒级。

想要更好的摘要，接一个 OpenAI 兼容端点（DeepSeek / GLM / Moonshot / vLLM / Ollama 都行）：

```ts
import { Mnemo, OpenAICompatibleLLM } from 'mnemo';

const mem = await Mnemo.open('./.mnemo', {
  llm: new OpenAICompatibleLLM({
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  }),
});
```

模型只在**编码**这一步出现，而且**永远可以失败**——网络错误、JSON 解析失败，都静默回落到启发式。写不进去比写得一般更糟。

---

## CLI

```bash
node dist/src/cli.js write  --dir ./mem --body "金呈不喜欢客套" --type preference
node dist/src/cli.js recall --dir ./mem --query "说话风格"
node dist/src/cli.js read   --dir ./mem --name pref-direct --l2
node dist/src/cli.js intend --dir ./mem --what "提醒他交报告" --at 2026-11-18T09:00
node dist/src/cli.js ctx    --dir ./mem --user "帮我看看这个设计"
node dist/src/cli.js stats  --dir ./mem
node dist/src/cli.js help
```

`reconstruct` / `forget` / `cue` 只提供库 API，不在 CLI 里。凡是"命令行参数 → 变更已有文件"的形态都会让静态分析（合理地）怀疑，与其为一个个例辩护，不如让这一类问题不存在。应用里持有记录引用时，它们仍然是一次函数调用。

---

## 诚实的局限

这一节的每一行都来自我核实过的负结果。**如果只读一个章节，读这个。**

| 事项 | 状态 |
|---|---|
| **固化（consolidation）收益** | **未被证明**。2026 年一项 2,532 个答案单元的研究：固化质量分与下游准确率不相关（ρ = **−0.24**）。另一份独立复现：加固化后准确率**下降** 1.9 个点。mnemo 因此把固化做成可选、可关、可审计的 `consolidate()`，只做归档。 |
| **衰减参数** | 全部手调，没有一个是标定出来的。`d=0.7`、`S×1.3` 都是起点不是结论。已放进 config，请 A/B。 |
| **信号权重** | Generative Agents 论文说 1:1:1，参考实现是 0.5/3/2。互相矛盾。默认值 `0.5/1.5/2/2` 同样是起点。 |
| **基准数字** | LongMemEval / LoCoMo 上各家结果互相矛盾，跨系统比较基本无意义。只看自己的场景。 |
| **CJK 实体抽取** | 没有词典就是不可靠。只抽显式标记（`@name`、`「…」`、`"…"`、`《…》`）和首字母大写的英文词。中文人名请用 `mem.cue()` 显式注册——猜会造出看起来像信号的噪声。 |
| **拟人度** | 建议做成 0-3 档。工具场景里一个"说话带不确定性、会主动挑话题"的 AI 是灾难。拟人是表达层，事实层必须硬。 |
| **向量检索** | 默认关闭。有实现测到 Recall@5 从 79.0% → 86.6%，但中位延迟 5.1ms → 139.2ms（27×）。记忆量 < 5000 条时不划算。 |

---

## API

| 方法 | 作用 |
|---|---|
| `Mnemo.open(dir, opts)` | 打开或创建记忆库 |
| `write(input)` | 写入；内部跑编码 → 归属绑定 → 合并判定 |
| `recall(query)` / `recallLines(query)` | 返回 L0 指针，不走内容 |
| `read(name, 'l1' \| 'l2')` | 显式读取，返回成本 |
| `reconstruct(name, situation)` | 按情境重建，并侵蚀置信度 |
| `forget(name, reason)` | 标记失效，不删除 |
| `cue(name, cues)` | 绑定情境线索 |
| `intend({ what, trigger })` | 登记延迟意图 |
| `due(now, ctx)` / `pendingLines()` | 到点的 / 惦记着的 |
| `buildContext(input)` | 装配缓存友好的 prompt |
| `offload(sid, tool, output)` / `readOffload` | 卸载与取回 |
| `consolidate()` | 归档褪色记录 |
| `metrics()` | 健康度 |

完整导出见 [`src/index.ts`](src/index.ts)。

---

## 为"像真人"预留的接口

| 能力 | 地基 | 状态 |
|---|---|---|
| 遗忘 | `stability` + `archive/` | ✅ |
| 改主意 | `invalid_at` + `links` | ✅ |
| 记忆模糊 | L0 / L1 / L2 三层 | ✅ |
| 时间感 | `valid_from` + `access_count` | ✅ |
| 情绪权重 | `salience` | ✅ |
| 前瞻 | `future` + `trigger` | ✅ |
| 归属 | `subject` / `hop` | ✅ |
| 错误记忆 | 冲突记忆并存，不自动纠正 | ⬜ |
| 关系记忆 | `peers/` 子树 | ⬜ |

---

## 参考资料

**认知科学（经典）**
Reyna & Brainerd, *Fuzzy-Trace Theory*, 1995 · Bartlett, *Remembering*, 1932 · Loftus & Palmer, 1974 · Schacter, *The Seven Sins of Memory*, 2001 · Wixted & Ebbesen, *On the form of forgetting*, 1991

**工程实现**
Park et al., *Generative Agents*, arXiv:2304.03442 · *HeLa-Mem*, ACL 2026 · *FADE*, IEEE 2026 · *MM-Mem*, arXiv:2603.01455 · *Pro-Memory*, arXiv:2611.05731

**安全**
*Is it my preference? Role Grounding Attack*, arXiv:2610.38209

**负结果**
*The Epistemics of Agent Memory*, arXiv:2609.33013

---

## License

MIT © 2026 jincheng3870682453-hash

---

<a id="english"></a>

## English

**mnemo** is a token-thrifty, human-like long-term memory layer for AI agents. Zero runtime dependencies, plain Markdown on disk, TypeScript.

Two ideas, in one library:

1. **Do not put content in the context — put a pointer.** Recall returns ~30-token L0 handles (abstract + path + score). Reading the body is a separate, explicit, more expensive call. Median context for a booted session in the example: **188 tokens**, 82% cacheable.

2. **Do not remember like a database — remember like a person.** Fuzzy-trace encoding (gist survives, verbatim fades), power-law forgetting (`R = (1 + t/S)^-d`, not exponential), cue-triggered recall on four signals, and prospective memory for things you have to remember to do.

It also fixes a real vulnerability: memory systems record *who wrote* a memory but not *whose preference* it expresses, which lets a correctly-signed third-party post re-ground its author's preferences onto you (measured misattribution: Mem0 78.1%, A-MEM 75.7%, Hindsight 99.0%). mnemo binds `subject`/`speaker`/`hop` at write time and demotes second-hand preferences to hearsay, which is never decision-eligible.

The [limitations section](#诚实的局限) is the honest half: consolidation has not been shown to help (ρ = −0.24 against downstream accuracy), decay parameters are uncalibrated, and the benchmarks everyone cites disagree with each other. Treat the defaults as starting points and measure your own workload.

```bash
npm install && npm run build && node dist/examples/basic.js
```
