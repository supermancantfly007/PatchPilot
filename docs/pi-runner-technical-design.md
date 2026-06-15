# Pi Runner 技术方案

Status: proposed

Date: 2026-06-15

Related docs:

- `CONTEXT.md`
- `docs/adr/0003-codex-integration-path.md`
- `docs/adr/0004-worktree-container-sandbox-isolation-model.md`
- `docs/adr/0008-agent-run-audit-event-retention-redaction.md`
- `docs/adr/0009-credential-mcp-network-approval-security-model.md`
- `docs/adr/0010-test-and-contract-validation-strategy.md`
- `docs/adr/0011-production-sandbox-runtime.md`

## 背景

PatchPilot 当前的 AI coding 底座默认是 Codex。平台通过 `@patchpilot/codex-runner` 创建隔离 Git worktree，写入 `PATCHPILOT_TASK.md`，调用 `codex exec --json`，解析 JSONL 事件，运行项目测试，必要时发起修复回合，收集 diff 和测试证据，最后提交 worktree 分支并将证据回写到 API store。

用户希望评估并增加另一个 coding agent 底座：`https://github.com/earendil-works/pi`。

Pi 当前 npm 包为 `@earendil-works/pi-coding-agent@0.79.3`，bin 为 `pi`，Node 要求 `>=22.19.0`。Pi README 明确提供四种运行形态：

- interactive mode
- print / JSON mode
- RPC mode
- SDK embedding

Pi 也明确说明自身没有内置 sandbox。它的 built-in tools 可以读写文件、编辑文件、执行 shell command，权限等同启动 `pi` 的进程。因此 PatchPilot 接入 Pi 时，不能把 Pi 当成安全边界，只能把 Pi 当成 coding-agent provider，继续由 PatchPilot 的 worktree、container sandbox、Capability Manifest、Secret Broker、egress allowlist、Audit Event 体系提供边界。

## 目标

1. PatchPilot 支持在启动 Work Item 时选择 `codex` 或 `pi` 作为 AI coding 底座。
2. 保持当前 Codex 路径兼容，`auto` 默认仍解析为 Codex，避免破坏现有本地和 E2E 流程。
3. Pi MVP 复用现有交付外壳：worktree、任务文件、测试、修复回合、diff、commit、artifact、audit。
4. Pi runner 输出必须被规范化为 PatchPilot 现有 AgentRun 证据模型。
5. Pi 不继承用户个人全局配置、host HOME、无关环境变量、SSH agent、Docker socket 或 worktree 外的 Pi 状态；受控 worktree 或平台托管目录中的 Pi 能力资源可以被使用并记录为 evidence。
6. Pi 的 agent/auth/session 状态目录不落入任务 worktree，不能被 coding agent 当作普通项目文件读写。
7. 生产或无人值守 Pi run 在 sandbox、egress allowlist、Secret Broker 任一控制不可用时 fail closed；本地主机直跑只能作为显式降级模式并记录 evidence。
8. 为后续 durable runner contract 预留空间，让 `pi --mode rpc` 或 SDK 可以支持 cancel、resume、stream、artifact collection。
9. 明确区分 Pi JSON CLI MVP 和生产可强制执行模式：JSON MVP 如果暴露 Pi built-in `bash`，只能作为本地、CI、单租户受控 preview 或显式降级路径；多租户/无人值守生产可强制执行必须先解决 Pi 内部 shell 的预执行策略拦截。
10. 不人为限制 Codex 或 Pi 的 coding agent 能力。PatchPilot 的控制点应在 worktree、sandbox、egress、Secret Broker、Capability Manifest、Audit Event 和 artifact evidence 外壳上，而不是通过削弱 provider 工具、模型、shell、编辑、测试或上下文能力来获得安全感。

## 非目标

1. 本方案不替换 Codex 默认路径。
2. 本方案不实现 Pi provider 的代码。
3. 本方案不引入多 agent 团队并发开发流程。
4. 本方案不把 worktree 外的 Pi 扩展、Pi package、个人配置或全局 `.pi` 资源作为默认可信能力。
5. 本方案不承诺生产环境可以在没有 container / Kubernetes sandbox 的情况下无人值守运行 Pi。
6. 本方案不重写 PatchPilot 的 PRD、WorkItem、TestRun、PullRequest 或 Acceptance 模型。
7. MVP 不支持任意 Pi provider 自动适配，不支持 broad public egress，也不默认支持个人 Pi OAuth/subscription 登录复用。
8. MVP JSON CLI 不声称对 Pi built-in `bash` 命令具备 PatchPilot command wrapper 级别的逐命令预执行授权；这需要 SDK/custom tool wrapping、受控扩展，或按 deployment tier 明确记录只能事后观察内部 tool action 的 enforcement gap。

## 当前硬编码点

接入 Pi 的主要阻力不是 Pi 本身，而是 PatchPilot 当前的 runner 类型和命名仍偏 Codex：

- `packages/domain/src/index.ts` 中 `AgentRunnerKind = "codex"`。
- `packages/db/src/schema.ts` 中 `agent_runner_kind` enum 只有 `codex`。
- `packages/contracts/src/index.ts` 中 `startRunSchema.runner` 是 `z.literal("codex")`，OpenAPI `runnerKind` 只有 `codex`。
- `services/api/src/config.ts` 中 `configuredRunnerSchema = z.enum(["auto", "codex"])`。
- `services/api/src/store.ts` 注入的是单个 `codexRunner`，`resolveRunner()` 对任何 override 都返回 `"codex"`。
- `services/api/src/store.ts` 的 runtime config 永远返回 `activeRunner: "codex"`，只有 `codexAvailable`。
- `apps/cli/src/index.ts` 和 `services/worker/src/index.ts` 的 runner parser 只接受 `codex`。
- `packages/policy/src/index.ts` 默认 command allowlist 只有 `codex exec*` 和 `codex --version`。
- AgentRun event type 当前有 `codex.started`、`codex.output`，缺少 provider-neutral 的 `agent.started`、`agent.output`。
- ADR-0003 和包名 `@patchpilot/codex-runner` 将执行边界命名为 CodexRunner。
- `packages/workflows/src/activities.ts` 中还有 `codex_runner` actor、CodexRunner 文案和 `codex.*` event 硬编码。
- `packages/telemetry/src/prometheus.ts` 中 runner label enum 只有 `codex` 和 `unknown`。
- 生成的 OpenAPI / event schema JSON 需要同步 runner enum 和 provider-neutral event type。
- UI 和测试中有 CodexRunner 文案、`codex` runner label 和注入式 `CodexRunner` fixture。

这些点可以分阶段处理。MVP 可以在不大规模重命名包的情况下增加 Pi，但长期需要 provider-neutral 命名，避免新底座持续挂在 Codex 语义下面。

## 推荐路径

### 阶段 1：Pi JSON CLI MVP

优先实现 `pi --mode json` adapter。原因：

- 和现有 `codex exec --json` 最相似，都是子进程 + stdout JSONL。
- 易于复用现有 `LocalCodexRunner.run()` 的大部分流程。
- 可以作为本地和 CI smoke 的最小闭环。
- 不需要先引入 Pi SDK 依赖或长生命周期 RPC 管理。

MVP 能力边界：

- 一次 Work Item 执行启动一次 Pi 子进程。
- 测试失败时再启动一次 Pi 子进程执行 repair prompt。
- 不承诺 resume 原 Pi session。
- 不承诺中途 cancel 后可恢复。
- 不依赖项目 `.pi` 扩展和 package。

### 阶段 2：Provider-neutral runner boundary

把平台内部概念从 Codex-only 过渡为 coding-agent runner：

- `CodexRunner` interface 可以先保留兼容，但新增 provider registry。
- 新增 `CodingAgentRunner` interface 或 `AgentRunnerAdapter`。
- `LocalCodexRunner` 和 `LocalPiRunner` 都实现同一 one-shot MVP interface。
- API store 按 `AgentRunnerKind` 选择 adapter。

阶段 2 不要求包立即改名，但新代码不要继续加深 Codex-only 语义。

### 阶段 3：Pi RPC durable adapter

在 MVP 跑通后，引入 `pi --mode rpc`：

- 通过 stdin/stdout JSONL 发送 `prompt`、`abort`、`get_state`、`get_last_assistant_text`。
- 用长期子进程或 per-run process 管理 session。
- 支持更清晰的 cancel、stream、state inspection。
- 可以保存 `sessionFile`、`sessionId`、`sessionName` 到 provider metadata。

### 阶段 4：Pi SDK adapter

当 PatchPilot 的 durable runner contract、Temporal activities、provider-neutral state 已成熟后，再考虑 SDK：

- 直接使用 `@earendil-works/pi-coding-agent`。
- 在 Node 进程内订阅 `AgentSessionEvent`。
- 用 custom ResourceLoader、custom tool wrappers、custom AuthStorage 更精细地控制资源。
- 减少子进程协议成本，但增加依赖和进程内隔离复杂度。

## 目标架构

```text
API / Worker / Temporal Activity
  -> RunnerRegistry
    -> LocalCodexRunner
       -> codex exec --json
    -> LocalPiRunner
       -> pi --mode json
       -> later: pi --mode rpc
       -> later: Pi SDK

Runner shared shell:
  -> Capability Manifest
  -> Workspace Manager
  -> Rootless Container Sandbox / production RuntimeClass
  -> Secret Broker
  -> Egress Policy
  -> Test Runner
  -> Artifact Store
  -> Audit Events
```

The runner provider owns only the coding-agent invocation and provider event parsing. PatchPilot continues to own workspace preparation, policy, tests, artifacts, commits, PR boundaries, approvals, and final acceptance.

## Domain 和 API 改造

### Runner kind

将 domain 类型扩展为：

```ts
export type AgentRunnerKind = "codex" | "pi";
```

建议同时新增常量，避免散落字符串：

```ts
export const agentRunnerKinds = ["codex", "pi"] as const;
```

### DB schema

Postgres enum 需要新增 `pi`：

```sql
ALTER TYPE agent_runner_kind ADD VALUE IF NOT EXISTS 'pi';
```

Drizzle schema：

```ts
export const agentRunnerKind = pgEnum("agent_runner_kind", ["codex", "pi"]);
```

注意事项：

- 已有 `agent_runs.runner` 和 `workspace_runs.runner` 继续使用 enum。
- 旧数据不需要迁移，现有 rows 仍是 `codex`。
- PGlite 本地 DB 和 Drizzle snapshot 需要同步。
- 当前 repo 已有 `packages/db/drizzle/0000_early_silver_centurion.sql` 到 `0007_pale_moonstone.sql`。Pi 实现应新增 `0008_*` migration，而不是修改历史 migration。
- Drizzle meta snapshot 和 `_journal.json` 必须随新增 migration 更新。
- 部署顺序应先应用 DB migration，再发布可写入 `runner='pi'` 的 API/worker。
- Postgres enum add 通常不可简单回滚。rollback 文档应说明：如果需要停用 Pi，应用层禁止新 Pi run；已有 `pi` rows 保留或通过受控数据迁移转为兼容状态后，再考虑重建 enum。

### Contracts

修改：

```ts
export const startRunSchema = z.object({
  runner: z.enum(["codex", "pi"]).optional(),
  claimToken: z.string().trim().min(1).optional()
}).default({});
```

OpenAPI：

```ts
const runnerKind = enumSchema(["codex", "pi"]);
```

`StartRunRequest.runner`、`AgentRun.runner`、`WorkspaceRun.runner`、`RuntimeConfig.activeRunner` 都使用 provider enum。

`RuntimeConfig.configuredRunner` 不能复用同一个 enum，因为它需要保留 `auto`：

```ts
export const configuredRunnerKind = z.enum(["auto", "codex", "pi"]);
export const activeRunnerKind = z.enum(["codex", "pi"]);
```

### Runtime config

当前字段：

```ts
configuredRunner: AgentRunnerKind;
activeRunner: AgentRunnerKind;
codexAvailable: boolean;
gitWorkspaceAvailable: boolean;
```

建议演进为：

```ts
configuredRunner: "auto" | AgentRunnerKind;
activeRunner: AgentRunnerKind;
runnerAvailability: {
  codex: RunnerAvailability;
  pi: RunnerAvailability;
};
gitWorkspaceAvailable: boolean;
```

为了兼容前端和测试，第一步可以保留 `codexAvailable` 并新增 `piAvailable`：

```ts
codexAvailable: boolean;
piAvailable: boolean;
```

长期用 `runnerAvailability` 替代 provider-specific boolean。

## 配置设计

### 最小配置

`.env.example`：

```env
# Runner mode: auto, codex, or pi.
PATCHPILOT_RUNNER=auto

# Pi runner. Read by the API process because runner execution is embedded there.
PATCHPILOT_PI_COMMAND=pi
PATCHPILOT_PI_PROVIDER=
PATCHPILOT_PI_MODEL=
PATCHPILOT_PI_THINKING=
PATCHPILOT_PI_AGENT_DIR=
PATCHPILOT_PI_SESSION_DIR=
PATCHPILOT_PI_TIMEOUT_MS=600000
PATCHPILOT_PI_PROJECT_TRUST=no-approve
PATCHPILOT_PI_DISABLE_PROJECT_RESOURCES=true
PATCHPILOT_PI_SKIP_VERSION_CHECK=true
PATCHPILOT_PI_DISABLE_TELEMETRY=true
PATCHPILOT_PI_OFFLINE=false
```

`.patchpilot/config.yaml`：

```yaml
dev:
  runner: auto # auto, codex, pi

pi:
  command: pi
  provider: ""
  model: ""
  thinking: ""
  # Empty means PatchPilot creates a run-scoped platform-owned directory outside the worktree.
  agentDir: ""
  sessionDir: ""
  timeoutMs: 600000
  projectTrust: no-approve
  disableProjectResources: true
  skipVersionCheck: true
  disableTelemetry: true
  offline: false
```

`agentDir` 和 `sessionDir` 不能默认是 worktree 内的相对路径。若用户显式配置相对路径，PatchPilot 必须相对于 platform state root 解析，而不是相对于 `workspace.path`。推荐默认目录形态：

```text
<patchpilot-state>/runner/pi/<runId>/agent
<patchpilot-state>/runner/pi/<runId>/sessions
```

原因：

- Pi 的 `auth.json` 或 provider OAuth state 不能被 coding agent 作为项目文件读写。
- Pi session 原始状态可能包含 prompt、provider metadata、tool result 或敏感上下文，属于受控 artifact / ephemeral execution state，不属于任务 diff。
- Worktree cleanup、diff collection、commit creation 不能把 Pi agent/session state 纳入候选变更。

### `auto` 行为

MVP 建议：

- `auto` 继续解析为 `codex`，保持当前行为。
- 用户显式设置 `PATCHPILOT_RUNNER=pi` 或 API body `{ "runner": "pi" }` 时才使用 Pi。

后续可以支持：

- `auto` 根据 runner availability 和 project policy 选择。
- WorkItem `requiredCapabilities` 或 project config 指定 preferred runner。
- Codex 不可用且 Pi 可用时自动 fallback，但需要明确记录 Audit Event。

不建议 MVP 自动 fallback。自动 fallback 会让证据和成本模型不稳定，也会掩盖环境配置问题。

## Runner registry

API store 不应持有单个 `codexRunner`。建议引入 registry：

```ts
export interface CodingAgentRunner {
  kind: AgentRunnerKind;
  availability(): Promise<RunnerAvailability>;
  isGitWorkspaceAvailable(cwd?: string): Promise<boolean>;
  run(
    context: CodingAgentRunContext,
    emit: EmitCodingAgentRunnerEvent,
    config: CodingAgentRunnerConfig
  ): Promise<AgentRunResult>;
}

export interface RunnerRegistry {
  get(kind: AgentRunnerKind): CodingAgentRunner;
  availability(): Promise<Record<AgentRunnerKind, RunnerAvailability>>;
}
```

`RunnerAvailability` 不能只是 boolean。Pi 需要表达版本不兼容、Node engine 不满足、provider 未配置、egress/sandbox/secret prerequisite 缺失、local unsafe 降级等状态：

```ts
export interface RunnerAvailability {
  available: boolean;
  status: "available" | "degraded" | "unavailable";
  reason?: string;
  mode?: "production_enforceable" | "local_unsafe" | "fake" | "preview";
  details?: Record<string, unknown>;
}
```

兼容现有调用点时可以保留 `isAvailable()` helper，但新的 registry、runtime config、UI health 和 preflight 应使用 `availability()`。

MVP store options：

```ts
new PatchPilotStore({
  runners: {
    codex: new LocalCodexRunner(),
    pi: new LocalPiRunner()
  }
});
```

兼容现有测试可保留：

```ts
codexRunner?: CodexRunner;
```

然后内部转成 registry。

## Pi CLI MVP 设计

### Availability check

```bash
pi --version
```

判定：

- exit code 0 -> available
- ENOENT -> unavailable，reason `Pi CLI is not installed`
- non-zero -> unavailable，reason 使用 stderr/stdout 摘要

MVP 兼容性边界：

- pin 文档和测试到 `@earendil-works/pi-coding-agent@0.79.3`，该版本 npm metadata 显示 bin 为 `pi`，Node engine 为 `>=22.19.0`。
- `pi --version` 输出低于已验证版本时标记 unavailable 或 degraded，不能静默进入真实 WorkItem run。
- Node runtime 不满足 Pi engine 时标记 unavailable，reason 包含当前 Node version 和要求版本。
- 每次 Pi 版本升级必须更新 JSONL golden fixtures 和 fake/real smoke 结果。

可选安装提示：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

### 初始执行命令

推荐命令：

```bash
pi \
  --mode json \
  --no-session \
  --skill <platform-tdd-or-diagnose-skill-path> \
  --model <optional-model> \
  --provider <optional-provider> \
  "<prompt>"
```

进程 `cwd` 必须设置为 `workspace.path`。Pi 没有 Codex 的 `-C` 参数。

不要用 `--tools` 或等价配置人为缩小 Pi 的 coding agent 能力。Pi 应保留完整的读写、编辑、搜索、shell/test 执行、上下文和模型能力；PatchPilot 负责把这些能力放进 run-scoped workspace、environment、sandbox、network、secret 和 evidence boundary。若某些 Pi CLI flag 只能粗粒度地关闭资源加载，它们只能用于避免继承 host/global/personal 状态，不能作为长期削弱 Pi 能力的产品策略。

Prompt 传输优先级：

1. 优先验证 Pi 是否支持通过 stdin 或等价文件输入接收 prompt。
2. 如果只能通过 argv 传 prompt，argv 中只能包含短指令和任务文件路径，不能包含 secret、完整需求附件、测试日志或大段用户内容。
3. 无论使用 stdin 还是 argv，都必须用 `spawn(command, args, { shell: false })`，禁止 shell 拼接。

原因是 argv 即使没有 shell injection，也可能被进程列表、debug dump 或 telemetry 捕获。详细上下文应保存在 `PATCHPILOT_TASK.md` 和受控 artifacts 中。

### 环境变量

Pi 子进程环境必须使用 allowlist，而不是继承 host env。

建议最小 env：

```ts
{
  PATH,
  HOME: runScopedHome,
  PI_CODING_AGENT_DIR: runScopedOrPlatformOwnedAgentDir,
  PI_CODING_AGENT_SESSION_DIR: runScopedSessionDir,
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_OFFLINE: offline ? "1" : undefined,
  ...secretBrokerResolution.env
}
```

注意：

- 默认只设置 `PI_SKIP_VERSION_CHECK=1` 和 `PI_TELEMETRY=0`。
- `PI_OFFLINE=1` 根据 Pi 文档禁用 startup network operations，包括 update checks、package update checks、install/update telemetry。MVP 不默认启用，因为它可能影响 provider 调用。只有在真实 Pi smoke 证明不影响所选 provider 后，才能按 provider 显式启用。
- 不传 `SSH_AUTH_SOCK`、`DOCKER_HOST`、`DOCKER_CONFIG`、`KUBECONFIG`、cloud credential env、host `HOME`。
- API key 可通过 Secret Broker 注入，例如 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GOOGLE_API_KEY`。
- 如果使用 Pi subscription OAuth，需要将 auth.json 放在 platform-owned `PI_CODING_AGENT_DIR`，不能挂用户个人 `~/.pi/agent`。
- `PI_CODING_AGENT_DIR` 和 `PI_CODING_AGENT_SESSION_DIR` 必须是绝对路径，且不能位于 `workspace.path` 内。

### 项目信任和资源加载

Pi 的 trust 机制不是 sandbox。PatchPilot 的目标不是削弱 Pi，而是避免继承 host/global/personal 状态，并把 Pi 的完整能力放在可审计的 run boundary 里。

默认原则：

- Pi 可以使用 worktree 内受控的项目上下文和平台托管 skills/resources。
- Pi 不应自动加载用户个人 `~/.pi`、全局 extensions、workspace 父目录、host-level `AGENTS.md` / `CLAUDE.md` 或其他不属于当前 Workspace Run 的资源。
- 如果 Pi CLI 无法只禁用 host/global/parent discovery，而只能通过 `--no-context-files`、`--no-extensions`、`--no-prompt-templates` 等粗粒度 flag 禁用一类能力，MVP 可以临时使用这些 flag 阻断不可审计继承，但必须通过 PatchPilot-controlled task context、platform-owned skills/resources 或后续 scoped loading 补回能力，并记录为 adapter limitation。
- 本地开发可以显式允许 Pi native context/resource loading，但必须记录来源和 reduced assurance evidence；生产或无人值守模式需要能证明加载范围仅限当前 worktree 或平台托管目录。

这样既保留 PatchPilot 需要的仓库约定和 Pi 原生能力，又避免 Pi 从 host/global/parent path 继承不可审计指令。

如果要让 Pi 使用 TDD/diagnose 工作流，不建议依赖用户机器的 global skills。建议 PatchPilot 提供 platform-owned Pi skills：

```text
packages/agent-skills/pi/tdd/SKILL.md
packages/agent-skills/pi/diagnose/SKILL.md
```

运行时通过 `--skill <absolute-path>` 显式加载，并在 prompt 中使用 Pi 的 skill 命令格式：

```text
/skill:tdd
完成任务：...
读任务文件：...
```

如果不提供 Pi skill，MVP prompt 应避免 `使用 /tdd` 这种 Codex-specific 约定，改成普通自然语言：

```text
Follow a test-first workflow where practical.
Read PATCHPILOT_TASK.md.
Implement only in the current workspace.
Run or update tests as needed.
Finish with changes, tests, and risks.
```

### Prompt 模板

初始 prompt：

```text
Complete the work item: <title>

Read the task file: <taskFilePath>
Work only in the current workspace.
Do not access production secrets or production data.
Use the available read, write, edit, grep, find, ls, and bash tools as needed.
Finish with: changes, tests run, and risks.
```

Bug 修复 prompt：

```text
Fix the reproduced bug: <title>

Read the task file: <taskFilePath>
First confirm the failure evidence in the task file.
Make the smallest safe fix.
Run the relevant regression test or configured test command.
Finish with: root cause, fix, tests run, and risks.
```

Repair prompt：

```text
The configured tests failed for work item: <title>

Failure summary:
<test summary>

Continue in the same workspace.
Fix the implementation or tests only where justified by the task.
Finish with: changes, tests run, and risks.
```

### Last message summary

Codex 当前通过 `-o <lastMessagePath>` 写 final message。Pi JSON mode 没有等价 `-o` 参数。MVP 方案：

- 解析 stdout JSONL，缓存最后一个 assistant message。
- runner 自己写 `.patchpilot-pi-<uuid>.md` 到 workspace。
- `workspaceManager.collectArtifacts()` 继续读取这个 summaryPath。

这个 summary 文件是 PatchPilot 生成的 artifact source，不是候选代码变更。Workspace Manager 的 diff/commit 过滤必须排除 `.patchpilot-pi-*.md`，避免把运行摘要提交到任务分支。实现时必须覆盖：

- summary 文件出现在 worktree 中但不进入 changed files、diff summary 或 commit；
- Pi 成功、失败、取消、timeout 时 summary 文件都被清理或归档为 artifact；
- 如果后续 artifact staging 支持从 worktree 外读取，优先把 summary 写到 platform-owned artifact staging 目录，而不是写入 worktree。

如果 Pi event 中有 `message_end` 且 `message.role === "assistant"`，从 text content 拼接 summary。

## Pi JSON event 映射

Pi `--mode json` 输出第一行 session header，后续是 AgentSessionEvent。核心事件：

- `agent_start`
- `agent_end`
- `turn_start`
- `turn_end`
- `message_start`
- `message_update`
- `message_end`
- `tool_execution_start`
- `tool_execution_update`
- `tool_execution_end`
- `compaction_start`
- `compaction_end`
- `auto_retry_start`
- `auto_retry_end`

PatchPilot 映射：

| Pi event | PatchPilot event | Evidence |
| --- | --- | --- |
| session header | internal metadata | `sessionId`, `cwd`, session version |
| `agent_start` | `agent.started` | lifecycle |
| `message_update` text delta | `agent.output` | streaming progress |
| `message_end` assistant | agentMessages | final and intermediate assistant text |
| `message_update` thinking delta | reasoningSummaries | if present and safe |
| `tool_execution_start` | `agent.tool.started` | tool name, args |
| `tool_execution_update` | tool call partial | optional artifact, not every chunk as AgentRun event |
| `tool_execution_end` | `agent.tool.completed` / `agent.tool.failed` | status, result, command if bash |
| `agent_end` | internal completion | new messages, retry state |
| `auto_retry_*` | `agent.progress` | retry evidence |
| `compaction_*` | `agent.progress` | compaction evidence |

Pi MVP 不应把 Pi progress 写成 `codex.started` 或 `codex.output`。第一版 Pi PR 就新增 provider-neutral events：

```ts
| "agent.started"
| "agent.output"
| "agent.tool.started"
| "agent.tool.completed"
| "agent.tool.failed"
| "agent.progress"
```

`codex.started` / `codex.output` 保留为 Codex 兼容事件。UI、SSE、contracts 和 telemetry 可以在展示层把旧 Codex 事件归一为通用 progress，但 product state 里不能把 Pi 伪装成 Codex。这样会增加首个 PR 的 schema/UI 变更量，但避免污染 AgentRun evidence 和后续审计语义。

Unknown Pi event handling:

- 原始 JSONL 进入 tier 3 artifact，先 redaction 后持久化。
- 未识别 event 不应使 successful run 失败，除非它携带明确 error 或破坏必需 lifecycle。
- parser 记录 `agent.progress` summary，包含 event type、redacted short summary 和 raw artifact reference。
- golden fixtures 覆盖已知 event，同时 fuzz/fixture 测试覆盖 unknown event。

### Tool call extraction

Pi tool events provide:

```json
{
  "type": "tool_execution_start",
  "toolCallId": "...",
  "toolName": "bash",
  "args": { "command": "pnpm test" }
}
```

Normalize to:

```ts
{
  id: toolCallId,
  name: toolName,
  status: "started" | "completed" | "failed",
  summary: "...",
  command: args.command,
  exitCode: result.exitCode,
  startedAt,
  endedAt,
  durationMs
}
```

For `write` and `edit`, include file path and patch/diff summary when present. Large tool output should become artifacts, not AgentRun event payloads.

## Command policy

`packages/policy` currently allows `codex exec*` and `codex --version`. Add Pi:

```ts
const defaultCommandAllow = [
  "codex exec*",
  "codex --version",
  "pi --mode json*",
  "pi --mode rpc*",
  "pi --version",
  ...
];
```

For MVP, only allow `pi --mode json*` and `pi --version`. Add `pi --mode rpc*` when RPC adapter lands.

The allowlist must match the configured Pi binary path as well as arguments. If `PATCHPILOT_PI_COMMAND` is an absolute fake or platform-managed binary path, policy should allow that exact path for the run instead of any executable named `pi` on `PATH`.

Important distinction:

- Command policy controls PatchPilot launching `pi`.
- Pi's internal `bash` tool then executes commands inside the Pi process.

Therefore PatchPilot's command wrapper cannot see every Pi tool `bash` command unless:

1. Pi is run inside PatchPilot's container sandbox and egress policy, and
2. future SDK/custom tools replace Pi's bash operations with PatchPilot audited wrappers, or
3. Pi extensions are used to intercept tool calls, which should not be the MVP default.

For MVP, rely on container sandbox plus Pi JSON tool events for observability. Do not claim full per-command pre-execution enforcement for Pi internal bash until SDK/custom tool wrapping exists. This distinction must be visible in runtime evidence as:

```json
{
  "internalToolCommandPolicy": "observed_after_execution",
  "preExecutionCommandPolicy": "pi_process_only"
}
```

生产可强制执行状态：

- `pi --mode json` + Pi built-in `bash` 暴露时，可以保留完整 Pi 能力，但必须如实记录 PatchPilot 对内部 tool action 的 enforcement level。
- 若某个 deployment tier 要求逐命令预执行授权，则 production-enforceable Pi run 必须满足以下任一条件：
  - 使用 Pi SDK/custom tools，让 shell、file write、edit、network-affecting actions 进入 PatchPilot command/path/network/secret wrapper；
  - 或引入经 Capability Manifest 审核的 platform-owned Pi extension，能在工具执行前调用 PatchPilot policy decision，并有独立 contract/E2E 证明；
  - 或该 tier 明确批准 observed-after-execution 模式，并把它记录为 reduced assurance / approved degraded evidence。
- 不建议通过 `--tools` 排除 `bash` 或其他 shell-capable tools 作为默认安全策略；这会削弱 Pi 的 coding agent 能力。只有特定 deployment tier 明确选择 reduced-tool mode 时，才可作为显式、可审计的能力配置。
- 只靠 JSON event 事后观察 `tool_execution_*` 不满足 ADR-0009 对 command wrapper 预执行授权的严格要求，但可以作为 local、CI、preview 或经批准降级 tier 的 evidence。

## Container sandbox

Pi must use the same sandbox rules as Codex:

- run in dedicated worktree;
- optional local rootless Docker/Podman sandbox;
- production gVisor RuntimeClass when worker-pool execution exists;
- no host home mount;
- no Docker socket;
- no SSH agent;
- bounded CPU, memory, pids, tmpfs, workspace disk;
- egress allowlist enforced externally.

Container command should launch the entire Pi process inside the sandbox. This is simpler and safer than running host Pi while only routing Pi's tools into a sandbox.

Production / unattended rule:

- If sandbox runtime is required and unavailable, `runner=pi` fails before launching Pi.
- If egress policy is required and unavailable, `runner=pi` fails before launching Pi.
- If a requested secret cannot be brokered through the active Capability Manifest, `runner=pi` fails before launching Pi.
- Runtime fallback from gVisor to rootless Docker/Podman or host execution requires the same approval rules as ADR-0011 / ADR-0009.
- If the target execution tier requires pre-execution command enforcement and Pi would expose built-in `bash`, `runner=pi` fails before launching Pi unless an approved SDK/custom-tool/extension enforcement path or approved degraded evidence mode is active.

If container sandbox is disabled, Pi runs with host user permissions. That is acceptable only for explicit local development mode and should be reported in runtime evidence as reduced isolation. The API should expose this as `degraded` or `local_unsafe`, not as production-ready availability.

## Network policy

Codex path currently assumes OpenAI/Codex endpoints. Pi supports many providers:

- Anthropic
- OpenAI
- Google
- GitHub Copilot
- DeepSeek
- Mistral
- xAI
- OpenRouter
- Vercel AI Gateway
- many others

The egress allowlist must become provider-aware. MVP rule:

1. Support only explicitly selected provider(s), initially `anthropic` and/or `openai`.
2. Require `PATCHPILOT_PI_PROVIDER` or equivalent config for real Pi runs. Unknown/empty provider is allowed only for fake Pi tests.
3. Require exact egress host mappings for the selected provider before launch.
4. Fail closed when provider is unknown, mapping is missing, egress policy is disabled in production/unattended mode, or host wildcard would broaden access beyond approved policy.
5. User-configured `PATCHPILOT_EGRESS_ALLOWED_HOSTS` can add exact hosts, but broad public egress or wildcard expansion requires an approval.

Suggested initial provider host mapping starts with exact API hosts only:

```text
openai: api.openai.com
anthropic: api.anthropic.com
```

OAuth/auth hosts, Copilot, Google, OpenRouter, Vercel AI Gateway, and other providers are follow-up work. They need provider-specific smoke tests, secret binding, and egress evidence before being advertised. This map should live in policy/config, not in prompt text.

## Secret Broker

Pi authentication can come from:

- API key env vars;
- Pi `auth.json` in `PI_CODING_AGENT_DIR`;
- provider-specific OAuth or subscription login.

MVP recommendation:

- Prefer API keys injected via Secret Broker for CI and unattended runs.
- MVP supports API-key auth first. Platform-owned Pi OAuth/subscription auth is a follow-up unless explicitly approved for a single deployment.
- If provider OAuth is later allowed, permit it only through platform-owned `PI_CODING_AGENT_DIR`, not user personal `~/.pi/agent`.
- Do not copy host `auth.json`.
- Redact known secrets from Pi stdout/stderr and AgentRun events.
- Do not write plaintext API keys, OAuth files, or provider session state into the worktree.

Secret examples:

```yaml
security:
  secretBroker:
    allowedSecrets:
      - id: anthropic-api-key
        envVar: ANTHROPIC_API_KEY
        environment: dev
        provider:
          kind: env
          sourceEnv: PATCHPILOT_ANTHROPIC_API_KEY
```

WorkItem capability:

```text
secret:anthropic-api-key
```

The active Capability Manifest must list the secret before injection.

## Session strategy

### MVP

Use ephemeral sessions:

```bash
--no-session
```

Pros:

- no cleanup burden;
- no accidental cross-run context leakage;
- deterministic enough for CI;
- smaller provider metadata surface.

Cons:

- repair pass starts a new Pi session;
- no Pi-native resume;
- less context continuity.

Repair pass still works because workspace files and test output encode current state.

### Future RPC

Use per-run session dir:

```env
PI_CODING_AGENT_SESSION_DIR=<patchpilot-state>/runner/pi/<runId>/sessions
```

Store:

- `sessionId`
- `sessionFile`
- `sessionName`
- provider/model/thinking
- last assistant text

The session directory remains platform-owned execution state outside `workspace.path`. A sanitized summary or export may become an artifact, but the session files themselves must not be committed or exposed as project files.

This enables:

- explicit cancel via RPC `abort`;
- state query via `get_state`;
- final text via `get_last_assistant_text`;
- HTML export via `export_html`;
- resume by `--session` or RPC `switch_session`.

## Test strategy

### Unit tests

1. `parseRunner()` accepts `pi` in CLI and worker.
2. `readPatchPilotConfig()` accepts `PATCHPILOT_RUNNER=pi` and YAML `dev.runner: pi`.
3. `startRunSchema` accepts `{ runner: "pi" }` and rejects unknown values.
4. OpenAPI runner enum includes `pi`.
5. DB schema enum includes `pi`.
6. DB migration adds `pi` through a new migration and updated Drizzle snapshot, without editing historical migrations.
7. `resolveRunner("pi")` returns `pi` and does not coerce to Codex.
8. Runner registry selects `LocalPiRunner`.
9. Runner availability returns `available/degraded/unavailable` with reason and mode, not only boolean.
10. Runtime config preserves `configuredRunner: "auto"` separately from `activeRunner`.
11. Pi command builder creates expected args and env without host-only variables.
12. Pi command builder does not load global/parent AGENTS or CLAUDE files, while preserving worktree-scoped or platform-owned context/resources when available.
13. Pi command builder rejects or rewrites `agentDir` / `sessionDir` that resolve inside `workspace.path`.
14. Pi availability checks version compatibility and Node engine compatibility.
15. Production/unattended Pi launch fails closed when sandbox, egress policy, Capability Manifest, or Secret Broker prerequisites are missing.
16. Production-enforceable Pi launch records whether built-in `bash` is pre-authorized, wrapper-enforced, or observed-after-execution under an approved degraded mode; tiers that require strict pre-execution policy fail closed when no enforcement path exists.
17. Provider policy rejects unknown provider, empty real provider, broad wildcard egress, and missing exact host mapping.
18. Summary artifact handling proves `.patchpilot-pi-*.md` does not enter changed files, diff, or commit.
19. `parsePiEvent()` extracts:
   - session header;
   - assistant text;
   - text deltas;
   - tool start/end;
   - bash command and exit code;
   - failure/error messages.
20. `parsePiEvent()` stores unknown events as redacted progress/artifact evidence without breaking successful runs.
21. Pi final assistant message is written to summary path.

### Contract tests

Update:

- OpenAPI generated JSON.
- run events schema for provider-neutral `agent.*` event names.
- telemetry runner enum tests.
- Prometheus runner labels should accept `pi`.
- Runtime config schema includes Pi availability/degraded reason without removing `codexAvailable` compatibility in the first step.
- Runtime config schema distinguishes `configuredRunner` from `activeRunner`.

### Runner tests with fake Pi

Avoid real LLM calls in automated tests. Use a fake executable:

```bash
#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", id: "fake-pi-session", cwd: process.cwd() }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "tool_1",
  toolName: "write",
  args: { path: "src/example.ts" }
}));
// mutate workspace file here
console.log(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "Done." }] }
}));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
```

Set:

```env
PATCHPILOT_PI_COMMAND=/tmp/fake-pi
PATCHPILOT_RUNNER=pi
```

This validates worktree, event parsing, test execution, diff collection, commit, and result shape without external API calls.

Add golden JSONL fixtures captured from the pinned Pi version:

```text
packages/codex-runner/fixtures/pi-0.79.3/success.jsonl
packages/codex-runner/fixtures/pi-0.79.3/tool-failure.jsonl
packages/codex-runner/fixtures/pi-0.79.3/unknown-event.jsonl
```

The parser tests use these fixtures to detect Pi protocol drift before a real provider smoke reaches CI or a developer machine.

### E2E

Add:

```bash
pnpm e2e:pi-simple
```

Initial version should use fake Pi. A real Pi smoke can be opt-in:

```bash
PATCHPILOT_REAL_PI=1 PATCHPILOT_RUNNER=pi pnpm e2e:pi-simple
```

Real smoke prerequisites:

- `pi --version` works;
- Pi version satisfies the pinned compatibility window;
- selected provider credentials available through Secret Broker or platform-owned Pi auth dir;
- selected provider is explicitly configured;
- exact egress hosts configured;
- git workspace available.
- sandbox mode explicitly recorded; production smoke requires sandbox and egress policy, local smoke may record reduced isolation only when explicitly requested.

## UI changes

MVP UI can stay minimal:

- Runtime config shows `Codex: available/unavailable` and `Pi: available/unavailable`.
- Start buttons or CLI can pass runner override.
- Run detail labels use:
  - `Codex` for `codex`;
  - `Pi` for `pi`.

Avoid exposing model/provider selection in UI until backend config is stable.

Long-term:

- Project settings page for default runner.
- WorkItem run dialog with runner override.
- Evidence tab shows provider event stream.
- Runner availability health component.

## CLI and worker changes

CLI:

```text
start-team --prd <prd-id> [--runner codex|pi]
worker-once [--runner codex|pi]
happy-path --input <text> [--template feature|bug|ui|document] [--runner codex|pi] [--out report.md]
```

Worker:

```env
PATCHPILOT_WORKER_RUNNER=pi
```

Worker parser should reject invalid runner values with a useful error, not silently ignore them. Current worker parser returns `undefined` for unknown values; that behavior can hide typos. Recommended:

- CLI: throw on invalid value.
- Worker config: throw or log fatal on invalid value.
- API: schema validation rejects invalid value.

## Audit and telemetry

Audit events should use provider-neutral actor/action where possible:

Current:

```text
actor: "codex_runner"
action: "codex_run.completed"
```

Recommended:

```text
actor: "<runner>_runner" # codex_runner or pi_runner
action: "agent_run.provider_completed"
metadataJson: { runner: "pi", providerSessionId: "...", providerMode: "json" }
```

Metrics:

- Keep runner label cardinality bounded to `codex`, `pi`, `other`.
- Do not add model id as high-cardinality label unless explicitly controlled.
- Token/cost data can be stored in AgentRun result or artifacts when Pi exposes it.

Artifacts:

- Store raw Pi JSONL as tier 3 raw run artifact.
- Store final assistant summary as tier 1 product evidence.
- Store parsed tool calls in AgentRun result.
- Store large bash output as test/command artifacts when available.

## Rollout plan

### Milestone 0：方案确认

- Confirm MVP uses `pi --mode json`, not RPC/SDK.
- Confirm `auto` remains Codex.
- Confirm Codex and Pi capabilities are not artificially reduced; security controls live in PatchPilot's run-scoped outer boundary.
- Confirm Pi does not inherit host/global/personal resources, while worktree-scoped or platform-owned Pi resources can be used with evidence.
- Confirm Pi MVP uses API-key auth via Secret Broker unless a deployment explicitly approves platform-owned OAuth.
- Confirm `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are outside the task worktree.
- Confirm production/unattended Pi launch fails closed without sandbox, egress policy, active Capability Manifest, and authorized secret grants.
- Confirm Pi JSON + built-in `bash` keeps full tool capability; deployment tiers that cannot pre-authorize internal tool action must record the enforcement gap and either fail closed or enter an approved degraded mode.
- Confirm initial real-provider support is limited to exact-host mappings for `anthropic` and/or `openai`.
- Confirm Pi emits provider-neutral `agent.*` events from the first Pi implementation.
- Confirm pinned Pi compatibility version and golden JSONL fixtures.
- Confirm DB migration strategy uses a new migration after the current `0007` snapshot.

### Milestone 1：Type, schema, config

- Add `pi` to domain runner kind.
- Add DB enum migration.
- Add API schema and OpenAPI enum.
- Add config env/YAML parsing.
- Add CLI/worker parser support.
- Add policy allowlist entries for Pi.
- Add provider-neutral AgentRun event schema.
- Split configured runner enum from active runner enum in runtime config.
- Add docs and `.env.example`.

### Milestone 2：Runner registry

- Introduce runner registry.
- Keep existing Codex runner behavior unchanged.
- Route `runner=codex` to LocalCodexRunner.
- Route `runner=pi` to LocalPiRunner.
- Keep old tests passing with injected runner.

### Milestone 3：LocalPiRunner JSON MVP

- Implement Pi availability.
- Build Pi command args/env.
- Enforce run-scoped Pi state directories outside the worktree.
- Enforce provider, egress, sandbox, and Secret Broker preflight checks.
- Parse Pi JSON events.
- Write final summary file.
- Reuse workspace/test/repair/diff/commit flow.
- Add fake Pi runner tests.

### Milestone 4：E2E and docs

- Add fake Pi E2E.
- Add opt-in real Pi smoke.
- Document setup and security posture.
- Update README runtime section.

### Milestone 5：RPC/SDK follow-up

- Add `pi --mode rpc` adapter only after MVP stabilizes.
- Add cancel/resume/event stream tests.
- Decide whether SDK is worth the dependency and in-process complexity.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Pi has no built-in sandbox | Unattended runs could access host resources | Always run in PatchPilot worktree and sandbox; no host HOME; no Docker socket |
| Pi project trust loads unreviewed worktree code before the agent acts | Arbitrary project code can run before the agent acts | Treat it as normal agent capability only inside the run sandbox; record loaded resources as evidence |
| Pi context discovery loads global or parent AGENTS/CLAUDE files | Unreviewed host instructions can steer the run | Scope native loading to the worktree or platform-owned resources; block host/global/parent inheritance |
| Pi internal bash bypasses PatchPilot command wrapper | Policy sees only `pi` process, not every internal command | Keep Pi capability; container sandbox and egress policy for MVP; SDK/custom tools later for pre-command enforcement |
| JSON MVP is mistaken for production-enforceable execution | Operators may overtrust after-the-fact tool events | Availability mode must report `preview`/`local_unsafe`; production-enforceable requires pre-execution tool policy |
| Provider egress differs by model | Runs fail or egress widens too much | Provider-specific allowlist, fail closed, explicit config |
| Broad egress wildcard hides exfiltration paths | Provider can reach unexpected public services | MVP exact-host provider mapping; wildcard requires approval |
| Skills differ from Codex slash commands | `/tdd` and `/diagnose` may not work in Pi | Bundle Pi-compatible skills or use plain prompt instructions |
| Summary output has no `-o` equivalent | Artifact collection lacks final message | Parse final assistant text and write summary file ourselves |
| `auto` fallback surprises users | Same WorkItem may run on different provider | MVP keeps `auto -> codex`; fallback requires explicit future approval |
| Personal Pi auth leakage | User credentials enter run | Platform-owned `PI_CODING_AGENT_DIR`, Secret Broker, no host HOME |
| Pi state dir lands inside worktree | Auth/session state can be read, changed, committed, or leaked | State dirs must be absolute platform-owned paths outside workspace; tests reject workspace-contained paths |
| Pi JSON event protocol drifts | Parser silently drops important evidence | Pin compatibility version, golden fixtures, unknown-event handling, opt-in real smoke |
| Tests accidentally call real LLM | CI cost and flake | Fake Pi executable for automated tests; real smoke opt-in only |

## Open decisions

1. Which exact provider(s) should be enabled first: Anthropic, OpenAI, or both?
2. Should PatchPilot bundle Pi-specific TDD/diagnose skills, or use provider-neutral plain prompts first?
3. What Pi version compatibility window should the first implementation accept beyond the pinned `0.79.3` fixtures?
4. Should platform-owned Pi OAuth/subscription auth be added after API-key MVP, and what approval/evidence should govern it?
5. Should the package `@patchpilot/codex-runner` be renamed soon, or should it remain as a legacy package until durable runner work begins?
6. For the first real Pi run, which deployment tiers may keep built-in `bash` with observed-after-execution evidence, and which tiers require SDK/custom tool enforcement before launch?

## Recommended MVP acceptance criteria

1. `PATCHPILOT_RUNNER=pi` starts a WorkItem through the API.
2. `POST /api/work-items/:id/start` accepts `{ "runner": "pi" }`.
3. An AgentRun and WorkspaceRun persist `runner: "pi"`.
4. Pi executes inside the prepared worktree and does not inherit host HOME, SSH agent, Docker socket, cloud credential env, or unrelated host env.
5. Pi `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` are absolute platform-owned paths outside the worktree.
6. Pi does not inherit host/global/personal context or resources; worktree-scoped and platform-owned context/resources remain available and are recorded as evidence.
7. Production/unattended `runner=pi` fails before launch when sandbox, egress policy, active Capability Manifest, or authorized Secret Broker grant is missing.
8. Pi keeps built-in `bash` and other coding tools unless a deployment tier explicitly requires a different enforcement path; tiers that need pre-execution command policy fail before launch or enter an approved degraded mode when only observed-after-execution evidence is available.
9. Local or preview Pi runs with reduced isolation require explicit local/dev mode and record degraded runtime evidence.
10. Real Pi runs require an explicit supported provider and exact egress host mapping.
11. Pi JSONL events are parsed into provider-neutral `agent.*` progress events, assistant messages, and tool calls.
12. Raw Pi JSONL is stored as a redacted tier 3 artifact; unknown events are retained as artifact-backed progress evidence.
13. Configured tests run after Pi completes.
14. Test failure triggers one Pi repair pass when configured.
15. Diff and commit evidence are collected exactly like Codex, excluding Pi agent/session state and `.patchpilot-pi-*.md` summary files.
16. Fake Pi E2E passes without real provider credentials.
17. Real Pi smoke can be run manually with documented prerequisites.
18. Existing Codex tests and E2E paths remain unchanged.
19. Runtime config reports Pi availability, degraded/unavailable reasons, and separates `configuredRunner` from `activeRunner`.

## Summary

Pi can be added as a second PatchPilot coding-agent底座 with low product-model disruption if the first implementation treats it as another provider behind the runner boundary. The correct MVP is not a full SDK integration. It is a JSON CLI adapter that reuses PatchPilot's existing workspace, policy, sandbox, test, artifact, and audit shell.

The most important design constraint is security: Pi deliberately has no built-in sandbox. PatchPilot must keep policy and isolation outside Pi, use platform-owned configuration, avoid host/global/personal inheritance, and record Pi as provider evidence rather than as a trusted control plane. PatchPilot should not artificially limit Codex or Pi capabilities; JSON CLI with Pi built-in `bash` is a useful MVP and preview path, and stricter deployment tiers must record or enforce the internal tool-action gap explicitly instead of silently reducing provider behavior.
