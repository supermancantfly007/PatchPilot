# 用 RunnerRegistry 路由 Codex 和 Pi runner

Status: done
Type: AFK

## What to build

引入 provider registry，使 API store 和执行入口不再只持有单个 Codex runner。Codex runner 行为保持原样，Pi runner 先可用 fake 或 stub adapter 接入同一 one-shot run boundary。显式 `runner=codex` 路由到 Codex，显式 `runner=pi` 路由到 Pi，`auto` 继续路由到 Codex。

## Acceptance criteria

- [x] Runner registry 能按 runner kind 返回对应 adapter，并能汇总各 runner availability。
- [x] 现有注入式 Codex runner 测试继续通过，兼容旧 test setup。
- [x] API start run 根据 request override、config 和 `auto` 规则选择 runner，不再把所有 override 强制转成 Codex。
- [x] Runtime config 暴露 Codex 和 Pi 的 availability summary，保留旧 `codexAvailable` 兼容字段。
- [x] Pi adapter 尚未真实执行时，也能以明确 unavailable 或 fake/test mode 表达状态。
- [x] 缺失或未知 runner kind 会失败并产生可诊断错误，不 fallback 到 Codex。
- [x] 单元测试覆盖 registry selection、`runner=codex`、`runner=pi`、`auto` 和 invalid runner。

## Verification

- `pnpm --filter @patchpilot/api typecheck`
- `pnpm --filter @patchpilot/api test -- server.test.ts -t "rejects unknown runner overrides before starting a Work Item"`
- `pnpm --filter @patchpilot/api test -- server.test.ts -t "Pi runs|unknown runner|provider-neutral agent events|runtime configuration"`
- `pnpm openapi:check`
- `pnpm events:check`

## Blocked by

- .scratch/pi-runner/issues/02-accept-pi-runner-kind-and-keep-auto-codex.md
- .scratch/pi-runner/issues/03-add-provider-neutral-agent-run-events.md
