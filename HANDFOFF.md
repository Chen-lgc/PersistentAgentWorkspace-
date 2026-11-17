# QBot 开发交接

更新日期：2026-11-17（Asia/Shanghai）。文件名 `HANDFOFF.md` 是用户指定的拼写。

## 1. 新会话先看这里

我们正在维护用户本机的 QBot，源码目录为 `/Users/liu/PersistentAgentWorkspace`。本轮已实现“按会话保存的文件工作区”和“模型生成文件后，在回答末尾提供直达文件的链接”。两个功能都已完成验证。

最近讨论的是为什么生成 Word 失败，以及模型与 QBot 各自负责什么。**Word 生成功能尚未实现，用户目前只询问了原理，没有要求开始实现。** 最后一个请求是写这份交接文档，没有尚在执行的编码任务。

当前分支：`dev/lgc`。当前 HEAD：`52fa0a7 feat:确保api key脱敏`。文件工作区及文件链接的修改仍在工作区中，**尚未暂存或提交**。不要把它们当成无关改动清理，也不要用 reset/restore 覆盖。

## 2. 用户偏好与硬性约束

- 用中文、通俗、简洁地解释；涉及当前行为时，以源码和实际 QBot 记录为准。
- 用户现在从命令行运行 QBot 以便调试，**不要更新安装包，不要运行 `pnpm package:mac`**。
- 用户明确要求：新增功能时使用的临时测试代码不要保留。可以临时编写并运行，结束后删除。不要因此删掉项目已有测试。
- 本轮没有保留新建的测试文件。因新增工具改变了协议目录，只更新了已有测试的必要预期、预算和 golden 数据，已向用户说明。
- 不要恢复百度千帆 OCR。此前用户已经要求撤回那种 PDF 适配路线。
- 模型选择应决定最终回答所用模型。不要自行绕到另一个供应商，也不要把 API Key 发送给其他服务。
- 不要打印 API Key、完整敏感配置或带密钥的请求。历史上修复过短 Key、非标准格式 Key 和供应商错误回显造成的泄露。
- 项目根目录 `AGENTS.md` 要求：声称服务端或会话功能有效前，遵循 `docs/verification/README.md`，**使用隔离 fixture 验证，禁止在用户真实会话和数据上做测试性修改**。诊断时可定向只读查询相关真实记录。
- 不需要反复确认已授权的正常开发动作。用户说“先给方案、不修改”时则严格只分析。

## 3. 更早的背景（用于理解，不代表本轮重新验收过）

用户一直在接入 GPT 中转站、百度千帆、DeepSeek、Qwen、Kimi、自定义 OpenAI-compatible Endpoint，并用不同模型分析论文 PDF。此前处理过：

- HTTP 中转站与安全检查不一致、Responses API 的 reasoning effort 兼容问题。
- PDF 在会话中持续引用、切换模型后的附件能力差异，以及不支持 PDF 的模型退回历史会话的逻辑。
- Kimi 文件解析适配；千帆 OCR 方案后来按用户要求撤回。
- 自定义服务器配置保存、连接检查、真实推理检查的区分；不要求 API Key 特定前缀，不因 `/models` 不可用阻止配置保存，允许手填 Model ID。
- 错误分类与 API Key 脱敏。相关已提交记录包括：
  - `a48f6a7 feat:在新增模型服务器时，可以进行连接测试。注意，出现403报错不代表该服务器无法连接`
  - `52fa0a7 feat:确保api key脱敏`

继续修改这些历史功能前请检查当前源码，不能仅依赖这份背景。尤其不要把下面“文本文件工作区”的容量限制误认为 PDF 上传限制。

## 4. 已完成：会话文件工作区

用户请求：“增加文件工作区，可以让 QBot 生成可保存的代码或 Markdown 格式文件。” 用户明确选择了“每个会话独立保存”。

### 用户可见行为

- 普通聊天及群组聊天顶部增加“文件工作区”入口。
- 文件列表、Markdown 预览、代码展示、编辑、新建、下载、删除。
- 文件按会话隔离，切换模型和重启后保留。
- 支持工具调用的模型可调用 `workspace_file` 直接保存文件。
- 用户也可在回答菜单中选择“将回答保存为 Markdown”，或在代码块菜单中选择“保存到文件工作区”。保存前可以修改文件名和内容。
- 不是自动保存每一次回答。也不是通用的“选中任意一段文字保存”功能：当前入口针对完整回答或一个代码块，打开编辑器后可以调整内容。
- 不支持工具调用的模型仍可通过手动保存输出使用工作区，但不能承诺它能自动读取工作区文件。
- 保存代码不执行代码；HTML 等代码也不会作为活动网页运行。

### 存储与限制

- 文件目录：`DATA_DIR/conversation-files/<threadId>/<filename>`。
- `DATA_DIR` 来自 `OMB_DATA_DIR`，未设置时通常为 `~/.openmausbot`。不要假定任何 fixture 数据目录就是用户数据目录。
- 当前只处理 UTF-8 文本，平铺文件名，不支持子目录。
- 单文件上限 `512 * 1024` 字节；每会话最多 100 个文件，总计 `20 * 1024 * 1024` 字节。
- 常量在 `shared/conversation-files.ts`。工具描述、错误文案和界面提示也包含数值，后续调整限制时需要同步。
- 文件更新与删除必须携带当前 `revision`（内容 SHA-256）；同名创建、过期版本覆盖会返回 409。
- 检查路径、文件名、目录、符号链接、硬链接和大小；读操作有界，下载按附件返回，带 nosniff/sandbox 头。
- UTF-8 BOM 保留，避免下载正文与 Content-Length 不一致。
- 目前删除会话时，`server/host/delete-leftovers.ts` 会清理其 `conversation-files` 目录。重启、切换模型不删除文件；“删除会话”不是永久保留文件的保证。

### API 与模型工具

公开界面 API：`/api/threads/:threadId/workspace-files`

- `GET`：列出文件；带 `name` 读取内容；带 `download=1` 下载。
- `POST`：`{ name, content, revision? }` 创建或更新。
- `DELETE`：`{ name, revision }` 删除。
- 复用全局鉴权、会话可见性和写权限检查，另有云端会话归属及维护状态检查。

模型内部 API：`POST /api/internal/workspace-files`

- 工具名 `workspace_file`，动作 `list`、`read`、`write`。
- 绑定当前内部 capability 的会话，不能由模型随意指定其他会话。
- 复用现有 agents 工具目录、调用桥与 Adapter，没有另造模型调用链。
- 新工具加入 bridge 的常用工具列表。
- `agents-blank-arguments.ts` 处理严格工具协议可能给出的空/null `name`、`revision`，同时保留空字符串文件内容的合法性。

## 5. 已完成：回答末尾的文件直达链接

用户随后要求：模型生成文件后，在回答末尾增加链接，点击直接跳到文件工作区对应文件。

### 实现原则与数据流

链接由 QBot 根据**实际成功的保存结果**生成，不依赖模型自行写 Markdown 链接，也不把模型声称“已保存”当作证据。

1. `conversationFilesInternal()` 写入成功后触发 `saved(name)`。
2. `server/index.ts` 用 `workspaceFilesByTurn` 按会话和 provider turn 记录文件名。
3. 在已有 `landParkedFiles()` 流程中取出本轮文件名，通过 `landTurnFiles()` 放到本轮最后一条机器人回复。
4. 文件名保存为消息元数据 `workspaceFiles?: string[]`，持久化到消息数据库。
5. `ConversationFileLinks` 在回答底部显示“打开文件：xxx”。点击调用当前会话 provider 的 `openFile(name)`。
6. 工作区弹窗按 `initialFile` 直接读取、选中并预览目标文件。

### 已处理的边界

- 一轮生成多个文件，分别提供入口；同名去重。
- 保存失败和仅读取文件不产生新的成功链接。
- 后续普通回答不继承上一轮的文件链接。
- 待附加文件只落到对应轮次；清理时丢弃不匹配的旧 turn 记录，避免串到其他回复。
- 只有文件、没有最终文字回复时，生成可显示的“文件已保存”消息。
- 链接是消息元数据渲染出来的，**没有往模型原始回答末尾直接拼字符串**。所以不会破坏代码围栏、Markdown 或模型原文。
- `shared/wire.ts` 和 `src/state/store.tsx` 都声明了 `workspaceFiles`。前端 Message 不是完整继承 WireMessage，漏改前端类型会报错。
- 点击只在消息所属的当前会话打开文件，避免使用另一会话的工作区。
- 文件删除或不可访问后，弹窗显示明确错误，不会自动打开另一个文件。
- 链接重启后保留，打开的是该名称文件的当前内容，不是历史版本快照。
- 这套自动链接只针对模型通过内部工具成功保存的文件；手动保存回答/代码不会自动给历史消息补链接，也没有对功能上线前的旧回复做关联回填。

## 6. 主要代码入口

| 文件 | 用途 |
| --- | --- |
| `shared/conversation-files.ts` | 文件元数据、写入请求类型、容量限制 |
| `server/conversation-files.ts` | 持久存储、路径安全、版本冲突、模型提示词 |
| `server/routes/conversation-files.ts` | 工作区公开 API、内部模型 API、成功保存回调 |
| `server/drivers/agents-catalog.ts` | `workspace_file` 工具定义 |
| `server/drivers/agents-call.ts` | 将工具调用转发给内部 API |
| `server/drivers/agents-bridge.ts` | 常用工具列表 |
| `server/drivers/agents-blank-arguments.ts` | 严格工具调用的空可选参数处理 |
| `server/index.ts` | API 注册、普通/群组提示词、按 turn 归集文件名、消息落盘 |
| `server/host/turn-attachments.ts` | 给本轮最后回复附加文件引用及无回复兜底 |
| `server/request-auth.ts` | 新公开 API 的 client scope 声明 |
| `server/host/outside-fence.ts` | 允许受限会话访问其自身的工作区内部路由 |
| `server/host/delete-leftovers.ts` | 删除会话后清理文件工作区 |
| `shared/wire.ts`、`src/state/store.tsx` | 持久消息及前端消息的 `workspaceFiles` 字段 |
| `src/lib/conversation-files.ts` | 工作区 React Context，含打开指定文件能力 |
| `src/components/ConversationFiles.tsx` | Provider、入口、文件链接、列表、编辑与预览弹窗 |
| `src/components/ChatView.tsx` | 普通聊天工作区入口及回答下方文件链接 |
| `src/components/GroupView.tsx`、`RoomHeader.tsx` | 群组聊天对应入口及链接 |
| `src/components/CodeBlock.tsx` | 代码块保存到工作区 |
| `src/components/message-menu.tsx` | 完整回答保存为 Markdown |
| `src/locales/en.json`、`zh.json` | 新界面文案、链接文案、缺失文件提示 |

本轮更新过的既有测试/快照：

- `server/drivers/agents-bridge.test.ts`
- `server/drivers/agents-catalog-wire.test.ts`
- `server/drivers/agents-catalog-goldens/full.tools-list.json`
- `server/drivers/agents-catalog-goldens/profiles.json`

新增工具会改变工具清单的名称、数量、字节预算和 SHA-256。golden 测试提供 `UPDATE_AGENTS_CATALOG_GOLDENS=1` 更新机制；要检查差异并同步明确的预算，不要为了过测试删除校验。

## 7. 已完成的验证及其边界

已通过 `pnpm typecheck`、相关文件的 oxlint 和 `git diff --check`。

相关测试多次运行通过，例如：

- 文件工作区阶段一次运行 7 个测试文件、379 项测试通过。
- 文件链接阶段 4 个测试文件、78 项测试通过，覆盖已有 turn attachment 和聊天界面回归。
- 这些是不同轮次的测试结果，不应相加或宣传为全仓库测试全部通过。

临时定向验证覆盖：

- 持久存储、跨会话隔离、空文件、大小及数量限制、路径穿越、符号链接/硬链接、BOM、版本冲突。
- 成功写入才生成链接、读取/失败不生成、同名去重、最后回复归属、无文字回复兜底、原始代码围栏不受影响。

实际隔离服务验证：

- 使用 `launchVerificationServer` 和 `runControlOmb` 启动临时 QBot，与本地模拟 OpenAI-compatible 服务交互。
- 模型工具写入文件；切换模拟模型后读取同一文件。
- 真正关闭并重启隔离服务器，确认文件、编辑结果及消息中的链接仍在。
- 两个文件的链接只挂到本轮最终回复；下一轮普通回复不带旧链接。
- 通过 CUA 打开真实 React 界面的隔离预览，验证文件列表、预览、编辑保存、下载，以及点击 Markdown/Python 两种链接直接选中不同目标文件。
- **这些是隔离本地服务和模拟模型的验证，不是本轮使用用户真实 API Key 执行的多供应商验收。**

所有本轮临时测试脚本、fixture handle、临时数据及测试下载文件均已清理；隔离服务已关闭。`/private/tmp` 可能还保留测试输出日志，系统可自行清理，项目没有新增永久测试脚本。

复验时：先读 `docs/verification/README.md`。可复用 `scripts/control-omb.ts` 的隔离启动器及 `scripts/testing/preview-fixture.ts` 的 `mountPreview`。所有变更性请求必须指向启动器给出的明确 URL，不要默认为用户正在使用的 8799 或 5199 端口。

一个测试经验：模拟模型故意触发工具错误后，QBot 可能给它追加纠错消息或重试。不要用“最后一个 user 消息之后有几个工具结果”作为永不变化的脚本状态，否则可能重复工具调用 ID，制造与功能无关的测试失败。

## 8. 最近诊断：为什么提示部分完成

用户贴出：

> Stopped because the tool call “agents_select_computer” failed. The bot's reply isn't proof the work was done; the failed step shows the error.

已定向只读检查真实 `~/.openmausbot/messages.db`。2026-11-17 14:22 左右，该轮真实请求是“将摘要翻译成中文，并保存为 Word 文件”。查到：

- 之前的 Markdown 研究报告已通过 `agents_workspace_file` 成功保存，文件确实存在，回答也带 `workspaceFiles`。
- 随后的 Word 请求中，模型调用 `agents_select_computer`，参数 `surface: "auto"`。
- 工具实际返回：`No configured computer or browser is available. Open the Screen panel to set one up.`
- 模型随后说明无法生成 Word 附件，并给出了中文译文。因此译文有了，但 `.docx` 未生成。
- `server/index.ts` 的 `/api/internal/computer/select` 在没有可用环境时返回 409。
- `server/drivers/openai-chat.ts` 在工具仍有失败时，会通过 `server/drivers/tool-failure.ts` 产生上述错误，界面显示“部分完成”。这是对未完成步骤的提示，不能仅因模型有最终文字就视为任务完成。

本次诊断没有修改代码，也没有擅自配置、安装电脑执行环境。不要把它误诊成 PDF 上传失败、API Key 问题，或文件直达链接功能失效。

## 9. 已向用户解释清楚的能力分工

- **生成代码文本和 Markdown 文本，是模型的能力；把它们持久保存为文件，是 QBot 工具的能力。**
- 模型“自主保存”实际上是调用 QBot 的保存工具，由 QBot 执行写入。
- 普通模型 API 通常返回文本或工具调用指令，不能假设它会自带一个可下载的 Word 附件。
- Word `.docx` 不是普通文本文件，需要文档生成/转换过程；不能只将文本后缀改为 `.docx`。
- 当前 `workspace_file` 是 UTF-8 文本写入工具，没有 `.docx` 编码能力。即使文件名能写成 `.docx`，也不意味着它是有效 Word 文件。
- 可以给 QBot 增加文档生成工具：模型输出内容与结构，QBot 生成真正 `.docx`，再保存并显示链接。这样的方案可以不依赖桌面控制。

## 10. 下一步建议（尚未获准开始实现）

首先响应新会话里用户实际提出的任务，不要自动把讨论中的 Word 能力当成已经授权的编码任务。

如果用户要求增加 Word 生成功能，建议：

1. 检查仓库已有的文档生成依赖和能力，尽量复用；不要重写模型 Adapter。
2. 设计明确的文档生成工具或导出动作，接收 Markdown 或受约束的结构化内容，在 QBot 后端生成真正 `.docx`。避免执行模型任意代码来完成基本导出。
3. 当前工作区存储、读取和预览均以 UTF-8 文本为前提。需要设计二进制文档的存储、元数据、下载、预览或来源内容编辑方式，**不能直接把二进制塞进当前 content 字段**。
4. 明确 Word 文件的容量限制、扩展名与 MIME 校验、同名/版本处理。考虑保留 Markdown 源，方便后续模型修改和重新生成。
5. 复用当前“成功生成 → 本轮文件引用 → 回答末尾链接”的链路，只有文件真实生成成功才显示入口。
6. 生成的 `.docx` 要验证格式及关键内容，必要时渲染检查；测试仍使用隔离数据，临时测试代码用完删除。

如果用户只要求排查或解释，则保持只读，不自行扩展功能。

## 11. 启动与交付注意事项

- 源码脚本：`pnpm dev:server` 运行服务端；`pnpm dev` 运行 Vite；`pnpm dev:desktop` 是桌面开发入口。应结合用户现有启动方式，不要擅自关闭用户应用或额外启动一套真实数据实例。
- 后端修改后，用户需要重新启动其命令行运行的 QBot 才能加载新逻辑；前端可由 Vite 热更新，但不要把前端热更新说成服务端也已更新。
- 用户已被告知无需重新打包。不要构建安装包、发布、推送或提交，除非后续明确要求。
- 交付时说明实际完成内容、验证范围、当前限制。不要把模型口头承诺当作文件生成成功，也不要把模拟测试描述为真实供应商测试。

