# 决策 Pi RPC / SDK durable adapter 后续路径

Status: done
Type: HITL

## What to build

在 Pi JSON CLI MVP 跑通后，决策是否推进 Pi RPC adapter 或 Pi SDK adapter，以及 durable runner contract 需要怎样扩展 cancel、resume、stream、artifact collection、session state 和 provider metadata。该切片应避免在 MVP 中提前承诺生产 durable semantics，同时为后续架构工作留下清晰入口。

## Acceptance criteria

- [x] 评审 Pi JSON CLI MVP 的真实运行证据、parser fixture、security preflight 和 E2E smoke 结果。
- [x] 决定下一步优先推进 `pi --mode rpc`、Pi SDK、继续 JSON CLI preview，或暂停 Pi durable work。
- [x] 明确 cancel、resume、stream、state inspection、artifact collection 和 session export 的产品级需求。
- [x] 明确 Pi session state、auth state 和 provider metadata 的存储、redaction、retention 和 artifact 边界。
- [x] 明确 SDK/custom tools 是否是达到 production-enforceable pre-execution command policy 的必要路径。
- [x] 若推进 RPC 或 SDK，产出新的 AFK implementation issues；若暂缓，记录暂缓原因和重新评估条件。

## Decision

- 继续把 `pi --mode json` 作为 local / CI / preview adapter，不把它提升为 production durable semantics。
- 先定义 provider-neutral durable runner contract，再推进 `pi --mode rpc` preview。
- 暂缓直接 Pi SDK embedding；SDK/custom tools 或 platform-owned Pi extension 是 production-enforceable Pi 内部 tool pre-execution policy 的必要候选路径，但必须进入同一个 durable runner contract。
- 不通过默认减少 Pi/Codex tool capability 来获得安全 posture；安全边界仍由 PatchPilot 外层 worktree、sandbox、egress、Secret Broker、Capability Manifest、Audit Event 和 artifact evidence 提供。

## Published follow-up issues

- .scratch/pi-runner/issues/11-define-provider-neutral-durable-runner-contract.md
- .scratch/pi-runner/issues/12-add-fake-pi-rpc-durable-adapter-preview.md
- .scratch/pi-runner/issues/13-persist-pi-provider-session-metadata-boundaries.md
- .scratch/pi-runner/issues/14-prototype-pi-sdk-custom-tool-policy-bridge.md

## Verification

- Reviewed completed issues 05, 06, 08, and 09.
- Added `docs/adr/0012-pi-durable-adapter-path.md`.
- Published AFK follow-up issues 11-14.

## Blocked by

- .scratch/pi-runner/issues/05-implement-fake-pi-json-happy-path.md
- .scratch/pi-runner/issues/06-complete-pi-json-failure-repair-and-unknown-event-evidence.md
- .scratch/pi-runner/issues/08-add-fail-closed-pi-security-preflight.md
- .scratch/pi-runner/issues/09-add-pi-e2e-smoke-and-docs.md
