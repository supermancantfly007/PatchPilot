# PatchPilot 技术方案

Status: ready-for-agent

Source PRD: `.scratch/agent-platform/PRD.md`

## 目标

本技术方案把 PRD 中的 agent 自动开发平台落成可实现架构。核心原则是：

- 普通用户体验保持极简：一个输入框、模板、`grill-me` 式逐轮澄清对话、订单式进度、完成证据摘要。
- 工程交付保持可控：状态机、隔离工作区、Pull Request 边界、测试质量门、权限、预算、审计和失败恢复都必须可执行。
- MVP 先做单仓库、单项目、PRD 到 PR 的闭环，不先做完整企业控制台和多仓库编排。

## 总体架构

```text
Web / CLI
  -> Control Plane API
    -> Workflow Engine
      -> Scheduler
        -> Codex Worker
          -> Workspace Manager
          -> CodexRunner
          -> Test Runner
          -> PR Adapter
    -> Contract Registry
    -> Approval Service
    -> Audit/Event Store
    -> Artifact Store

Postgres stores product state.
Object storage stores logs, screenshots, traces, diffs, test reports, and previews.
Temporal stores durable workflow execution state.
```

## 技术选型总览

| 层 | 选择 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript | 前端、API、worker、CodexRunner 统一语言栈，减少跨语言摩擦 |
| Monorepo | pnpm workspace + Turborepo | 适合多 app/package，便于共享 domain、schema、runner、UI |
| Web UI | Next.js App Router + React + Tailwind CSS + shadcn/ui/Radix | 同时支持普通模式和专业模式；组件生态成熟；首屏体验开发快 |
| Control Plane API | Fastify + Zod + OpenAPI | 长连接、SSE、webhook、API schema 生成比纯 Next route 更清晰 |
| Workflow Engine | Temporal TypeScript SDK | 长任务、重试、暂停、恢复、signal/query、人工审批等待是核心需求 |
| 数据库 | PostgreSQL | 事务、JSONB、索引、行锁、审计事件和复杂查询都适合 |
| ORM / Query | Drizzle ORM + SQL migrations | 保留 SQL 可控性，便于状态机和审计表使用约束与索引 |
| Artifact Store | S3-compatible object storage | 开发用 MinIO，生产用 AWS S3 / Cloudflare R2 / GCS |
| Realtime | Server-Sent Events for MVP; WebSocket later | 进度流主要是服务端到客户端，SSE 简单可靠 |
| Codex 执行 | `CodexRunner` adapter over `codex exec --json` for MVP | MVP 先采集 JSONL 事件；后续可切换 Codex SDK 或 Codex MCP server |
| Agent 隔离 | Git worktree + rootless container | worktree 隔离代码，container 隔离依赖、进程、网络和 secret |
| PR 集成 | Git CLI + Octokit GitHub API | MVP 先支持 GitHub；Linear/Jira/GitLab 后续作为 adapter |
| 契约 | OpenAPI + AsyncAPI + openapi-typescript | HTTP/event/schema 可版本化，前端客户端可生成 |
| 测试 | Vitest + Playwright + project configured commands | 平台自身测试用 Vitest/Playwright；目标仓库按配置运行 |
| Observability | OpenTelemetry + Prometheus/Grafana-compatible backend | trace、metrics、logs 统一关联 AgentRun / Workflow / TestRun |
| Secret | Secret Broker abstraction | MVP 禁用生产 secret；生产接 Vault / cloud Secrets Manager |
| Policy | TypeScript policy checks first; OPA later | MVP 先用显式策略和 Capability Manifest，企业版再引入 OPA |

## 为什么选择 TypeScript 单语言栈

TypeScript 适合这个平台的第一阶段：

- Next.js、Fastify、Temporal TypeScript SDK、Octokit、OpenAPI tooling 都在同一生态。
- Codex SDK 有 TypeScript 支持，`codex exec --json` 也易于用 Node child process 消费。
- domain schema、API schema、UI 类型、worker payload 可以共享，降低接口漂移。
- 对 MVP 团队更容易快速迭代。

不建议 MVP 使用多语言微服务。Python 可以用于后续模型评估、数据分析或专门 runner，但不应成为第一版控制面主语言。

## 仓库结构

```text
/
├── apps/
│   ├── web/                    # Next.js UI
│   └── cli/                    # 本地/运维 CLI
├── services/
│   ├── api/                    # Fastify Control Plane API
│   └── worker/                 # Temporal workers + Codex workers
├── packages/
│   ├── domain/                 # 状态机、实体类型、领域规则
│   ├── db/                     # Drizzle schema + migrations
│   ├── contracts/              # OpenAPI/AsyncAPI/schema
│   ├── codex-runner/           # CodexRunner adapter
│   ├── workspace-manager/      # worktree/container 管理
│   ├── policy/                 # Capability Manifest 和策略检查
│   ├── testing/                # TestRun/TestCase helpers
│   └── ui/                     # 共享 UI 组件
├── infra/
│   ├── docker-compose.yml      # 本地开发依赖
│   └── k8s/                    # 生产部署模板，后续阶段
├── .scratch/
│   └── agent-platform/
└── docs/
    ├── adr/
    └── agents/
```

## 核心模块设计

### Control Plane UI

UI 分两层：

- 普通模式：一个输入框、模板按钮、像 Codex CLI 一样一问一答的澄清窗口、订单式进度、完成页。
- 专业模式：PRD、WorkItem、AgentRun、WorkspaceRun、TestRun、Pull Request、AuditEvent、成本和审批。

MVP 页面：

- `/`：输入框 + 四个模板。
- `/requirements/:id/confirm`：逐轮澄清对话、推荐答案、简版需求确认。
- `/runs/:id`：订单式进度页，SSE 展示实时状态。
- `/runs/:id/details`：专业视图。
- `/acceptance/:id`：完成摘要、预览、测试结果、接受/要求修改。

### Control Plane API

API 使用 Fastify 提供：

- REST API。
- SSE 事件流。
- GitHub webhook。
- Temporal workflow signal/query 代理。
- OpenAPI 文档。

关键接口：

```text
POST   /api/requirements
POST   /api/requirements/:id/clarification-turn
POST   /api/requirements/:id/prd
POST   /api/requirements/:id/clarification-answer  # compatibility
POST   /api/prds/:id/approve
GET    /api/agents
POST   /api/bugs
POST   /api/work-items/:id/claim
POST   /api/work-items/:id/release
POST   /api/work-items/:id/start
GET    /api/runs/:id
GET    /api/runs/:id/events
POST   /api/approvals/:id/approve
POST   /api/approvals/:id/deny
POST   /api/pull-requests/:id/request-changes
POST   /api/acceptance/:id/accept
POST   /api/acceptance/:id/reject
```

### Workflow Engine

生产路径选择 Temporal。核心 workflow：

| Workflow | 责任 |
| --- | --- |
| `RequirementIntakeWorkflow` | 需求进入、`grill-me` 逐轮澄清、PRD 草案、确认等待 |
| `WorkItemPlanningWorkflow` | PRD 到 1-4 个面向角色的垂直工作项和测试建议 |
| `WorkItemExecutionWorkflow` | claim、workspace、CodexRun、test、PR、review |
| `ApprovalWorkflow` | 等待人工或策略审批 |
| `DefectReproductionWorkflow` | `/diagnose` 驱动的 bug 复现、诊断和修复前证据 |
| `RetrospectiveWorkflow` | 完成后汇总成本、测试、风险和审计链路 |

Temporal 使用原则：

- Workflow 只做确定性状态推进。
- LLM、Codex、Git、Docker、测试命令、网络 I/O 都放 Activity。
- 每个 Activity 必须有幂等键。
- approval 使用 signal 恢复。
- UI 查询使用 workflow query 或数据库 projection。

### Scheduler

Scheduler 负责：

- 找到 `ready` WorkItem。
- 根据并发、预算、依赖和 capability 选择 worker。
- 获取 claim lease。
- 创建 Temporal workflow 或恢复已有 workflow。
- 回收过期 lease。

MVP 本地 Markdown 模式使用文件锁实现 claim；数据库模式使用 Postgres 乐观锁和唯一约束。

### CodexRunner

`CodexRunner` 是平台与 Codex 的唯一集成面。

CodexRunner prompt 应保持短，给 AI 充分发挥空间。平台只注入任务名、任务文件、工作区边界和 skill 名称：

- 功能开发类 WorkItem：只提示“使用 `/tdd`”。
- Bug 修复类 WorkItem：只提示“使用 `/diagnose`”。
- 不把 skill 全文或长流程说明塞进 prompt。完整规则由任务文件、AGENTS.md、测试建议和质量门承载。

Bug 工作流在 MVP 中分两段执行：`test` agent 先领取复现任务，成功后 Workflow/Store 生成 `backend` 修复任务；开发修复任务完成并通过回归检查后，Bug 状态才从 `confirmed/fixing` 进入 `fixed`。

```ts
interface CodexRunner {
  start(input: CodexRunInput): Promise<CodexRunHandle>;
  resume(agentRunId: string, prompt: string): Promise<void>;
  cancel(agentRunId: string): Promise<void>;
  streamEvents(agentRunId: string): AsyncIterable<CodexRunEvent>;
  collectArtifacts(agentRunId: string): Promise<CodexArtifacts>;
  summarizeFailure(agentRunId: string): Promise<FailureSummary>;
}
```

MVP 实现：

- 使用 `codex exec --json`。
- 通过 Node child process 启动。
- 解析 JSONL 事件。
- 将 agent message、reasoning、command execution、file changes、test output 写入 AgentRun event stream。
- sandbox 默认 `workspace-write`。
- approval policy 默认 `never`，危险动作由平台自己拦截，不交给 Codex 临场决定。

后续实现：

- Codex SDK：用于更长会话、resume thread、服务端线程管理。
- Codex MCP server：用于让外部多 agent 编排框架把 Codex 当作工具。

### Workspace Manager

Workspace Manager 负责：

- 从目标仓库创建 worktree。
- 创建任务分支。
- 准备容器镜像。
- 注入只读配置和最小 secret。
- 挂载当前 workspace。
- 限制 CPU、内存、磁盘、时间和网络。
- 执行 cleanup 和 artifact collection。

MVP：

- 本地 worker host。
- Git worktree。
- rootless Docker 或 Podman。
- 禁止 Docker socket 和宿主 home 挂载。
- 只允许访问 Git remote、package registry、OpenAI/Codex 相关 endpoint。

生产化：

- Kubernetes worker pool。
- gVisor/Kata/Firecracker 级别沙箱。
- 独立 VPC/eBPF/egress policy。
- 每个 run 临时 service account。

### Test Runner

Test Runner 不猜测目标项目如何测试，而是读取项目配置：

```yaml
setup:
  - pnpm install --frozen-lockfile
test:
  target:
    - pnpm test -- --changed
  smoke:
    - pnpm test
  e2e:
    - pnpm playwright test
```

MVP 支持：

- 目标测试命令。
- 全量或冒烟测试命令。
- 超时和重试。
- JUnit/JSON/text 输出解析。
- 日志摘要。
- TestRun 入库。

当前 JSON-backed MVP 也会在 `/api/snapshot` 中暴露 `WorkspaceRun`、`TestRun` 和 `AuditEvent`，让 UI、worker E2E 和人工验收都能从同一份证据链路核验执行结果。

### PR Adapter

MVP 先支持 GitHub：

- local git branch/commit。
- push branch。
- Octokit 创建 Pull Request。
- 更新 PR body。
- 读取 checks 状态。
- 写 reviewer agent comment。

PR body 模板：

```md
## 需求

<Requirement / PRD link>

## 工作项

<WorkItem link>

## 改动摘要

...

## 测试结果

...

## 风险

...

## Reviewer Agent 摘要

...
```

### Contract Registry

Contract Registry 保存：

- OpenAPI 文件。
- AsyncAPI 文件。
- schema 文件。
- contract diff。
- provider/consumer 映射。
- contract TestRun。
- breaking change approval。

MVP 规则：

- 每个 PRD 草稿默认生成 HTTP API、AgentRun 事件流、共享状态 schema 三类 draft contracts。
- PRD 批准或 start-team 后，默认契约升级为 approved，成为前端、后端、测试和运维 agent 的协作基线。
- 检测到 API/schema/event 变更时，再生成 contract diff 和 provider/consumer 测试要求。

### Approval Service

审批对象：

- PRD approval。
- budget exceeded。
- dangerous operation。
- breaking contract。
- network allowlist change。
- secret grant。
- production data access。

Approval 必须有：

- requested_by。
- requested_reason。
- risk_level。
- expires_at。
- approved_by / denied_by。
- decision_reason。

## 数据模型

MVP 使用 Postgres 作为产品状态库，同时保留 `.scratch/` Markdown 导入/导出能力。

### 表结构概要

```text
organizations
projects
repositories
requirements
prd_versions
work_items
interface_contracts
test_cases
test_runs
defects
agents
agent_runs
workspace_runs
pull_requests
approvals
audit_events
artifacts
capability_manifests
budgets
```

### 关键字段

`requirements`

```text
id
project_id
title
raw_input
input_type
status
simple_summary
created_by
created_at
updated_at
```

`prd_versions`

```text
id
requirement_id
version
status
body_markdown
acceptance_criteria_json
approved_by
approved_at
created_at
```

`work_items`

```text
id
prd_version_id
type
title
status
scope
non_goals
acceptance_criteria_json
test_suggestions_json
depends_on_json
claim_owner
claim_token
lease_expires_at
heartbeat_at
version
created_at
updated_at
```

`agent_runs`

```text
id
work_item_id
agent_type
status
model
prompt_hash
codex_thread_id
workspace_run_id
started_at
ended_at
cost_estimate
cost_actual
failure_type
failure_summary
```

`workspace_runs`

```text
id
repository_id
work_item_id
agent_run_id
status
base_ref
branch_name
worktree_path
container_id
image_digest
network_policy_json
created_at
destroyed_at
```

`test_runs`

```text
id
work_item_id
agent_run_id
pull_request_id
type
status
command
exit_code
started_at
ended_at
summary
artifact_ids
retry_count
flaky_signal
```

`audit_events`

```text
id
trace_id
actor_type
actor_id
target_type
target_id
action
before_json
after_json
reason
metadata_json
created_at
hash
previous_hash
```

### 索引与约束

- `work_items(status, lease_expires_at)` 用于调度。
- `agent_runs(work_item_id, status)` 用于任务详情。
- `audit_events(trace_id, created_at)` 用于审计链路。
- `test_runs(work_item_id, created_at)` 用于最终验收。
- `pull_requests(work_item_id)` 保证代码交付可追溯。
- `claim_token` 写入状态时必须校验。

## 状态与事件

状态变化必须同时：

1. 更新当前实体状态。
2. 写入 `audit_events`。
3. 推送实时事件给 UI。

事件类型：

```text
requirement.submitted
requirement.clarification_requested
prd.generated
prd.approved
work_item.created
work_item.claimed
agent_run.started
agent_run.event
agent_run.failed
agent_run.succeeded
workspace.created
test_run.started
test_run.failed
test_run.passed
pull_request.created
approval.requested
approval.approved
acceptance.accepted
acceptance.rejected
```

## 工作流详解

### 需求到 PRD

1. 用户提交自然语言、截图、录屏、文档或报错。
2. Intake activity 生成摘要和风险初判。
3. Clarification activity 按 `/grill-me` 规则一次生成一个问题和推荐答案。
4. 用户在对话窗口逐轮回答、接受推荐或继续补充；能从代码或文档中确定的问题由平台自行探索。
5. PRD activity 生成完整 PRD 和简版需求确认。
6. 用户批准。
7. 写入 `prd_versions` 和 `audit_events`。

### PRD 到工作项

1. Planner activity 生成 1-4 个垂直工作项，优先覆盖后端、前端、测试和运维角色。
2. 每个工作项包含范围、非目标、验收条件和测试建议。
3. 依赖关系被解析为 `depends_on_json`。
4. 工作项进入 `ready`。

### 工作项执行

1. Scheduler claim WorkItem。
2. Workspace Manager 创建 worktree 和 container。
3. CodexRunner 根据 WorkItem 类型选择极短 prompt：功能用 `/tdd`，bug 用 `/diagnose`。
4. CodexRunner 启动 Codex。
5. Codex 修改代码并输出事件。
6. Test Runner 执行目标测试。
7. PR Adapter 创建 Pull Request。
8. Reviewer agent 生成 review summary。
9. 平台归档 WorkspaceRun，写入 TestRun 和 AuditEvent。
10. 通过质量门后等待最终验收。

### 失败处理

| 失败 | 处理 |
| --- | --- |
| Codex run timeout | cancel run，归档 workspace，生成 failure summary |
| 测试失败 | 写 TestRun，允许一次自动修复，超过上限转 Defect |
| 环境失败 | 重建 workspace，超过上限 blocked |
| 权限不足 | 进入 Approval |
| 预算耗尽 | 暂停并请求审批 |
| Git 冲突 | blocked，显示普通说明和技术详情 |

## 安全方案

### Capability Manifest

每个 AgentRun 生成一份 manifest：

```json
{
  "repo": {
    "read": ["**"],
    "write": ["src/**", "tests/**"],
    "deny": [".env", "secrets/**"]
  },
  "commands": {
    "allow": ["pnpm", "npm", "git", "codex"],
    "deny": ["rm -rf /", "ssh", "docker"]
  },
  "network": {
    "allow": ["github.com", "registry.npmjs.org", "api.openai.com"],
    "denyPrivateNetworks": true
  },
  "secrets": [],
  "maxRuntimeMinutes": 60,
  "maxCostUsd": 5
}
```

Policy enforcement points：

- API request。
- Scheduler dispatch。
- Workspace setup。
- Command execution wrapper。
- Network egress proxy。
- Secret Broker。

### Secret Broker

MVP：

- 不注入生产密钥。
- 只支持明确配置的开发/CI token。
- 所有 secret 使用 env var 注入前先写审计。

生产：

- Vault / AWS Secrets Manager / GCP Secret Manager。
- 短期 token。
- 自动轮换和撤销。
- secret scanning 覆盖 prompt、logs、diff、artifact。

### Sandbox

MVP 最低要求：

- rootless container。
- 禁止 privileged。
- 禁止 Docker socket。
- 禁止宿主 home。
- read-only base mount + workspace write mount。
- CPU/memory/disk/time quota。
- egress allowlist。

生产增强：

- gVisor/Kata/Firecracker。
- per-run network namespace。
- cloud metadata endpoint block。
- artifact DLP scan。

## 测试方案

### 平台自身测试

| 层 | 工具 |
| --- | --- |
| domain 状态机 | Vitest |
| API integration | Vitest + test database |
| workflow | Temporal test environment |
| UI | Playwright |
| CodexRunner | fake JSONL process + integration smoke |
| Workspace Manager | containerized integration tests |
| Security policy | policy fixture tests |

### 目标仓库测试

目标仓库测试由项目配置驱动，平台只负责：

- 调用命令。
- 限制超时。
- 采集输出。
- 总结失败。
- 入库 TestRun。
- 决定质量门是否通过。

### 质量门实现

PR 可验收条件：

- 目标测试通过。
- 无未处理高严重缺陷。
- 代码变更有关联 WorkItem。
- PR body 完整。
- reviewer agent 输出可读摘要。
- 若有契约变更，contract diff 和契约测试通过。

## 技术路线

### Phase 0：CLI 原型

目标：从 `.scratch/agent-platform/PRD.md` 生成一个工作项，并跑一次 Codex worker。

范围：

- CLI 输入需求。
- 本地 Markdown PRD/WorkItem。
- `codex exec --json`。
- 本地 worktree。
- 运行测试命令。
- 输出 Markdown run report。

不做：

- Web UI。
- Temporal。
- 完整数据库。
- GitHub PR 自动创建。

### Phase 1：MVP

目标：单仓库、Web 极简入口、PRD 到 PR 的完整闭环。

范围：

- Next.js UI。
- Fastify API。
- Postgres + Drizzle。
- Temporal。
- CodexRunner。
- Workspace Manager。
- GitHub PR Adapter。
- TestRun / AgentRun / AuditEvent。
- SSE 进度流。

### Phase 2：Bug 修复闭环

范围：

- Defect intake。
- 失败复现。
- regression test。
- 自动修复尝试。
- flaky 策略。

### Phase 3：生产化

范围：

- 严格沙箱。
- Secret Broker。
- OPA 或等价策略引擎。
- UI 专业模式。
- 并行工作项。
- 成本预算治理。

### Phase 4：企业集成

范围：

- GitHub App。
- Linear/Jira adapter。
- 多仓库。
- SSO/RBAC。
- 审计导出。
- 发布/回滚审批。

## 部署方案

### 本地开发

```text
docker compose:
  postgres
  temporal
  temporal-ui
  minio
  api
  web
  worker
```

worker host 需要：

- Git。
- Codex CLI。
- Docker rootless 或 Podman。
- Node.js。
- pnpm。

### 生产

推荐：

- Web/API：Kubernetes 或 managed container platform。
- Worker：独立隔离 worker pool。
- Workflow：Temporal Cloud 或自托管 Temporal。
- DB：managed PostgreSQL。
- Artifact：S3-compatible storage。
- Observability：OpenTelemetry Collector + Grafana-compatible backend。
- Secret：Vault 或 cloud Secrets Manager。

生产 worker pool 不应与 API/UI 共用节点权限。

## 配置文件

每个目标仓库应有 `.patchpilot/config.yaml`：

```yaml
project:
  name: example
  defaultBranch: main

setup:
  commands:
    - pnpm install --frozen-lockfile

test:
  target:
    - pnpm test -- --changed
  smoke:
    - pnpm test

dev:
  command: pnpm dev
  previewUrl: http://localhost:3000

security:
  allowedNetwork:
    - github.com
    - registry.npmjs.org
  deniedPaths:
    - .env
    - secrets/**

budgets:
  workItemUsd: 5
  maxRuntimeMinutes: 60
```

## 主要风险与应对

| 风险 | 应对 |
| --- | --- |
| Agent 循环成本失控 | per-run 预算、最大返工次数、硬暂停 |
| 测试不稳定 | flaky 检测、quarantine 到期、关键路径不允许长期豁免 |
| 沙箱逃逸 | rootless、无 Docker socket、无宿主 home、生产用强隔离 runtime |
| 需求不清 | grill-me 逐轮澄清、简版需求确认、低置信度不自动执行 |
| 多 agent 冲突 | worktree per item、lease/fencing、PR 边界 |
| 审计缺失 | 状态变化必须写 AuditEvent，CI 检查审计完整性 |
| Codex 集成替换成本 | CodexRunner adapter 隔离 SDK/exec/MCP 差异 |
| 普通用户被术语吓退 | Simple Mode 默认隐藏技术细节 |

## 参考资料

- Codex SDK: https://developers.openai.com/codex/sdk.md
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive.md
- Codex MCP / Agents SDK: https://developers.openai.com/codex/guides/agents-sdk.md
- Codex worktrees: https://developers.openai.com/codex/app/worktrees.md
- Temporal docs: https://docs.temporal.io/
- Temporal TypeScript SDK: https://docs.temporal.io/develop/typescript
- Next.js App Router: https://nextjs.org/docs/app
- Fastify: https://fastify.dev/docs/latest/
- PostgreSQL docs: https://www.postgresql.org/docs/
- Drizzle ORM: https://orm.drizzle.team/docs/overview
- OpenAPI Specification: https://spec.openapis.org/oas/latest.html
- AsyncAPI Specification: https://www.asyncapi.com/docs/reference/specification/latest
- Docker rootless mode: https://docs.docker.com/engine/security/rootless/
- GitHub REST API pull requests: https://docs.github.com/en/rest/pulls/pulls
- OpenTelemetry: https://opentelemetry.io/docs/
