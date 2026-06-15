# 定义 provider-neutral durable runner contract

Status: done
Type: AFK

## Parent

- .scratch/pi-runner/issues/10-decide-pi-rpc-sdk-durable-adapter-path.md

## What to build

定义 PatchPilot 内部 provider-neutral durable runner contract，让 Codex CLI、Pi JSON CLI、后续 Pi RPC 和 SDK adapter 都能通过同一生命周期接口表达 start、resume、cancel、stream、artifact collection、failure summary 和 provider handle metadata。该切片应保留现有 one-shot runner 兼容路径，同时提供 contract tests 和 fake adapters 证明 durable contract 的语义。

## Acceptance criteria

- [x] Durable runner contract 覆盖 `start`、`resume`、`cancel`、`streamEvents`、`collectArtifacts`、`summarizeFailure` 和 idempotency key。
- [x] Provider handle metadata 能表达 runner surface、session/thread id、workspace/run ids、status、startedAt、resume support、cancel support 和 artifact refs。
- [x] Contract tests 使用 fake adapter 验证 start success、duplicate idempotency key、resume supported、resume unsupported fallback、cancel acknowledged、cancel best-effort、stream terminal event 和 artifact collection。
- [x] 现有 `LocalCodexRunner` / `LocalPiRunner` one-shot API 保持兼容；当前 API start-run 和 E2E 不需要迁移。
- [x] 新 contract 使用 `AgentRun`、`WorkspaceRun`、`TestRun`、`ArtifactRecord`、`AuditEvent` 词汇，不继续扩大 Codex-only 命名。
- [x] 文档或 ADR cross-reference 说明该 contract 是 Pi RPC 和 SDK work 的前置条件。

## Verification

- `pnpm --filter @patchpilot/codex-runner test -- durableRunner.test.ts`
- `pnpm --filter @patchpilot/codex-runner typecheck`

## Blocked by

- .scratch/pi-runner/issues/10-decide-pi-rpc-sdk-durable-adapter-path.md
