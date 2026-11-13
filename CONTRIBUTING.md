# Contributing to mnemo

Thanks for looking. This library has unusually opinionated invariants, so the most
useful thing this file can do is tell you **what not to break** before you start.

---

## 先看这三个不变量

改动如果违反它们，测试会失败——这不是意外，是设计。

**1. 文件是真源，索引是缓存。**
`rm -rf store/index` 之后记忆必须一条不少。任何把状态只存在索引里的改动都会被 `tests/store.test.ts` 拒掉。

**2. 上下文前缀必须逐字节稳定。**
`assemble()` 返回的 `prefix` 里不许出现时间戳、session id、计数器或不稳定序列化。工具定义一律走 `stableToolBlock()`。破坏这条会让缓存命中率归零，成本涨 50 倍。

**3. 二手偏好不能影响行为。**
`hop > 0` 的偏好写入即降级为 hearsay，`decisionEligible()` 要求 `hop === 0` + 非 hearsay + 偏好必须绑定 `subject`。这条对应一个真实攻击（arXiv:2610.38209），不是风格问题。

顺带一提：**任何"让记忆更聪明"的机制，必须能被关掉。** 这个领域里"听起来对但没被证实"的东西太多了，`consolidation` 就是前车之鉴（ρ = −0.24）。

---

## 适合贡献什么

**很欢迎：**

- 修 bug，尤其是路径处理、CJK 分词、时间边界
- 补测试——特别是能复现"记忆记错/忘记"这类失败的用例
- 文档：把某处"为什么这么写"讲清楚
- 新的**可选**机制，带开关和基准
- 翻译 README / SKILL.md

**先开 issue 讨论：**

- 改默认参数（衰减指数、信号权重）——需要数据，不是直觉
- 换存储格式或引入运行时依赖（本项目零运行时依赖，这是硬约束）
- 改公开 API 签名

**大概率不会被接受：**

- 引入向量数据库 / 图数据库作为默认路径
- 让 agent 自己管理内存循环（Letta 路线，锁死成本太高）
- 把"更聪明"当卖点的功能，但没有可复现的测量
- 在上下文里塞更多内容来"提高召回"

---

## 本地开发

```bash
git clone https://github.com/jincheng3870682453-hash/mnemo.git
cd mnemo
npm ci
npm run build
npm test          # 136 个测试
```

要求 Node 20+。项目**零运行时依赖**；`devDependencies` 只有 `typescript` 和 `@types/node`。

### 常用命令

| 命令 | 作用 |
|---|---|
| `npm run build` | `tsc` → `dist/` |
| `npm test` | build + 全部测试 |
| `npm run test:only` | 只跑测试（不 build） |
| `npm run bench` | 固化与探针基准 |
| `npm run build:plugin` | 把 `dist/src` 收进 `plugin/payload/dist` |
| `npm run verify:plugin` | 校验提交的 payload 与源码一致 |
| `npm run example` | 跑完整 tour |

### 改完之后至少跑这些

```bash
npm run build
npm run test:only
npm run bench                    # 基准不该倒退
npm run build:plugin             # 改了 src 就必须重新生成 payload
```

**改了 `src/` 却没跑 `build:plugin`，CI 会红。** payload 是提交进仓库的，漂移会被 `git diff` 抓出来。

---

## 测试约定

- 用 Node 内置 `node:test` + `node:assert/strict`，不引入测试框架
- 测试文件名 `tests/<module>.test.ts`，用中文或英文描述都行，但**断言消息要说清楚哪里坏了**
- 涉及时间的逻辑，注入固定的 `now`，不要依赖 `Date.now()`
- 涉及 CJK 的用例至少包含一条中文输入——英文测试覆盖不到分词和 slug 的坑
- 修 bug 时先写一个会失败的用例，再修

已有的回归用例值得一读，它们都是真实踩过的坑：

| 文件 | 守着什么 |
|---|---|
| `tests/attribution.test.ts` | 角色归因攻击、二手偏好降级 |
| `tests/competition.test.ts` | 抑制"反复有用"的记忆这个失败模式 |
| `tests/budget.test.ts` | 预算里不静默截断 |
| `tests/assembler.test.ts` | prefix 跨轮逐字节稳定 |
| `tests/id.test.ts` | CJK slug 不塌陷 |
| `tests/store.test.ts` | 索引可删、路径不越界 |

---

## 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: add prospective trigger for recurring events
fix: keep CJK slug from collapsing to its ASCII remnant
docs: explain why vectors are off by default
test: cover contradiction where the predicate contains a negation
refactor(store): write in place instead of rebuilding paths
```

正文里写**为什么**，不写"改了什么"——diff 已经说清楚改了什么。

---

## PR 清单

提交 PR 前自查：

- [ ] `npm run build && npm run test:only` 通过
- [ ] 改了 `src/` 的话，`npm run build:plugin` 已跑，payload 无 diff
- [ ] 新机制**默认关闭**，或者有基准/测量支撑默认值
- [ ] 破坏性变更写进 `CHANGELOG.md` 的 `Unreleased`
- [ ] 没有新增运行时依赖
- [ ] 新增的公开 API 在 `src/index.ts` 里有导出和注释
- [ ] 修 bug 的 PR 带一个会先失败的用例

PR 描述里请写三行：**问题是什么 / 你怎么验证的 / 有什么已知副作用**。

---

## 用 AI 工具写的代码

可以用，但请：

1. **自己读过。** 提交者对每一行负责，不是对工具的产出负责。
2. **如实标注。** 在 commit 或 PR 里加一行 `Assisted-by: <工具名>`。
3. **不要让它替你判断取舍。** 这个仓库里每个"聪明"的机制都有对应的负结果记录；让工具生成的"最佳实践"很容易踩上去。
4. **不要让工具削弱安全约束。** 如果某条路径校验"看起来多余"，去读 `SECURITY.md` 里为什么它在。

---

## 提问与讨论

- **Bug / 功能**：开 issue（有模板）
- **安全问题**：**不要开公开 issue**，见 [SECURITY.md](SECURITY.md)
- **大的方向性讨论**：开一个带 `discussion` 标签的 issue，先说清楚要测量什么

响应时间没有承诺。这是个业余时间维护的项目，但每个 issue 都会被读。

---

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

---

## 许可

贡献的代码按 [MIT](LICENSE) 授权。
