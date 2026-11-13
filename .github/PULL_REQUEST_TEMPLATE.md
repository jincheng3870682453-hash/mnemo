## 问题

<!-- 这个 PR 解决什么。链接对应 issue。 -->

## 改动

<!-- 关键决策和取舍。不要罗列文件，diff 已经说了。 -->

## 怎么验证的

```bash
# 贴出实际跑过的命令和结果
npm run build && npm run test:only
```

## 检查清单

- [ ] `npm run build && npm run test:only` 通过
- [ ] 改了 `src/` 且已跑 `npm run build:plugin`，payload 无 diff
- [ ] 新机制默认关闭，或有基准支撑默认值
- [ ] 破坏性变更已写进 `CHANGELOG.md`
- [ ] 没有新增运行时依赖
- [ ] 修 bug 的话，带了一个会先失败的用例

## 已知副作用

<!-- 性能、行为、兼容性上的代价。写"无"也要说明为什么无。 -->

## AI 协助

<!-- 如果有，写 Assisted-by: <工具名>；没有就删掉这一节。 -->
