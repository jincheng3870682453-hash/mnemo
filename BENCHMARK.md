# Benchmark 方法论

这份文档说明 mnemo 基准测什么、怎么测、数字可信到什么程度。README 里的图由代码生成，不手绘。

---

## 1. 两组基准

| 基准 | 命令 | 语料 | 用途 |
|:--|:--|:--|:--|
| **真实对话** | `npm run bench:dialogue` | `bench/data/dialogues.jsonl`：20 段 / 160 轮 / 76 个事实 / 40 个标注问题 | 主结果，回答“省不省 token、找不找得到” |
| **固化** | `npm run bench` | 20 主题 × 4 条陈述（合成） | 回归检查，只回答“固化有没有把库弄坏” |
| **自适应调参** | `npm run bench:adaptive` | 同一份对话语料 | 对比固定参数 vs LinUCB 在线调参 |

---

## 2. 对话语料

### 结构

```jsonc
{
  "id": "d01",
  "domain": "coding",
  "turns": [{ "role": "user", "text": "..." }, { "role": "assistant", "text": "..." }],
  "facts": [
    { "name": "pref-vim", "abstract": "...", "body": "...", "type": "preference", "salience": 8, "turn": 1 }
  ],
  "queries": [
    { "q": "VSCode 的 vim 键位 leader 是什么", "expectFact": "pref-vim", "expectTurn": 1 }
  ]
}
```

- `facts[].turn`：该事实在第几轮被说出（0-based）。朴素基线用它判断命中。
- `queries[].expectFact`：正确答案的记忆名，mnemo 用它判断命中。
- `queries[].expectTurn`：正确答案所在轮次，朴素基线用它判断命中。

### 来源与标注

语料是人工整理的真实感对话：中文技术、工作、生活场景，去掉了可识别信息。**不是**从某个公开数据集直接复制的，也**不是** LLM 合成的。每段 8 轮、2–3 个事实、2 个问题，事实和问题一一对应。

为什么不用公开数据集？因为公开对话没有“哪句话是事实、哪个问题该命中哪句”的标注，自动标注会引入比被测系统更大的误差。人工标注慢，但至少 ground truth 是可信的。

### 如何扩展

1. 按上面的 JSON 结构加一行到 `bench/data/dialogues.jsonl`。
2. 确保每个 `query` 的 `expectFact` 真实出现在某个 `fact` 里，且 `expectTurn` 指向包含该信息的轮次。
3. 跑 `npm run bench:dialogue`，看汇总。

`bench/data/fetch.mjs` 可以把公开数据集转成同样的结构，但它的标注是启发式的，只适合做交叉检查，不适合当主结果。

---

## 3. 两个系统

| | naive | mnemo |
|:--|:--|:--|
| 记忆 | 原始 transcript | `write()` 写下的事实 |
| 每轮上下文 | system prompt + 截至当前的全部对话 | `bootContext()`：system + 记忆索引 + 少量 L0 指针 + 用户消息 |
| 检索 | BM25 over 对话轮次 | BM25 over 记忆索引（实测路径） |
| 命中判定 | top-k 是否包含 `expectTurn` | top-k 是否包含 `expectFact` |

两个系统用同一个 system prompt、同一份语料、同一批问题。naive 拿到的是未截断的全文——这是它最强的形态，也是没有记忆层时人真实的做法。

---

## 4. 指标

| 指标 | 定义 | 方向 |
|:--|:--|:--|
| `context tokens` | 整段会话里塞进 prompt 的 token 总和 | 越低越好 |
| `tokens / turn` | 上一项 ÷ 轮数，消除对话长度差异 | 越低越好 |
| `recall@1` | top-1 命中标注答案的比例 | 越高越好 |
| `recall@3` | top-3 命中的比例 | 越高越好 |
| `probe saving` | `feelLine()` 相对 `recallLines()` 的 token 节省 | 越高越好 |

Token 数是 mnemo 自己的估算器（CJK 约 1 token/字，其他约 0.25 token/字符），不是某个厂商的分词器。它偏保守，但不影响两个系统的相对比较，因为两边用的是同一把尺子。

---

## 5. 结果（2026-11，20 段 / 160 轮 / 40 问题）

| metric | naive | mnemo |
|:--|--:|--:|
| recall@1 | 22.5% | **85.0%** |
| recall@3 | 55.0% | **97.5%** |
| context tokens | 22,292 | 24,987 |
| tokens / turn | 139.3 | 156.2 |
| probe vs recall | — | 1,902 vs 2,588 tok（**−26.5%**） |

### 怎么读

- **准确率是主结果**：同样的 40 个问题，naive 在整段 transcript 上只能 top-1 命中 22.5%，mnemo 85%。
- **token 在短会话里不占优**：8 轮左右的对话，mnemo 的固定启动开销（system + 索引）比增量 transcript 贵约 12%。
- **长会话反转**：naive 每轮线性增长，mnemo 基本恒定。按语料均值外推，交叉点在 **11 轮**左右（`cost-curve.svg`，解析投影，不是额外测量）。
- **探针单独有用**：判断“有没有”比“拿出来”便宜 26.5%。

---

## 6. 局限

| 项 | 说明 |
|:--|:--|
| 语料规模 | 20 段对话，不足以覆盖长尾领域；扩大语料是提高可信度的第一优先级 |
| 标注者 | 语料与实现出自同一人，标注可能无意中偏向实现 |
| token 估算 | 近似分词器，绝对值不可与厂商账单直接对比 |
| 成本曲线 | 8 轮之后是解析外推（平均轮长 × 轮数），不是实测 |
| 自适应基准 | 给的是 oracle 反馈，是上限；真实调用方只有 `read()` 启发式和显式 `feedback()` |

**会提高可信度的下一步**：把对话扩到 100+ 段并覆盖更多领域；引入第二个标注者做交叉复核；把 token 估算换成目标厂商的分词器跑一次对照。

---

## 7. 自适应调参基准

`npm run bench:adaptive` 在对话语料上跑两遍：

- **fixed**：默认参数，`adaptive.enabled = false`
- **adaptive**：`adaptive.enabled = true`，每次 recall 后给 oracle 反馈（标注答案是否在返回的指针里）

当前结果：两者 recall@1 都是 80.0%、recall@3 都是 97.5%。语料对参数的区分度不够，所以 **没有观察到调参收益**——这是一个诚实的负结果，不是失败。臂分布显示 bandit 在 6 个预设之间探索，`goal-first` 的均值奖励略低（0.80），其余接近 1.0。

要让这个基准有区分度，需要更难的语料：大量近似重复、变化中的偏好、长尾领域。这也是 `bench/data/` 下一步要扩的方向。
