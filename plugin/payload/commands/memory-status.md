---
description: Show what mnemo currently remembers, what it is keeping an eye on, and what the memory layer costs. / 查看 mnemo 当前记住了什么、在惦记什么，以及记忆层的开销。
argument-hint: "[查询词 | query]"
---

用 mnemo 的 MCP 工具出一份记忆状态报告，**不要**调用其它工具，也不要修改任何记忆。

1. 若用户给了查询词 `${ARGUMENTS}`，先 `memory_recall` 带上它；否则 `memory_recall` 用最近的话题。
2. 调 `memory_context`，读 `store` 与 `vectors` 两个字段。
3. 按下面结构输出，缺失的项写"无"：

```
记录数      <store.total>（actionable <store.decisionEligible> / relayed <store.relayed>）
按类型      fact=… preference=… event=… skill=… hearsay=…
按留存      active=… faint=… archived=…
意图        <store.pendingIntentions> 条待触发
置信度      均值 <store.meanConfidence>
语义检索    <vectors.enabled ? "开（" + vectors.embedder + "，" + vectors.indexed + " 条）" : "关">

相关记忆（L0 指针）
- <每行一条，含年龄与路径>

你记挂的事
- <memory_context 的 pending，为空则写"无">
```

4. 结尾给一句判断：**是否需要整理**（记录数增长快、relayed 占比高、或 confidence 明显偏低时提醒用户）。
5. 不要自动删除或修改任何记忆；用户明确要求时再单独处理。
