# Pi runner 运行手册

PatchPilot 的默认 runner 仍是 Codex。`dev.runner: auto` 会解析为 `codex`，只有显式设置 `PATCHPILOT_RUNNER=pi`、`.patchpilot/config.yaml` 的 `dev.runner: pi`，或 API start body `{ "runner": "pi" }` 时才使用 Pi。

Pi 是 coding-agent provider，不是安全边界。Pi 没有内置 sandbox，内置工具可以编辑文件和执行 shell，权限等同启动 `pi` 的进程。PatchPilot 的安全 posture 来自外层 worktree、container sandbox、egress allowlist、Secret Broker、Capability Manifest、Audit Event 和 artifact evidence。不要通过删减 Codex 或 Pi 的工具、shell、编辑、测试、模型或上下文能力来获得安全感。

## 安装与配置

已验证的 Pi CLI 版本是 `0.79.3`，Node engine 要求 `>=22.19.0`。

```bash
node --version
pi --version
```

最小 Pi 配置：

```yaml
dev:
  runner: pi
  repositoryRoot: .
  workspaceRoot: .patchpilot/worktrees
pi:
  command: pi
  provider: fake # fake 只用于本地/E2E；真实运行使用 openai 或 anthropic
  stateRoot: .patchpilot/runner-state
  timeoutMs: 600000
```

真实 provider 运行前还需要：

- active Capability Manifest 中包含 provider secret capability，例如 `secret:openai-api-key`。
- Secret Broker 开启，并把该 secret 注入到 provider env var，例如 `OPENAI_API_KEY`。
- egress policy 使用 exact host，例如 OpenAI 只允许 `api.openai.com`，不要使用 `*.openai.com`。
- 生产或无人值守运行启用 container sandbox；本地 reduced isolation 必须显式设置 `PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE=1`。
- JSON CLI MVP 保留完整 Pi 内部工具能力；由于 Pi 内部 shell 只能事后观察，真实 smoke 需要显式设置 `PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY=1` 并记录 enforcement gap。

## Fake Pi E2E

默认 E2E 不需要真实 provider、API key 或外网：

```bash
pnpm e2e:pi-fake
```

这个脚本会启动临时 API、创建临时 git 项目和 fake `pi` CLI，通过 `POST /api/work-items/:id/start` 走完整 Pi runner 闭环，并验证：

- API runtime config 选择 Pi。
- isolated worktree 被创建并归档。
- `agent.*` 事件和 Pi tool evidence 被解析。
- `node test.mjs` 通过。
- diff、commit、local PR、review、audit event 和 artifacts 被记录。
- fake launch evidence 不包含 provider secret、host HOME、SSH agent、Docker socket 或 cloud credential env。

## Metadata 与 artifact 边界

Pi provider session metadata 会保存在 `AgentRunResult.providerMetadata` 中，用于恢复、诊断和审计。当前 JSON CLI surface 记录 `surface`、provider、model/thinking、Pi version、session id、run-scoped state refs、resume/cancel/state inspection/artifact collection 能力位，以及关联 artifact ids。

Pi agent/session/auth state 必须位于 run-scoped platform state root，例如 `.patchpilot/runner-state/pi/<runId>/...`。这些目录不是项目 workspace 内容，不能进入 workspace diff、commit，也不能被普通 artifact sweep 当作源码文件收集。

Raw Pi transcript、RPC stream、session export 和大体积 tool output 只通过 provider artifact source 进入 API。`sourcePath` 是 runner 到 API 的一次性内部输入；API 读取后会写入 redacted artifact，记录 checksum、content type、retention tier、run/work item links 和 redaction metadata，然后从 product state 删除 `providerArtifactSources`。

Product state、Audit Event、OpenTelemetry 和 generated artifacts 不应保存 plaintext provider secrets、OAuth tokens、host HOME、SSH agent、Docker socket 或 cloud credential env。需要排障时查看 redacted artifact 和 retention metadata，不要把 Pi/Codex 的工具、shell、编辑、测试、模型或上下文能力降级成安全边界。

## SDK/custom tool policy bridge prototype

`FakePiPolicyToolBridge` 验证了 Pi SDK 或 platform-owned custom tools 的候选强制路径：shell、file write、file edit、network-affecting action 和 secret-bound action 在执行前先调用 active Capability Manifest 的 command、repo write、egress host 和 secret policy。Denied action 会在 side effect 前返回 `policy_denied` evidence，不执行 shell、不写 workspace、不调用网络回调，也不返回 secret grant。

Allowed action 保持完整 coding-agent 能力路径：tool 可以继续写文件、编辑文件、访问 manifest 允许的网络目的地、读取已授权 secret grant，并运行测试命令。该原型不是通过默认减少 Pi/Codex 能力实现安全；生产路径应保持完整 Pi 能力，并把 PatchPilot policy bridge 放在 Pi 内部 tool action 的 pre-execution 边界。

## Real Pi Smoke

真实 smoke 默认跳过，避免 CI 或本地误触发真实 LLM 调用：

```bash
pnpm e2e:pi-real-smoke
```

显式运行示例：

```bash
export PATCHPILOT_PI_REAL_SMOKE=1
export PATCHPILOT_PI_PROVIDER=openai
export PATCHPILOT_PI_COMMAND=pi
export PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY=1
export PATCHPILOT_CONTAINER_SANDBOX_ENABLED=true
export PATCHPILOT_CONTAINER_SANDBOX_RUNTIME=auto
export PATCHPILOT_EGRESS_POLICY_ENABLED=true
export PATCHPILOT_EGRESS_ALLOWED_HOSTS=api.openai.com
export PATCHPILOT_SECRET_BROKER_ENABLED=true
export PATCHPILOT_SECRET_BROKER_ALLOWED_SECRETS='[{"id":"openai-api-key","envVar":"OPENAI_API_KEY","sourceEnv":"PATCHPILOT_DEV_OPENAI_API_KEY","environment":"ci"}]'
export PATCHPILOT_DEV_OPENAI_API_KEY=...
pnpm e2e:pi-real-smoke
```

如果本机没有可用 container runtime，只能作为显式本地降级 smoke：

```bash
export PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE=1
export PATCHPILOT_CONTAINER_SANDBOX_ENABLED=false
export PATCHPILOT_EGRESS_POLICY_ENABLED=false
```

这种模式会在 `securityPreflightEvidence.mode=local_unsafe` 中记录 reduced isolation。`internalToolCommandPolicy=observed_after_execution` 和 `preExecutionCommandPolicy=pi_process_only` 表示 PatchPilot 只在 Pi 进程启动前约束外壳命令，Pi 内部 tool command 是事后观察证据。多租户或无人值守生产不能依赖这个降级模式。

## Evidence 解读

Pi run 成功后，`AgentRunResult.securityPreflightEvidence` 会记录：

- `mode`: `fake`、`production` 或 `local_unsafe`。
- `provider`、`providerHost`、`providerSecretId`: 真实 provider 的显式映射。
- `isolationMode`: `rootless_container` 或 `host_user`。
- `egressPolicy`: exact-host proxy、缺失映射、禁用降级或 fake 禁用。
- `secretBroker`: secret 是否通过 broker 注入，或为何未授权。
- `internalToolCommandPolicy` / `preExecutionCommandPolicy`: Pi 内部 tool action 的可执行策略证据。
- `enforcementGaps`: 当前 JSON CLI MVP 已知 gap，例如 `pi_internal_tool_pre_execution`。

失败时，run 会保留 `failureType` 和失败摘要；真实 provider preflight 会区分 `policy_denied`、`environment_failed`、unsupported provider、missing exact egress host、missing manifest grant 和 explicit local unsafe degraded path。
