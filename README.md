# @local/dsh-time-weaver（时空编织者）

> DSH（DeepSeek Harness）会话流控制插件：在保留不可变追加日志（append-only journal）的前提下，对**用户消息回溯与原地编辑**、**AI 回复原地编辑**、**语义撤回**与**重新生成**做完整支持。

底层日志一条都不改，全部能力以 `hook/invoked` 保留事件追加落盘——所以关闭客户端、重启电脑、切换历史会话之后，所有编织状态依然成立，并且对插件安装之前创建的旧会话同样有效。

---

## 目录

- [功能](#功能)
- [环境要求](#环境要求)
- [安装](#安装)
- [工作机制](#工作机制)
- [HTTP API](#http-api)
- [诊断日志](#诊断日志)
- [已知限制](#已知限制)
- [开发与测试](#开发与测试)
- [目录结构](#目录结构)
- [致谢与许可](#致谢与许可)
- [版本历史](#版本历史)

---

## 功能

| 功能 | 入口 | 行为 |
| --- | --- | --- |
| **回溯重填** Rewind | 用户消息操作行的「↺ 回退至此」 | 打断正在跑的回合；隐藏该消息及其后的尾部；原文与图片附件回填输入框；可再次编辑发送 |
| **取消回溯** Cancel | 发送按钮左侧「✕」 | 撤销待定回溯，恢复全部行，并清空回溯自动回填的草稿 |
| **原地编辑** Edit | AI 回复操作条「✏️ 编辑此回复」 | 弹窗修改正文；保存后**模型上下文**与**屏幕气泡**同时更新，保留分段换行 |
| **编辑提问** Edit User | 用户消息操作行「✏️ 编辑此消息」 | 弹窗修改已发送的提问；保存后模型上下文与气泡同步更新，图片/文件附件保留；可改用「保存并重新生成」连带重做回答 |
| **撤回 / 删除** Retract | AI 回复操作条「🗑️」 | 该条回复从会话中整行隐去；模型侧读到的是可配置占位符（默认 `.`） |
| **重新生成** Regenerate | AI 回复操作条「🔄」 | 旧回复隐去并从上下文剔除，主动唤醒新一轮生成；触发消息以 notice 形态折叠为一行提示 |
| **设置** Settings | 输入区右侧「⚙」 | 选择或自定义撤回占位符 |

所有 AI 侧操作都保留前置工具调用链（tool calls / tool results），不会产生孤儿工具结果。

## 环境要求

- DSH Next（插件依赖宿主侧的 `webServer` / `sessions` / `agents` 服务与客户端 `slots` 服务）
- DSH 0.2.1-rc.2 起用户气泡正文改由 `conversation.chat.user.content` Factory 渲染；插件优先使用它，缺失时自动回退纯文本
- Node.js >= 20
- 无运行时第三方依赖

## 安装

插件以普通 DSH 插件包的形式挂载，需要有 `package.json` 的 `dsh.bundle` 与 `dsh.client` 声明：

```jsonc
// package.json（节选）
"main": "host.v8.js",
"exports": { ".": "./host.v8.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },   // 挂载 host 半边
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
}
```

把本包加入你的 DSH profile 依赖并列入 `dsh.profile.bundles`，然后**重启 DSH**（host 半边在进程启动时加载）。客户端半边随页面刷新即可生效。

## 工作机制

插件分两半，职责互不重叠：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| Host | `host.v8.js` | 追加/回放 `hook/invoked` 事件、改写 `session.deriveMessages()` 投影、提供 HTTP 接口、唤醒 agent |
| Client | `client.js` | 通过 `slots` 注入按钮与弹窗、按状态隐藏/回写已渲染的行 |

几个关键点：

1. **模型上下文**由 `session.deriveMessages()` 决定。Host 在它外面包了一层投影：被编辑的回复换成新正文，被编辑的提问替换其文本块（图片/文件附件块保留），被撤回的换成占位符，被回溯的区间与被重新生成的回复直接剔除。返回的 `content` 始终是标准 block 数组。
2. **屏幕显示**不由事件驱动，而是插件按状态二次处理已渲染的行：
   - 定位采用回合锚：先按 `data-chat-turn` 收齐本回合所有行，编辑时优先选带 `data-turn-process-answer` 的答案行，其次 `assistant-step`，绝不落到「已完成，用时 N 秒」的 `turn-process` 控制行。
   - 编辑写入答案行里最大的 `MarkdownText` 块（`div[class*="markdown"]`）；推理块（`data-markdown-variant="compact"`）不参与，避免改到思维链。
   - 隐藏 = 整行 `display:none`；编辑在答案 Markdown 块内挂专用编辑层并隐藏原渲染节点，编辑层用宿主 `MarkdownText` 重新渲染 Markdown，不删除 React 管理的元素。
   - 用 `MutationObserver`（含 `characterData`）加 1.2s 兜底重放，抵抗 React 重渲染回滚。
3. **回溯提交**发生在下一回合的 `agent/pre-step`：把待定区间固化为隐藏区间。区间右端取**标记时刻的尾部**，因此新发的消息与它的回复不会被误伤；客户端在存在待定状态时轮询 `/state`，确保宿主提交后立即同步。
4. **重新生成**调用 agent 实例的 `followup()` 主动开启新一轮（无需用户输入），触发消息带 `source.form = "notice"`，渲染成一行折叠提示而非用户气泡。

## HTTP API

全部挂在 `/api/time-weaver` 下：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/mark` | 标记回溯起点（`sessionId` / `seq`），返回 `markSeq` |
| POST | `/cancel` | 取消待定回溯 |
| POST | `/edit` | 编辑指定 seq 的回复正文 |
| POST | `/edit-user` | 编辑指定 seq 的用户消息；`resend: true` 时连带隐去旧尾部并重新发一轮 |
| POST | `/retract` | 撤回指定 seq，返回 `originalText` |
| POST | `/regenerate` | 剔除并重新生成，返回 `started` / `originalText` / `turn` |
| GET | `/message` | 取某条消息的正文与状态 |
| GET | `/state` | 完整状态：`pending` / `ranges` / `edits` / `userEdits` / `retractions` / `regenerates`（含 `turn` 与 `originalText`） |
| GET·POST | `/config` | 读写全局配置（占位符） |
| GET | `/image` | 取回被回溯消息引用的图片附件 |
| POST | `/diag` | 客户端诊断上报，写入诊断日志 |

## 诊断日志

客户端与宿主共同往 `~/.dsh/time-weaver-diag.log` 追加 JSON 行（超过 512 KiB 自动截断），无需 DevTools 即可定位问题：

| `v` | 含义 |
| --- | --- |
| `boot` | 客户端半边加载完成（含 `hasSlots`，可判断槽位服务是否可用） |
| `diag-1` | 一次状态应用：行数、各类行数、编辑/撤回/重生成条数、命中数、盖章数 |
| `rewind-click` / `rewind-rejected` | 回溯点击与宿主拒绝原因 |
| `mark-ok` / `mark-reject` | 标记成功（含 `tailSeq`）或拒绝原因（`unknown-session` / `bad-seq` / `not-user-message` / `inside-hidden-range`） |
| `pending-committed` | 宿主已提交回溯区间，客户端完成同步 |
| `regenerate` / `regenerate-rejected` | 重新生成是否成功唤醒新回合、失败原因 |

## 已知限制

- **屏幕层是二次处理**，不是重写渲染器：定位依赖 DSH 当前的 DOM 结构（`data-chat-flow-key` / `data-chat-turn` / `data-chat-flow-kind`）。DSH 大版本调整聊天 DOM 时，需要跟着更新 `TW_ROW_SELECTOR` 与定位函数。
- 一个回合可能包含多个 assistant 步骤（思维链、工具卡）。编辑/撤回/重生成作用在该回合的**最终回答**上。
- 重新生成会额外落一条 notice 形态的上下文消息；这是触发新一轮的必要输入，不会显示成用户气泡。
- 回溯区间一旦提交即持久化，隐藏的是旧尾部；新消息不会被吞。该行为不可通过界面撤销（需要直接改日志）。
- 编辑用户消息只改这条消息本身，它下面已有的回答保持原样；要连回答一起重做，用弹窗里的「保存并重新生成」。
- 「保存并重新生成」是把改后的文本作为**新消息**重发一轮，原消息里的图片/文件附件不会带过去；原消息与其回答整段隐去。

## 开发与测试

无第三方依赖，直接跑：

```bash
node test/host.test.mjs     # host 投影：编辑/撤回/重生成/回溯提交区间
node test/hiding.test.mjs   # client 定位与隐藏：回合锚、歧义、占位、幂等、换行
```

两套测试都直接加载真实入口文件（`host.v8.js` / `client.js`），不复制代码、不 mock 框架。

## 目录结构

```
dsh-time-weaver/
├─ host.v8.js            # host 半边（真实入口）
├─ client.js             # client 半边（真实入口）
├─ cordis.patch.yml      # 挂载 host 半边的 bundle 补丁
├─ package.json          # main / exports / dsh 声明
├─ test/
│  ├─ host.test.mjs
│  └─ hiding.test.mjs
├─ screenshot.png        # 用户气泡操作条
└─ screenshot-input.png  # 回溯横幅与输入框
```

> 注意：`package.json` 的 `main`、`exports["./client"]` 与 `cordis.patch.yml` 指向的是**根目录**这两个文件。包里没有其它源码副本，改代码只改这两个。

## 致谢与许可

- 灵感与底座思路来自 [`@xsj/dsh-rewind`](https://github.com/XSJUSTC)（行为与实现均已按 DSH 现行 API 重写）。
- 由 Nova 与辉宝主人联合设计并实现。
- [MIT License](./LICENSE)

---

## 版本历史

### 1.0.14 (2026-11-19 23:57)
- 修复编辑用户消息后气泡背景消失：重放时原文已被编辑层取代，按内容定位必然落空，旧回退逻辑把整块内容容器（连同气泡背景）替换掉，只剩一层无背景的文本。
- 编辑层新增 `data-tw-edit-seq` 标记：重放先按 seq 命中已有编辑层并原地更新，不再按内容重找，也不会重复建层。
- 定位回退改为沿气泡内「主导文本分支」逐层下降，编辑层始终落在文本容器内部，气泡的背景、内边距与圆角得以保留。

### 1.0.13 (2026-11-19 23:28)
- 新增「编辑用户消息」：用户气泡操作行新增 ✏️ 按钮，可修改已发送的提问；保存后模型上下文与屏幕气泡同时更新，图片/文件附件保留在消息里。
- 新增「保存并重新生成」：改完提问后把旧提问及其回答整段隐去，用改后的文本重发一轮，屏幕与模型上下文只保留一个版本的问句。
- 用户消息编辑走独立通道（`/edit-user` 与 `edit-user` 保留事件），与 AI 回复编辑互不覆盖；`/state` 新增 `userEdits`，`/message` 返回 `role`，刷新或重启后编辑状态依然成立。
- 屏幕回写对用户文本用纯文本模式，不做 Markdown 重渲染，避免输入里的 `*`、`_` 被吃掉；编辑层挂在文本节点自身，同气泡里的图片/文件卡片不会被一并隐藏。

### 1.0.12 (2026-10-31 20:54)
- 修复编辑后的 AI 回复变成明文代码的问题：1.0.10 的编辑层把正文当纯文本写进 `pre-wrap` 层，Markdown 语法不再渲染；现在编辑层通过平台共享的 `react-dom/client` 挂独立 React root，用宿主 `UiPrimitives.MarkdownText` 重新渲染，标题、列表、表格、代码块、链接恢复正常显示。
- 保留“隐藏原渲染节点、不删除 React 子节点”的安全策略；`react-dom` 不可用时仍回退纯文本，不会白屏。
- 编辑层带渲染版本标记：插件热更新后，旧版本留下的纯文本层会自动重渲染为 Markdown，不会停留在旧样式。
- 运行时自检确认 `**粗体**` 与 `- 一/- 二` 能渲染成 `<strong>` 和 `<ul><li>`。

### 1.0.11 (2026-10-28 22:29)
- 修复用户消息气泡被压成一字一行的问题：插件在 `.tw-stack`（宽度由内容收缩）里再套 `.tw-factory`，宿主用户气泡自身的 `max-width:82%` 在不定宽父级里退化成极窄，中文短句（如“继续”）被逐字换行。
- `.tw-stack` 改为 `width:100%; max-width:min(525px,82%)`，`.tw-factory` 改为 `display:flex; flex-direction:column; align-items:flex-end; width:100%`：既给宿主 `userStack` 的百分比宽度一个确定的包含块，又让 82% 宽的 `userStack` 右对齐，气泡右边缘与时间/复制/回退按钮右边缘齐平。
- 实测短消息气泡右边缘从落后 actions 约 94.5px 修正为完全对齐（仅 1px 舍入），长消息仍受 525px / 82% 上限约束。

### 1.0.10 (2026-10-28 20:44)
- 修复新版 DSH 下「编辑 AI 输出」保存后屏幕不更新的问题：新版把已完成回合折叠成 `turn-process` 控制行（「已完成，用时 N 秒」），旧逻辑按回合取最后一行会选中控制行，整段原文匹配必然落空。
- 编辑行选择改为按优先级评分：`data-turn-process-answer` 答案行 → `assistant-step` → 最后才考虑控制行；并排除 `group-part="reasoning"`。
- 编辑写入改为定位答案行里的 `MarkdownText` 块（`div[class*="markdown"]`），不再依赖原文精确匹配——模型侧原文是 Markdown，渲染后 `**`、表格竖线等符号会消失；推理块（`data-markdown-variant="compact"`）明确排除。
- 文本回写改为在答案 Markdown 块内挂专用编辑层、隐藏原渲染节点，不删除 React 子节点，避免 `removeChild` 异常，也不会把表格/代码块改成残缺结构；多段回复的新正文写入第一个文本块，其余旧片段隐藏。
- `/edit` 与 `/message` 返回宿主侧解析的 `turn`；`turnOfSeq` 在事件缺 `data.turn` 时向前回溯最近一个带回合号的事件，编辑按钮被 portal 到外层时也不会丢回合锚。
- host 侧取文兼容 `kind: "text"` 的文本块，冷加载后仍能拿到原文与回合锚。

### 1.0.9 (2026-10-21 14:20)
- 适配 DSH 0.2.1-rc.2：`UiPrimitives.projectUserText` 已被移除（用户文本改为 `conversation.user.text` 键位 Slot），原调用让整个 `conversation.chat.node` 条目抛错、用户消息整行消失。
- 用户气泡改走宿主的 `conversation.chat.user.content` Factory（`renderFactorySlot`），正文、引用 chip、图片/文件卡片全部交回宿主渲染；拿不到 Factory 时回退为保留换行的纯文本气泡 + 旧 `renderMessageImages`。
- 新增 `.tw-factory` 容器样式；复制/回退按钮与外层行结构不变。

### 1.0.8 (2026-10-21 11:16)
- 行定位改为**回合锚优先**（`data-chat-turn`），与文本解耦；修复重新生成/删除"时灵时不灵"。
- `/state` 的 `regenerates` 升级为 `{seq, turn, originalText}`，刷新后仍可定位。
- 移除 effect 清理里的 `rwRestoreAll()`：它会在每次状态变化时还原隐藏行，造成"闪出来又消失"。

### 1.0.7 (2026-10-19 17:20)
- 修复回溯提交后客户端状态卡死：宿主提交 `pending` 无推送渠道，客户端继续旧值隐藏新消息。改为存在待定状态时轮询 `/state` 并同步。
- 点击回退时立刻给该行盖章并执行一次判定，消除"点下去没反应"。

### 1.0.6 (2026-10-19 11:52)
- 重新生成真正可用了：`/regenerate` 改为调用 `agent.followup()` 主动开新一轮；触发消息用 `notice` 形态，不显示为用户气泡。
- 被重新生成的回复整行隐去，新回复出现在原位。

### 1.0.5 (2026-10-19 00:11)
- 编辑文本回写保留换行（`white-space: pre-wrap`）。
- 撤回改为整行隐藏，`.  ` 仅作为喂给模型的占位符。
- `/mark` 成功与拒绝均写诊断日志；诊断增加 `userStamps`，可判断回退按钮是否由插件渲染。

### 1.0.4 (2026-10-18 22:39)
- 定位到真实 DOM 载体：已完成的回合把回复折叠进 `turn-process` 分组行，选择器恢复为 `assistant-step + turn-process + [data-turn-process-answer]`。
- 新增 `characterData` 观察与 1.2s 兜底重放；新增 `/diag` 诊断通道。

### 1.0.3 (2026-10-18 19:40)
- 修复短回复（如 `1 → 2`）因"至少 4 字符"护栏被跳过的问题。
- 撤回与编辑共用回写通道；回溯提交区间改用 `tailSeq`，不再吞掉新消息；取消回溯同步清空草稿。

### 1.0.2 (2026-10-18 17:56)
- 修正入口错位：此前的修复全部写进了不被加载的 `lib/` 副本，现落回根目录真实入口。
- `deriveMessages` 产出的 `content` 改为标准 block 数组，消除 `message.content.some is not a function`。
- 派生缓存改用单调 `rev` 失效；`/state` 与 `pre-step` 均重装投影。
- 客户端 `seq` 改取 `node.anchorSeq`，会话 id 补 `liveSessionId` 兜底。

### 1.0.1 (2026-10-16 21:26)
- 修复 host 端 `deriveMessages` 的 content 字符串缺陷。
- 客户端补齐历史消息 seq 解析、待定回溯的视觉隐去，以及编辑后的视图刷新。

### 1.0.0 (2026-10-14 19:58)
- 首次发布：回溯重填、AI 回复原地编辑、语义撤回、重新生成、占位符设置面板，状态全部落盘。
