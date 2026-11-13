---
name: mnemo-memory
description: Use the mnemo memory store when a conversation needs continuity across sessions. / 需要在跨会话延续上下文时使用 mnemo 记忆库。 Load when the user references something discussed before, asks you to remember/forget anything, mentions a deadline, or asks what you know about them.
---

# mnemo memory

记忆分三层，成本差一个数量级。**默认只用最便宜的那层。**

| 层 | 工具 | 成本 | 什么时候用 |
|---|---|---|---|
| L0 指针 | `memory_recall` | 每次命中 ~30 tok | 默认。先看有没有 |
| L1 大纲 | `memory_read` `depth:"l1"` | ~1/8 正文 | 指针显示相关，但不知道细节 |
| L2 全文 | `memory_read` `depth:"l2"` | 全文 | 确定要引用原文 |

## 读的三条规矩

1. **先 recall，再 read。** 不要凭印象回答"我们之前聊过…"。
2. **`memory_recall` 返回的是索引，不是原文。** 摘要里没有的细节就是没有，不要补。
3. **拿到的路径要真的读了才引用。** 凭摘要复述等于编造。

## 写的门槛

只在**四条都过**时写：

- 三个月后还有用
- 不是寒暄、确认或本轮的中间过程
- 跨会话可复用
- 和已有记忆不重复（重复的让 `memory_write` 自己合并，别手动改写）

写入时必须做三件事：

1. **消解指代**：`"他同意了"` → `"金呈同意了"`
2. **锚定时间**：`"下周五"` → `"2026-11-20"`
3. **能独立读懂**：不读其它记忆也能理解这一条

`abstract` 是一句话的结论，不是话题名。写"金呈不喜欢客套开场白"，不是"用户偏好"。

## 归属：这条是谁的偏好

写入 `type: "preference"` 时必须带 `subject`。

- 用户亲口说的 → `hop: 0`，可以影响你的行为
- 别人转述的 → `hop: 1`，会被降级成 hearsay，**只能提及，不能据此做决定**
- 二手以上 → `hop: 2+`

这不是可选项。不绑定主体的偏好无法判定归属，等同于没有。

## 改主意

不要用 `memory_write` 覆盖旧认知。直接写新的，系统会判定 `supersedes`、给旧记录填失效时间，并保留可回溯的历史。之后 `memory_recall` 看到 `superseded` 标记的，说明那是旧版本。

## 前瞻

用户提到将来要做的事、截止日期、承诺，用 `memory_intend`：

```json
{ "what": "提醒他周三交审计报告", "at": "2026-11-18T09:00" }
{ "what": "聊到预算时提一句超支了", "on": ["预算", "超支"] }
```

到点的意图会通过 `memory_context` 自动出现在上下文里。**不要等用户想起来。**

## 上下文装配

`memory_context` 返回：

- `prefix` — 稳定、可缓存。**放在 prompt 最前面，不要往里插时间戳或 session id**
- `suffix` — 每轮变化，放在后面
- `tokens` — 各层开销

顺序反了会直接让缓存全废，输入成本可能是命中价的 50 倍。

## 不要做的事

- 不要在一轮里反复 recall 同一批记忆：该进 `memory_context` 的让它进
- 不要把大段工具输出写进记忆：那是上下文爆炸的主要来源
- 不要因为"可能有用"就写：噪声会挤掉正确的东西，检索会变差
- 不要消失的细节上编：说"我记不清了"比编一个更可信
