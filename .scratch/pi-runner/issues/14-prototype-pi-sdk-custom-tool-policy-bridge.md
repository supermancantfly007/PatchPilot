# 原型验证 Pi SDK/custom tool pre-execution policy bridge

Status: done
Type: AFK

## Parent

- .scratch/pi-runner/issues/10-decide-pi-rpc-sdk-durable-adapter-path.md

## What to build

用 fake SDK 或 platform-owned custom tool fixture 验证 production-enforceable Pi 内部 tool pre-execution policy 的最小路径。该切片不要求接入真实 Pi SDK，但必须证明 shell、file write/edit、network-affecting action 可以在执行前调用 PatchPilot Capability Manifest / command / path / egress / secret policy，并且 denied action 不会执行。

## Acceptance criteria

- [x] Fake SDK/custom tool fixture 暴露 shell、file edit、file write 和 network-affecting tool action。
- [x] 每个 tool action 执行前调用 PatchPilot policy decision，使用 active Capability Manifest 和 run/workspace context。
- [x] Denied shell command、denied path write、denied egress host 和 missing secret grant 均在执行前失败，并记录 `policy_denied` evidence。
- [x] Allowed tool action 保持完整 coding-agent 能力路径，能继续编辑文件、运行测试并返回 normalized AgentRun tool evidence。
- [x] Contract tests 证明 denied actions 没有改变 workspace、没有发起网络请求、没有泄漏 secret。
- [x] 文档明确该路径是 production-enforceable Pi command policy 的候选，不是通过默认减少 Pi/Codex 能力实现安全。

## Verification

- `pnpm --filter @patchpilot/policy test -- index.test.ts`
- `pnpm --filter @patchpilot/codex-runner test -- piPolicyToolBridge.test.ts`
- `pnpm --filter @patchpilot/policy typecheck`
- `pnpm --filter @patchpilot/codex-runner typecheck`
- `pnpm lint:repo`

## Blocked by

- .scratch/pi-runner/issues/11-define-provider-neutral-durable-runner-contract.md
- .scratch/pi-runner/issues/13-persist-pi-provider-session-metadata-boundaries.md
