# 引入 provider-neutral agent.* AgentRun evidence

Status: done
Type: AFK

## What to build

新增 provider-neutral AgentRun progress event vocabulary，使 Pi 事件不会被伪装为 Codex 事件。Codex 兼容事件继续存在，展示层和 SSE 可以同时消费旧 Codex event 和新的 `agent.*` event，但产品状态、contract schema、UI label 和测试应能表达 Pi 作为独立 provider 的 evidence。

## Acceptance criteria

- [x] AgentRun event type 支持 `agent.started`、`agent.output`、`agent.tool.started`、`agent.tool.completed`、`agent.tool.failed` 和 `agent.progress`。
- [x] `codex.started` 和 `codex.output` 保持兼容，现有 Codex runner 输出不被破坏。
- [x] API snapshot、SSE、OpenAPI、event schema 和前端展示能接收 provider-neutral agent events。
- [x] Audit 和 workflow 文案在新增路径中使用 provider-neutral wording，不新增 Pi 伪装成 Codex 的事件。
- [x] Raw provider stream 不进入 AgentRun event payload；大内容仍通过 artifact reference 或摘要表达。
- [x] 单元和 contract tests 覆盖 Codex legacy event 与 provider-neutral event 共存。

## Verification

- `pnpm --filter @patchpilot/domain typecheck`
- `pnpm --filter @patchpilot/contracts typecheck`
- `pnpm --filter @patchpilot/api typecheck`
- `pnpm --filter @patchpilot/web typecheck`
- `pnpm --filter @patchpilot/workflows typecheck`
- `pnpm --filter @patchpilot/codex-runner typecheck`
- `pnpm --filter @patchpilot/contracts test`
- `pnpm openapi:check`
- `pnpm events:check`
- `pnpm --filter @patchpilot/web test`
- `pnpm --filter @patchpilot/api test -- server.test.ts -t "provider-neutral agent events"`
- `pnpm --filter @patchpilot/codex-runner test`
- `pnpm --filter @patchpilot/workflows test`

## Blocked by

- .scratch/pi-runner/issues/01-confirm-pi-mvp-security-and-runtime-boundary.md
