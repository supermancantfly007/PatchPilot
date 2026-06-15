# 添加 fake Pi RPC durable adapter preview

Status: done
Type: AFK

## Parent

- .scratch/pi-runner/issues/10-decide-pi-rpc-sdk-durable-adapter-path.md

## What to build

在 durable runner contract 后添加 Pi RPC preview adapter 的 fake-first 垂直切片。该切片不调用真实 LLM，而是用 fake `pi --mode rpc` 进程验证 start、resume、cancel、stream、state inspection 和 artifact collection 能穿过 provider-neutral contract，并保持 PatchPilot 的 worktree、Capability Manifest、Secret Broker、egress、test、diff、commit 和 audit 边界。

## Acceptance criteria

- [x] fake `pi --mode rpc` fixture 支持 prompt、abort、get_state、get_last_assistant_text 以及终态 JSONL/RPC 响应。
- [x] Pi RPC adapter 通过 durable runner contract 启动 fake RPC process，记录 provider handle metadata，并能 idempotently 复用同一 handle。
- [x] Resume path 能在同一 prepared workspace 中追加 prompt，并记录是复用 Pi session 还是重新链接新 session。
- [x] Cancel path 能终止或 abort fake RPC process，并记录 provider acknowledged / process killed / workspace retained evidence。
- [x] Stream events 规范化为 provider-neutral `agent.*` events，large/raw RPC transcript 进入 artifact 而不是 AgentRun event payload。
- [x] Fake Pi RPC E2E 覆盖 API start run、event stream、test、diff、commit、artifact、cancel 或 resume 的至少一个真实闭环。

## Verification

- `pnpm --filter @patchpilot/codex-runner test -- piRpcDurableRunner.test.ts`
- `pnpm --filter @patchpilot/codex-runner test -- durableRunner.test.ts`
- `pnpm --filter @patchpilot/policy test -- index.test.ts`
- `pnpm --filter @patchpilot/codex-runner typecheck`
- `pnpm --filter @patchpilot/policy typecheck`
- `pnpm e2e:pi-rpc-fake`
- `pnpm lint:repo`

## Blocked by

- .scratch/pi-runner/issues/11-define-provider-neutral-durable-runner-contract.md
