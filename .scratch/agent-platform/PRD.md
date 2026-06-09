# Agent 自动开发平台 PRD

Status: ready-for-agent

Version: v0.2-team-review

## 问题陈述

软件团队希望 agent 能在尽量少的人类参与下完成需求开发和 bug 修复，但简单的 prompt 链条不足以支撑真实的软件交付。需求需要澄清，任务需要拆解，接口需要先达成一致，代码变更需要隔离，测试需要证明行为正确，失败需要沉淀成可处理的缺陷，并且每一次 agent 行为都必须可审计。

PatchPilot 应提供一个以 Codex 为开发执行基座的 agent 交付控制平台。平台需要让用户提交一个简单需求或需求文档，经过 `grill-me` 式逐轮澄清对话后生成已确认 PRD，再把 PRD 拆成工作项，定义接口契约，调度 Codex 驱动的 agent 到隔离工作区执行，运行测试，创建 Pull Request，管理缺陷，并持续返工直到需求完成。

这个平台同时要满足两个看似冲突的目标：

- 对普通用户像短视频产品一样简单：一个输入框、少量模板、像 Codex CLI 一样一问一答的澄清窗口、订单式进度、清楚的确认按钮。
- 对工程团队足够可靠：状态机、worktree/container 隔离、测试质量门、PR 边界、权限、预算、审计和失败恢复都必须可执行。

## 产品定位

PatchPilot 是 agent 交付控制面，不是聊天式多 agent demo，也不是 Jira/Linear 的完整替代品。

平台应该把复杂工程治理藏在后台，把普通用户体验设计成“提交想法 -> 确认需求 -> 等待执行 -> 查看结果 -> 接受或要求修改”。专业用户可以展开技术细节，查看 PRD、工作项、测试、PR、日志、成本、审计和 agent run。

## 目标用户

### MVP 第一目标用户

有现有代码仓库和基础测试套件的小型工程团队维护者或技术负责人。他们能连接仓库、理解 PR 和测试结果，也愿意让 agent 完成小到中等复杂度的开发任务。

### 次要用户

- PM / 需求提交者：用自然语言、截图、录屏或文档提交需求。
- QA / 测试负责人：关注验收标准、测试覆盖、缺陷复现和回归结果。
- 开发者：关注 PR、diff、测试失败、冲突和返工。

### 暂缓到后续阶段的用户

安全负责人、财务负责人、企业管理员和合规审计人员不是 MVP 的主要交互对象。MVP 需要记录他们未来需要的数据，但不需要先做完整企业控制台。

## 产品模式

### 普通模式

普通模式隐藏内部术语，默认展示：

- 想法
- 需求说明
- 任务
- 开发中
- 测试中
- 等待确认
- 发现的问题
- 历史记录

普通模式不默认展示 PRD、WorkItem、InterfaceContract、AgentRun、WorkspaceRun、AuditEvent、Temporal、worktree 或 Pull Request 等术语。

### 专业模式

专业模式面向工程团队，展示：

- PRD 和版本
- 工作项和依赖
- 接口契约
- AgentRun / WorkspaceRun / TestRun
- Pull Request
- 测试日志和 artifact
- 成本、预算、审批和审计事件

## 极简上手体验原则

1. **一个输入框启动一切**：首屏主输入为“你想让 PatchPilot 做什么？”，支持文字、截图、录屏、文件、链接和报错粘贴。
2. **模板优先**：提供“做新功能”“修 bug”“改页面”“上传需求”四个 MVP 模板，避免用户从空白开始。
3. **逐轮澄清，不限制三问**：需求澄清采用 `grill-me` 规则，一次只问一个问题，每题提供推荐答案。平台应沿着设计决策树追问，直到能形成共享理解和可验收 PRD；如果问题可通过读取代码或文档回答，平台应自行探索而不是问用户。
4. **默认先跑，复杂后显**：平台自动选择流程、agent、测试范围、预算、工作区和 PR 策略，高级设置折叠。
5. **订单式进度**：执行页只显示 5 个阶段：理解中、计划中、开发中、测试中、等待确认。
6. **错误反馈可行动**：失败时先展示“发生了什么、影响什么、推荐下一步”，再提供“自动重试”“缩小范围”“交给人工”“查看技术详情”。
7. **信任来自证据摘要**：完成页默认展示改了什么、如何预览、测试结果、风险等级、耗时/成本和需要用户确认的点。
8. **移动端只做关键动作**：移动端支持提交需求、回复澄清、查看进度、预览结果、批准或驳回，不承载完整控制台。
9. **专业能力渐进暴露**：技术细节必须可查，但不能阻塞普通用户完成主流程。

## 首次使用路径

1. 用户连接仓库或导入项目。
2. 平台自动检测技术栈、启动命令、测试命令和仓库状态。
3. 用户从一个输入框或模板提交需求。
4. 平台以对话窗口逐个提出澄清问题，并给出推荐答案；用户可以接受推荐、修改答案或继续补充。
5. 平台生成一页简版需求确认，包含“要做什么、不做什么、如何验收”。
6. 用户点击“开始执行”。
7. 平台创建工作项、隔离工作区和 agent run。
8. 用户在订单式进度页查看状态。
9. 完成后，平台展示变更摘要、预览方式、测试结果、风险提示和确认按钮。
10. 用户选择“接受”或“要求修改”。

## 解决方案

平台应协调从需求进入到最终验收的完整生命周期：

```text
需求或 bug 报告
  -> grill-me 式逐轮需求澄清
  -> 已确认 PRD
  -> 垂直工作项拆解
  -> 接口契约定义
  -> 隔离 agent 工作区
  -> 按 TDD 完成前端 / 后端 / 测试实现
  -> 测试、契约检查和代码审查
  -> Pull Request
  -> diagnose 式缺陷复现、诊断和返工循环
  -> 最终验收
```

平台默认最多保留两个人类参与点：

1. 需求澄清和 PRD 确认。
2. 整体流程完成后的最终验收。

额外的人类介入只应发生在明确的控制门上：低置信度、高风险、破坏性接口变更、生产数据、危险操作、预算耗尽、工作流连续失败、发布审批或回滚审批。

## MVP 范围边界

MVP 应收敛为单仓库、单项目、一个主要交付闭环：

- 使用本地 `.scratch/` Markdown 作为 PRD 和工作项事实源。
- 用户可以通过一句话、模板或文档提交需求。
- 系统通过逐轮澄清对话生成简版需求确认和完整 PRD。
- 系统生成 1-4 个垂直工作项，优先覆盖后端、前端、测试和运维角色。
- 系统生成 HTTP、事件流和共享状态三类接口契约，供前端、后端、测试和运维 agent 并行开发前对齐。
- Codex worker 执行一个工作项，创建独立 worktree、分支和 Pull Request 交付边界。功能开发类工作项只用短 prompt 点名 `/tdd`，具体约束由任务文件、AGENTS.md 和质量门承载。
- 执行项目配置的测试命令。
- 记录 `AgentRun`、`WorkspaceRun`、`TestRun`、`PullRequest`、`ReviewRecord`、`AuditEvent`、成本和失败原因；MVP 的 JSON 快照会把这些证据作为一等记录暴露给 UI 和 E2E。当前可运行 MVP 先生成 `local://pull-requests/...` 本地 PR 记录和 PR body，后续 GitHub Adapter 再负责 push 分支和创建真实 GitHub PR。
- Reviewer agent 输出审查摘要，并写入关联 PR、测试摘要、风险和发现项的 `ReviewRecord`。
- 人类最终接受或要求返工。

Bug 复现和自动返工闭环进入 MVP：bug 报告先生成测试 agent 复现任务，复现成功后自动生成开发 agent 修复任务。bug 修复相关工作项只用短 prompt 点名 `/diagnose`，平台用复现证据、回归测试和质量门确认它真的完成了 Reproduce -> Minimise -> Hypothesise -> Instrument -> Fix -> Regression-test。

## 用户故事

1. 作为普通用户，我想用一句话描述要做的功能，以便平台自动生成可确认的需求说明。
2. 作为普通用户，我想通过截图、录屏或报错提交问题，以便不懂代码也能表达需求。
3. 作为普通用户，我想在一个对话窗口里逐个回答澄清问题，并看到每题推荐答案，以便需求被充分确认但交互仍然简单。
4. 作为普通用户，我想看到订单式进度，以便知道平台正在做什么、是否需要我处理。
5. 作为普通用户，我想在完成页看到改动摘要、预览方式、测试结果和风险提示，以便决定接受或要求修改。
6. 作为产品负责人，我想保留 PRD 版本，以便后续变更可以追溯到已批准需求。
7. 作为项目负责人，我想把 PRD 拆成可独立领取的工作项，以便多个 agent 能安全并行工作。
8. 作为项目负责人，我想让工作项尽量是垂直切片，以便每个完成项都可以单独演示和测试。
9. 作为后端工程师，我想在并行开发开始前定义接口契约，以便前端和后端 agent 不发生偏移。
10. 作为前端工程师，我想获得生成的客户端契约或共享类型，以便前端实现遵循已批准接口。
11. 作为测试工程师，我想把验收标准映射到测试用例，以便验证活动能追溯到 PRD。
12. 作为开发 agent，我想领取一个已就绪的工作项，以便我能在不影响其他 agent 的情况下工作。
13. 作为开发 agent，我想拥有隔离的 worktree 和容器，以便我的代码变更和依赖不会影响其他任务。
14. 作为测试 agent，我想运行与工作项相关的测试套件，以便在审查前发现失败。
15. 作为 reviewer agent，我想检查 diff、测试、契约和日志，以便标记有风险的 Pull Request。
16. 作为维护者，我想让每个 agent 的代码产物都通过分支和 Pull Request 交付，以便 Git 成为审查和回滚边界。
17. 作为 bug 反馈用户，我想从 UI、CLI 或 Markdown 添加缺陷，以便 agent 可以复现并修复。
18. 作为 bug 复现 agent，我想在修复开始前创建或确认失败复现，以便修复针对真实失败。
19. 作为平台运维者，我想查看 agent run 的 prompt、工具调用、diff、测试、成本和状态，以便审计发生了什么。
20. 作为安全负责人，我想让 agent 使用最小权限凭证，以便单个任务被攻破时无法访问无关系统。

## MVP 验收标准

- 用户提交需求后，系统能按 `grill-me` 规则完成逐轮澄清：一次只问一个问题、每题给推荐答案、持续追问直到满足 PRD 生成条件，并生成可版本化 PRD。
- PRD 被批准后，系统能生成 1-4 个垂直工作项，每个工作项包含角色、范围、非目标、验收条件和测试建议。
- Codex worker 只能在独立 worktree 中修改代码，不能直接改主分支。
- 每个 agent run 必须记录 prompt、模型、工具调用、diff、测试、日志、成本、状态和失败原因。
- 测试失败必须生成可追踪的失败记录，并关联 commit、工作项和 agent run。
- PR 描述必须包含需求链接、工作项链接、测试结果和 reviewer agent 摘要；当前 MVP 至少以本地 PullRequest 记录形式展示在运行页和验收页。
- 每个成功的 agent run 必须生成 ReviewRecord，关联 PullRequest、测试摘要、风险等级和 reviewer 发现项。
- 预算耗尽、连续失败、危险操作、破坏性契约变更必须进入审批状态。
- 最终验收必须能明确标记 accepted / rejected，并保留原因。
- 普通用户无需理解 PRD、worktree、AgentRun 或 Pull Request，也能完成提交、确认、查看进度和验收。

## 系统架构

PatchPilot 应由以下模块组成：

| 模块 | 责任 |
| --- | --- |
| Control Plane API/UI | 提供普通模式和专业模式的产品入口 |
| Workflow Engine | 执行持久化状态机、重试、暂停、恢复和审批等待 |
| Scheduler / Queue | 分发可执行工作项，控制并发、租约和预算 |
| Codex Worker | 通过 CodexRunner 执行开发、修复、测试或审查任务 |
| Workspace Manager | 创建、清理和快照 worktree/container |
| Test Runner | 执行目标测试、契约测试、冒烟测试和回归测试 |
| Contract Registry | 保存 OpenAPI/AsyncAPI/schema 契约和兼容性结果 |
| PR Adapter | 创建分支、提交、Pull Request 和 PR 摘要 |
| Approval Service | 管理人工或策略审批 |
| Audit/Event Store | 保存不可变事件、agent run、工具调用和状态变化 |
| Artifact Store | 保存日志、截图、trace、测试报告、diff 和预览产物 |

## Matt Pocock Skills 嵌入规则

平台应把 Matt Pocock skills 作为流程约束来源，而不是把大量模板塞进 prompt。实际给 Codex 的提示词要尽量短，只给任务名、任务文件、必要 skill 和安全边界，让 AI 基于仓库上下文、任务文件、测试和 AGENTS.md 自主完成。

| 流程节点 | 必用 / 推荐 Skill | 平台行为 |
| --- | --- | --- |
| 需求澄清 | `/grill-me` | 一次只问一个问题，每题给推荐答案；沿决策树追问；能通过代码探索回答的问题不问用户；直到形成共享理解和 PRD |
| 功能开发 | `/tdd` | prompt 只写“使用 /tdd”；平台通过测试建议和质量门要求先有行为测试、再实现、再重构 |
| Bug 修复 | `/diagnose` | prompt 只写“使用 /diagnose”；平台通过复现证据、失败摘要和回归测试证明修复有效 |
| 文档转任务 | `/to-prd`、`/to-issues` | 将需求文档转为可版本化 PRD 和可独立领取的垂直工作项 |
| 架构风险 | `/zoom-out`、`/improve-codebase-architecture` | 当 agent 发现测试 seam 不足、模块耦合或长期返工时，生成架构改进建议或 ADR |
| 代码实现 | `/tdd` + 项目 AGENTS.md | 遵守项目本地规则、测试策略和工作区权限 |

## 状态机

| 实体 | 状态 |
| --- | --- |
| Requirement | submitted -> clarifying -> prd_draft -> approved / rejected |
| PRD | draft -> in_review -> approved -> superseded / archived |
| WorkItem | proposed -> ready -> claimed -> running -> review -> blocked -> done / cancelled |
| InterfaceContract | draft -> approved -> breaking_change_pending -> deprecated |
| AgentRun | queued -> running -> needs_approval -> succeeded / failed / cancelled |
| WorkspaceRun | preparing -> ready -> active -> archived / failed / destroyed |
| TestRun | queued -> running -> passed / failed / blocked / skipped |
| Defect | reported -> needs_repro -> reproduced / unreproducible -> fixing -> verifying -> closed |
| PullRequest | draft -> ready_for_review -> changes_requested -> approved -> merged / closed |
| Approval | requested -> approved / denied / expired |

核心不变量：

- `ready` 的 WorkItem 必须关联已批准 PRD 或已确认 Defect。
- `claimed` 的 WorkItem 必须有未过期 lease 和 `claim_token`。
- `running` 的 AgentRun 必须关联一个 WorkspaceRun。
- 产生代码的 AgentRun 必须通过 Pull Request 交付。
- `done` 的 WorkItem 必须有通过的 TestRun 或明确的测试豁免记录。
- 高风险动作必须有关联 Approval。

## 并发领取协议

每个 WorkItem 应包含：

- `claim_owner`
- `claim_token`
- `lease_expires_at`
- `heartbeat_at`
- `version`

领取规则：

- agent 只能领取 `ready` 且未被有效 lease 占用的工作项。
- 领取必须使用 compare-and-set 或文件锁保证原子性。
- agent 必须定期 heartbeat。
- lease 过期后，Scheduler 可以回收工作项。
- 写状态时必须校验 `claim_token`，避免过期 agent 覆盖新状态。
- 本地 Markdown MVP 使用文件锁；数据库版本使用乐观锁和唯一约束。

## Codex 执行规格

平台应通过 `CodexRunner` 适配器封装 Codex，避免业务流程直接绑定某一种调用方式。

`CodexRunner` 最小接口：

- `start(task, workspace, capability_manifest)`
- `resume(agent_run_id, prompt)`
- `cancel(agent_run_id)`
- `stream_events(agent_run_id)`
- `collect_artifacts(agent_run_id)`
- `summarize_failure(agent_run_id)`

Codex 集成分工：

- Codex SDK：适合服务端线程控制和长期会话。
- `codex exec --json`：适合 MVP 自动化和 JSONL 事件流采集。
- Codex MCP server：适合让外部 agent 框架把 Codex 当作工具调用。

MVP 可以优先使用 `codex exec --json`，但必须通过 `CodexRunner` 包装，后续可替换为 SDK 或 MCP server。

## 隔离执行规格

每个工作项应创建独立 WorkspaceRun：

- worktree 命名：`patchpilot/<work_item_id>/<run_id>`
- branch 命名：`patchpilot/<work_item_id>-<slug>`
- 只挂载当前 workspace。
- 禁止挂载宿主 home、SSH agent 和 Docker socket。
- 容器默认 rootless、无特权。
- 配置 CPU、内存、磁盘和最长运行时间。
- 网络默认拒绝，按任务 allowlist 放行 Git、包仓库、模型 API 或必要外部服务。
- 默认不注入生产密钥。
- 任务结束后清理进程、端口、临时文件和敏感环境变量。
- 保留必要 artifact，归档或销毁 workspace。

## PR 工作流

- 每个代码变更必须进入独立分支。
- Pull Request body 必须包含需求链接、工作项链接、变更摘要、测试结果、风险说明和 reviewer agent 摘要。
- PR 默认不自动合并。
- PR 更新后应重新运行目标测试。
- 测试失败、契约失败、未解释跳过、Sev1/Sev2 Defect 未关闭时，PR 不得进入可验收状态。
- 冲突或 rebase 失败应转为 blocked，并给出普通语言说明和技术详情。
- 人类最终验收后，平台可以标记 accepted，但合并仍走仓库现有规则。

## 接口契约治理

- HTTP API 使用 OpenAPI。
- 事件 API 使用 AsyncAPI 或等价 schema。
- 契约变更必须生成 contract diff。
- breaking change 必须进入 Approval。
- provider 和 consumer 都应有契约测试记录。
- 生成的客户端 SDK 或共享类型必须关联到 InterfaceContract 版本。
- MVP 只在真实 API 或事件接口发生变化时强制契约流程，不要求所有工作项都有契约。

## 测试策略

测试应通过稳定的公开接口验证外部行为，而不是验证内部实现细节。

| 变更类型 | 最低测试要求 |
| --- | --- |
| UI / 页面变更 | 组件测试或端到端冒烟测试 |
| API 变更 | 契约测试和集成测试 |
| Bug 修复 | 先有失败复现，再新增或更新回归测试 |
| 契约变更 | contract diff、兼容性检查、provider/consumer 测试 |
| 数据迁移 | 迁移前后验证、回滚或补偿说明 |
| 安全敏感变更 | 权限测试、secret scanning、审计记录检查 |

`TestCase` 应至少包含：

- `id`
- 来源 PRD / 验收标准
- 关联 WorkItem / Defect / Contract
- 测试类型和优先级
- 前置条件和测试数据
- 执行命令
- 断言
- owner agent
- 状态
- flaky 状态
- 最近一次 TestRun

`TestRun` 应至少包含：

- commit、branch、PR、workspace
- runner 和环境镜像
- 命令
- 开始/结束时间
- 退出码
- 失败摘要
- 日志、截图、trace、artifact
- 重试次数
- 是否命中 flaky

## 质量门

### PR 质量门

- 新增或修改代码必须有相关测试，或有明确测试豁免。
- 目标测试通过。
- 契约测试通过，或无契约影响。
- 无未解释跳过。
- 无未关闭 Sev1/Sev2 缺陷。
- Reviewer agent 确认测试覆盖了请求行为。

### Bug 复现门

- 修复 agent 领取前应有失败证据：失败测试、最小复现脚本、日志、截图、输入数据或环境快照。
- 无法复现的 bug 只能进入“假设性修复”，并需要 reviewer 或人工审批。
- 修复完成后必须证明“修复前失败、修复后通过”。

### Flaky 策略

- 失败可以有限重试，但不能默认吞掉。
- 连续或概率性失败进入 flaky defect。
- quarantine 必须有 owner、原因和到期时间。
- 关键路径测试不能长期 quarantine。

### 最终验收门

最终验收页必须展示：

- 验收标准覆盖率
- TestCase 通过率
- 未解决缺陷
- flaky 项
- 契约兼容性
- PR 状态
- 审计链路完整性

## 权限、密钥与安全边界

默认策略是 deny by default。每个 AgentRun 使用 per-run `Capability Manifest`，只获得当前 WorkItem 必需的仓库、工具、网络和凭证权限。

必须默认执行：

- agent 只允许写隔离 worktree。
- 禁止直接写主分支。
- 默认无生产密钥。
- 密钥只通过 Secret Broker 注入。
- 优先使用短期 token。
- 凭证读取写入 AuditEvent。
- prompt、日志、diff、测试 artifact 必须做敏感信息扫描和脱敏。
- 网络默认拒绝，云 metadata endpoint 和内网网段默认阻断。
- rootless 容器、无特权、无 Docker socket、资源配额、运行结束销毁。

必须人工审批的动作：

- 生产数据访问。
- 破坏性数据库操作。
- breaking schema 或 breaking API change。
- 依赖源变更。
- 外部网络放行。
- 新密钥授权。
- 发布或回滚。
- 预算超额后继续执行。

## 成本、重试与失败处理

每个 PRD、WorkItem 和 AgentRun 都应有预算。

- 执行前估算成本。
- 达到软阈值时告警。
- 达到硬阈值时暂停。
- 继续执行必须审批。

失败类型：

| 类型 | 处理方式 |
| --- | --- |
| transient | 有限重试，指数退避 |
| deterministic | 停止重试，生成失败摘要 |
| test_failed | 生成 TestRun，必要时生成 Defect |
| policy_denied | 进入 Approval 或失败终态 |
| budget_exhausted | 暂停并请求审批 |
| environment_failed | 尝试重建环境，超过上限后 blocked |

任何循环都必须有最大次数和退出条件，不允许无限返工。

## 数据与审计

`AuditEvent` 必须是追加式记录，至少包含：

- actor 类型和 ID
- target 类型和 ID
- action
- timestamp
- trace ID
- before / after 摘要
- 关联 AgentRun / Approval / TestRun
- prompt 或上下文 hash
- 工具调用摘要

生产化版本应考虑 hash chain、WORM 存储、保留期、访问审计、PII 脱敏和审计导出。

## 核心实体

| 实体 | 用途 |
| --- | --- |
| Requirement | 原始用户请求、文档、想法或 bug 报告 |
| PRD | 已确认且版本化的产品需求文档 |
| WorkItem | Epic、story、task、bug 或 subtask |
| InterfaceContract | OpenAPI、AsyncAPI、schema、SDK、事件或工具契约 |
| TestCase | 可复用的验证资产 |
| TestRun | 一次测试或测试套件执行 |
| Defect | 需要 triage 或修复的已确认失败 |
| Agent | Agent 身份和权限边界 |
| AgentRun | Agent 的一次执行尝试 |
| WorkspaceRun | 某个任务的隔离 worktree / container |
| PullRequest | 代码审查和合并边界 |
| ReviewRecord | reviewer agent 对 PR、测试和风险的审查证据 |
| Approval | 人类或策略审批记录 |
| AuditEvent | 重要动作的追加式审计记录 |

## 产品指标

- 需求到首个 PR 的中位时间。
- 工作项自主完成率。
- PR 首次通过测试率。
- 人类介入次数 / 工作项。
- AgentRun 失败原因分布。
- 成本 / 已接受 PR。
- 缺陷复现成功率。
- 审计完整率。
- 返工轮次中位数。
- 用户最终接受率。

## 路线图

- Phase 0：CLI 原型，单仓库、PRD 到一个 PR。
- Phase 1：MVP，工作项拆解、AgentRun / TestRun / AuditEvent、PR 和测试闭环。
- Phase 2：缺陷复现与自动返工循环。
- Phase 3：极简 UI、状态页、Temporal 持久工作流、并行工作项。
- Phase 4：GitHub / Linear / Jira 集成、企业权限、成本治理、策略审批。
- Phase 5：多仓库、发布审批、回滚、组织级合规。

## 需要 ADR 的技术决策

- ADR-0001：生产工作流引擎选择 Temporal，以及 polling MVP 的退出标准。
- ADR-0002：项目事实源选择 `.scratch/` Markdown、SQLite/Postgres 还是混合事件存储。
- ADR-0003：Codex 集成主路径：SDK、`codex exec --json`、MCP 的分工和适配器接口。
- ADR-0004：worktree + container/sandbox 隔离模型。
- ADR-0005：WorkItem 并发领取与 lease/fencing 机制。
- ADR-0006：InterfaceContract 注册、版本化和 breaking change 策略。
- ADR-0007：PR 分支、review、merge queue、冲突处理策略。
- ADR-0008：AgentRun/AuditEvent 事件模型、日志保留和脱敏策略。
- ADR-0009：凭证、MCP 工具、网络访问和审批门安全模型。
- ADR-0010：测试与契约验证策略，包括目标测试、全量测试、失败沉淀为 Defect 的规则。

## 非目标

- 自动合并到主分支。
- 自动生产发布。
- 完整替代 Jira 或 Linear。
- 第一版实现复杂企业权限。
- 第一版实现多仓库编排。
- 第一版实现完整企业级 UI 控制台。
- 允许多个 agent 同时编辑同一个工作区。
- 默认允许 agent 访问生产密钥。
- 默认展示所有技术细节给普通用户。

## 补充说明

平台不应把多 agent 对话本身当作产品。真正的产品是可靠的交付控制：持久化状态、隔离执行、可复现测试、Pull Request 边界、可审计性和受控的人类审批门。

强 agent-computer interface 比简单增加更多 agent 更重要。Agent 需要结构化工具来完成搜索、文件检查、原子编辑、测试执行、日志摘要、diff 生成和 PR 创建。

普通用户体验必须保持轻量。工程治理应该完整存在，但应默认隐藏在专业视图和审计详情中。

## 参考来源

- Codex SDK: https://developers.openai.com/codex/sdk.md
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive.md
- Codex with Agents SDK and MCP: https://developers.openai.com/codex/guides/agents-sdk.md
- Codex worktrees: https://developers.openai.com/codex/app/worktrees.md
- Codex skills: https://developers.openai.com/codex/skills.md
- mattpocock/skills: https://github.com/mattpocock/skills
- OpenHands: https://docs.openhands.dev/
- SWE-agent: https://swe-agent.com/
- Temporal: https://docs.temporal.io/
- LangGraph: https://docs.langchain.com/oss/python/langgraph/overview
- GitHub Copilot coding agent: https://docs.github.com/en/copilot/concepts/agents/cloud-agent/about-cloud-agent
