# PersistentAgentWorkspace

> Agentic Infrastructure for Persistent AI Employees

**PersistentAgentWorkspace** 是清雁 QLab 面向桌面工作环境的持久化 AI Agent 工作空间。

我们希望 Agent 不只是一次性的对话助手，而是能够围绕长期目标持续工作：理解任务、调用工具、维护上下文和记忆、协同执行、处理打断，并在获得新反馈后继续推进。

项目优先支持**中文交互**，同时保持多语言与多模型扩展能力；以本地桌面应用为首个落地载体，逐步形成面向个人工作流与 AI Employees 的统一 Agentic Runtime。

---

## Vision

从一次性问答走向持续执行：

```text
User Goal
    ↓
Understand & Plan
    ↓
Delegate / Execute
    ↓
Observe & Verify
    ↓
Update Task State & Memory
    ↓
Continue / Recover / Replan
    ↓
Deliver Verifiable Result
```

重点不在于让 Agent 调用更多工具，而在于让它能够回答：**正在做什么、已经完成什么、依据什么认为完成、被打断后如何继续，以及哪些经验值得保留。**

## Architecture

以下是目标架构，部分模块仍处于设计或接入阶段。

```text
┌────────────────────────────────────────────────────────────┐
│ Desktop Workspace · Chinese-first / Multilingual UI        │
│ Chat · Tasks · Projects · Approvals · Notifications         │
└──────────────────────────┬─────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────┐
│ Persistent Agent Runtime                                   │
│ Planner · Delegation · Task Lifecycle · Interrupt/Resume   │
│ Tool Routing · Permissions · Execution Events              │
└─────────────┬────────────────────┬─────────────────────────┘
              │                    │
┌─────────────▼──────────────┐  ┌──▼────────────────────────┐
│ Memory & Context           │  │ Execution & Verification   │
│ Session / Project / Global │  │ Tools / Browser / Desktop  │
│ Recall · Revision · Scope  │  │ Evidence · Retry · Replan  │
└─────────────┬──────────────┘  └──┬────────────────────────┘
              │                    │
              └─────────┬──────────┘
                        ▼
             Agentic Data & Evaluation
             Traces · Failures · Recovery
                        │
             Model / Runtime Improvement
```

### Core Components

| Component | Responsibility | 当前状态 |
|---|---|---|
| Desktop Workspace | 多 Agent 对话、任务展示、审批与交互 | 已有基础实现，待桌面验收 |
| Agent Runtime | 任务调度、工具执行、事件与任务状态 | 已有基础实现，待定制 |
| Planner & Delegation | 拆解任务、分派子任务、协调执行 | 基础能力可用性待验证；角色协议规划中 |
| Memory & Context | 会话记忆、跨会话召回、上下文装配与作用域 | 原生能力已有；增强记忆待集成 |
| Task Continuity | 长期目标、打断恢复、过期结果处理、重新规划 | 规划中 |
| Verifier | 独立校验执行结果与副作用 | 规划中 |
| Agentic Data Engine | 执行证据、失败诊断、恢复轨迹与评估闭环 | 规划中 |
| Model Adapter | 接入不同模型与兼容服务 | 已有基础接口；具体模型需验证 |

## Design Principles

### 1. Task First, Not Chat First

会话是交互入口，**Task 才是持续工作的核心对象**。目标是让任务拥有独立的状态、执行历史、责任 Agent 和恢复信息，不因对话窗口关闭而失去上下文。

### 2. Memory with Scope and Provenance

记忆需要区分个人偏好、项目事实、任务上下文与经过验证的执行经验。长期记忆不能只依赖相似度检索；还需要来源、更新时间、版本和权限边界。

### 3. Execution Must Be Verifiable

区分 Agent 声称完成、工具调用成功、外部系统产生效果，以及独立证据确认完成。每次重要执行应能够回溯到输入、动作、观察和结果。

### 4. Interruption and Recovery Are First-class

人类修改目标、工具失败、网络断开、Agent 重启或环境变化都应被视为正常工作情形。Runtime 需要逐步具备暂停、恢复、重规划和防止过期结果覆盖的能力。

### 5. Separate Agent Intent from Execution Backend

Planner 通过稳定的 Tool / Capability Contract 调用浏览器、桌面、文件与外部服务。具体模型和执行后端可以替换，而任务状态与验证协议应保持稳定。

### 6. Chinese-first, Multilingual by Design

优先保证中文用户的完整体验，包括交互、错误提示、审批、记忆、时间格式与输入法；同时保留可扩展的国际化体系，而不是实现一个只支持中文的独立分支。

---

## Persistent Task Lifecycle

目标流程（尚非当前版本完整实现）：

```text
Goal Created
     ↓
Task Planned → Assigned
     ↓
Running ──────────────┐
  │                   │
  ├─ Needs Input      ├─ Interrupted / Paused
  │                   │
  └─ Tool Result      └─ Resume with State Check
          ↓                    │
     Verification ◄────────────┘
          │
     ├─ Verified → Commit Progress → Continue / Complete
     └─ Failed   → Diagnose → Retry / Replan / Escalate
```

长期目标是建立可追溯的 Task State、Execution Epoch 和 Commit Ledger，避免任务恢复后使用过期上下文或重复执行有副作用的操作。

## Multi-Agent Collaboration

项目计划围绕四类工作职责组织协作，而不是把所有行为塞进一个单体 Agent：

| Role | Focus |
|---|---|
| Project Lead | 目标澄清、任务规划、分工与进度汇总 |
| Researcher | 信息检索、证据整理、事实核查 |
| Executor | 工具调用、桌面及外部系统执行 |
| State Guardian | 状态跟踪、恢复决策、结果验证与风险控制 |

这些是**目标角色定义**，并不意味着当前版本已实现完整的四角色协同协议。

## Memory and Learning Loop

```text
Interaction / Execution
          ↓
Structured Events & Observations
          ↓
Candidate Memory / Experience
          ↓
Scope · Provenance · Verification
          ↓
Recall / Context Assembly
          ↓
Future Task Decisions
```

我们会优先跑通单用户、单项目的可验证记忆闭环，再扩展到跨 Agent 和跨项目场景。语义记忆与真实执行成功证据必须分离管理。

---

## Quick Start

当前开发基线以 **macOS（Apple Silicon）** 为主要验证环境。

**Requirements**

- Node.js 24+
- pnpm 10.33.0
- Git
- macOS 开发环境及 Xcode Command Line Tools（桌面开发）

```bash
git clone git@github.com:Qingyan-QLab/PersistentAgentWorkspace.git
cd PersistentAgentWorkspace

corepack enable
pnpm install --frozen-lockfile

# Static checks
pnpm typecheck
pnpm i18n:check
node scripts/pa-locale-gate.mjs --report-only

# Memory adapter unit tests (mocked)
node --test extensions/memory/memhub-loopback.test.mjs
```

开发入口：

```bash
pnpm dev          # Web UI development server
pnpm dev:desktop  # Electron development entry (requires local dependencies)
```

> 桌面端到端运行仍在验证中；`dev:desktop` 可能需要下载或准备系统辅助组件。请勿把开发脚本启动等同于完整 Agent 任务链路通过。

## Repository Structure

以下仅列出现有的主要目录，未来会随模块拆分持续演进。

```text
PersistentAgentWorkspace/
├── src/                    # Desktop UI and application state
├── electron/               # Desktop shell and native integration
├── server/                 # Agent runtime, tools, memory and services
├── shared/                 # Shared contracts and types
├── companion/              # Companion services and clients
├── extensions/
│   └── memory/             # Experimental memory adapter
├── scripts/                # Development, checks and tooling
├── docs/                   # Design and engineering documentation
├── package.json
└── pnpm-lock.yaml
```

## Development Roadmap

### G0 — Engineering Baseline

- [x] 建立独立仓库与初始工程结构
- [x] 完成依赖安装、TypeScript 与 i18n 基础检查
- [x] 建立中文覆盖率检查
- [x] 建立记忆适配器的模拟单元测试
- [ ] 完成 Electron 桌面端到端启动验收
- [ ] 归类并处理影响首版核心路径的测试失败
- [ ] 清理或替换遗留产品遥测配置

### V0.1 — Chinese-first Desktop Agent

- [ ] 补齐首版核心中文界面和错误提示
- [ ] 验证 Agent 创建、任务执行、工具审批及本地记忆
- [ ] 建立稳定的中文端到端回归用例

### V0.2 — Persistent Memory & Tasks

- [ ] 增强跨会话记忆召回及版本管理
- [ ] 建立 Task State / Epoch / Recovery Contract
- [ ] 支持失败恢复、用户打断与执行证据追踪

### V0.3 — Multi-Agent Workspace

- [ ] 定义多角色任务协议与权限模型
- [ ] 建立 Project-level Context 和任务协作机制
- [ ] 引入 Verifier 与 Agentic Data Engine 闭环

### Longer Term

- [ ] 流式多模态交互与主动任务推进
- [ ] 模型后训练、自有模型接入与经验驱动改进
- [ ] 与物理世界 Agent Runtime 的任务级协同

## Current Baseline

截至 G0 初始工程验收：依赖安装、TypeScript 检查及 i18n 校验通过；核心中文 UI 翻译键覆盖率约 **85.6%**；记忆适配器模拟测试 **3/3** 通过。上游全量 Vitest 曾出现 **22 项失败**（并非全部测试通过），桌面端到端验收及真实长期记忆服务接入仍待完成。

项目遵循**小范围真实执行 → 记录失败 → 修复验证 → 沉淀接口与经验**的迭代方式，不以尚未完成的架构规划替代实际交付状态。

## Related Project

- [PhysAgentRuntime](https://github.com/Qingyan-QLab/PhysAgentRuntime) — Agentic Infrastructure for the Physical World

两个项目各自独立演进：PersistentAgentWorkspace 面向桌面工作流、持久任务与 AI Employees；PhysAgentRuntime 面向机器人和物理环境中的 Agent 执行。未来可通过明确的 Task、Tool、Observation 和 Result Contract 对接。

## Licensing and Notices

项目代码及第三方组件的使用、修改和分发须遵守仓库中的 `LICENSE`、`LICENSING.md`、`NOTICE` 与 `third_party/` 授权说明。工程来源与版本记录保存在 `UPSTREAM_LOCK.json`、`SOURCE_ARCHIVE_PROVENANCE.txt` 及 `docs/upstream/`，请勿删除这些合规材料。
