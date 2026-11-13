# mnemo for DSH Go

给 [DSH Go](https://github.com/ccch1mneyyy/dsh-Go) 手机 App 的原生记忆插件。
背后是 [mnemo](https://github.com/jincheng3870682453-hash/mnemo)——一个「既省 token 又像人」的长期记忆库。

三个界面，都只放**指针**，不放记忆正文：

| 界面 | 位置 | 作用 |
|---|---|---|
| **状态条** | 输入框上方一行 | `记忆 12 · 惦记 2`，一眼看清有多少、有几件到点 |
| **输入框胶囊** ×2 | 输入框上方 | **记住这句**（把草稿存进记忆）、**想起来**（拿草稿当查询，命中就插回输入框） |
| **面板** | 对话详情页「插件」页签 / 全部功能 | 最近记住了什么、多少条可作依据、一键自检 |

## 装

**从市场装**（如果已经收录）：设置 › 插件 › 插件市场，搜「记忆」。

**从本地目录装**（开发时）：

```sh
dsh plugin --profile web add /path/to/dsh-go
```

手机本机引擎用的 profile 是 `web`。装的是指向目录的链接，目录不能删。

改 `lib/` 里的代码后要在 App 的「引擎」页重启引擎才生效；只改 `package.json` 会自动重读。

卸载：`dsh plugin --profile web remove mnemo-dsh-go`，再删目录。

## 数据存在哪

```
$DSH_HOME/dsh-go/memory/        # DSH_HOME 默认 ~/.dsh
  facts/ episodic/ persona/ intentions/ archive/ history/
```

就是一堆 Markdown 文件，可以直接用任何编辑器看、改、diff。删掉 `index/` 不会丢任何东西。

## 隐私

- **不联网。** 插件不调用任何模型，也没有 embedder；要点提取走确定性启发式。
- **App 不执行插件代码。** 按协议，App 只画 `package.json` 里的 `dshGo` 声明和插件返回的 JSON 视图。
- 第一次点「记住这句」/「想起来」时，App 会问一次是否允许读输入框。

## 三个界面为什么这样设计

记忆库最容易犯的错是把内容塞进上下文。这个插件的每一处都反过来：

- **状态条**只有 11 个字，却是唯一常驻的东西——它回答「我有没有记忆」而不占 token。
- **想起来**先走元记忆探针（一行），确认「不知道」就直接说不知道，省掉一次完整检索。
- **面板**列的是摘要 + 类型 + 年龄，不展开正文；要看细节去读文件。

## 开发

仓库根目录：

```sh
npm run build:plugin      # 编译并把库塞进 dsh-go/lib/mnemo
npm run check:dsh-go      # 清单 lint + 假桥接点按冒烟测试
```

`check:dsh-go` 按官方 `dsh-go-plugin` 技能文档里的约束逐条检查：插槽上限、标签字数、id 字符集与唯一性、序列化大小、strip 与 panel 的交叉引用，然后用假桥接真点一遍每个 handler。
权威检查器仍然是 App 自带的 `kit/bin/check.mjs`（需要 `$DSH_HOME/skills`）。

## 许可证

MIT
