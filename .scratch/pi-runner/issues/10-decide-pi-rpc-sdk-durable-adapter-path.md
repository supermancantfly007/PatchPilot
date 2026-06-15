# 决策 Pi RPC / SDK durable adapter 后续路径

Status: ready-for-human
Type: HITL

## What to build

在 Pi JSON CLI MVP 跑通后，决策是否推进 Pi RPC adapter 或 Pi SDK adapter，以及 durable runner contract 需要怎样扩展 cancel、resume、stream、artifact collection、session state 和 provider metadata。该切片应避免在 MVP 中提前承诺生产 durable semantics，同时为后续架构工作留下清晰入口。

## Acceptance criteria

- [ ] 评审 Pi JSON CLI MVP 的真实运行证据、parser fixture、security preflight 和 E2E smoke 结果。
- [ ] 决定下一步优先推进 `pi --mode rpc`、Pi SDK、继续 JSON CLI preview，或暂停 Pi durable work。
- [ ] 明确 cancel、resume、stream、state inspection、artifact collection 和 session export 的产品级需求。
- [ ] 明确 Pi session state、auth state 和 provider metadata 的存储、redaction、retention 和 artifact 边界。
- [ ] 明确 SDK/custom tools 是否是达到 production-enforceable pre-execution command policy 的必要路径。
- [ ] 若推进 RPC 或 SDK，产出新的 AFK implementation issues；若暂缓，记录暂缓原因和重新评估条件。

## Blocked by

- .scratch/pi-runner/issues/05-implement-fake-pi-json-happy-path.md
- .scratch/pi-runner/issues/06-complete-pi-json-failure-repair-and-unknown-event-evidence.md
- .scratch/pi-runner/issues/08-add-fail-closed-pi-security-preflight.md
- .scratch/pi-runner/issues/09-add-pi-e2e-smoke-and-docs.md
