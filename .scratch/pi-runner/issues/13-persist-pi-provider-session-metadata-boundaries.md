# 持久化 Pi provider session metadata 和 artifact 边界

Status: ready-for-agent
Type: AFK

## Parent

- .scratch/pi-runner/issues/10-decide-pi-rpc-sdk-durable-adapter-path.md

## What to build

为 Pi durable adapter 增加 provider session metadata 的持久化和 redaction 边界。PatchPilot 应能记录可恢复、可诊断的 provider-neutral metadata，同时确保 Pi auth state、session files、raw transcripts、tool output 和 provider-private data 不进入 worktree、product-state plaintext 或未受控事件 payload。

## Acceptance criteria

- [ ] AgentRun result 或关联 artifact metadata 能记录 runner surface、Pi provider、model/thinking、version、session id/name/file reference、resume/cancel/state support 和 artifact ids。
- [ ] Pi agent/session/auth state root 明确位于 run-scoped platform state 目录，且不能被 workspace diff、commit 或 artifact sweep 当作项目文件收集。
- [ ] Raw Pi transcript、RPC stream、session export 和 large tool output 作为 redacted artifacts 保存，带 checksum、content type、retention tier 和 run/work item links。
- [ ] Product state、Audit Event、OpenTelemetry 和 generated artifacts 不包含 plaintext API keys、OAuth tokens、host HOME、SSH agent、Docker socket 或 cloud credential env。
- [ ] Redaction tests 覆盖 provider env secret、Pi session file excerpt、tool output 和 RPC transcript。
- [ ] README 或 docs/pi-runner.md 更新 metadata retention 和 redaction 操作说明。

## Blocked by

- .scratch/pi-runner/issues/11-define-provider-neutral-durable-runner-contract.md
