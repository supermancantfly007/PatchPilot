# 接受 pi runner kind 并保持 auto -> codex

Status: done
Type: AFK

## What to build

让 PatchPilot 的公开和内部 runner 枚举接受 `pi`，同时保持现有 Codex 默认路径完全兼容。用户显式选择 Pi 时，API、CLI、worker、runtime config、schema、OpenAPI、database enum、policy allowlist 和 telemetry labels 都应能表达 Pi；未显式选择时，`auto` 仍解析为 Codex。

## Acceptance criteria

- [x] Domain runner kind 支持 `codex` 和 `pi`，并提供可复用的 runner kind 常量或等价单一来源。
- [x] 数据库 schema 通过新增 migration 接受 `runner='pi'`，历史 migration 不被改写。
- [x] API request schema 接受 `{ "runner": "pi" }` 并继续拒绝未知 runner。
- [x] Runtime config 区分 `configuredRunner` 的 `auto` 和真实 `activeRunner`，且 `auto` 仍解析为 Codex。
- [x] CLI 和 worker runner parser 接受 `pi`，并对无效值给出显式错误，不静默忽略 typo。
- [x] Policy command allowlist 允许启动 Pi JSON CLI 和 Pi version check，但不提前允许 RPC 模式。
- [x] OpenAPI 和事件 schema 生成物包含 `pi` runner 枚举。
- [x] Prometheus 或等价 telemetry runner labels 接受 `pi`，并保持 label cardinality 有界。
- [x] 现有 Codex API、CLI、worker、E2E 和测试 fixture 行为不变。

## Verification

- `pnpm --filter @patchpilot/domain typecheck`
- `pnpm --filter @patchpilot/contracts typecheck`
- `pnpm --filter @patchpilot/api typecheck`
- `pnpm --filter @patchpilot/cli typecheck`
- `pnpm --filter @patchpilot/worker typecheck`
- `pnpm --filter @patchpilot/db typecheck`
- `pnpm --filter @patchpilot/policy typecheck`
- `pnpm --filter @patchpilot/telemetry typecheck`
- `pnpm --filter @patchpilot/contracts test`
- `pnpm --filter @patchpilot/db test -- schema.test.ts`
- `pnpm --filter @patchpilot/policy test`
- `pnpm --filter @patchpilot/telemetry test -- prometheus.test.ts`
- `pnpm --filter @patchpilot/cli test`
- `pnpm --filter @patchpilot/worker test -- index.test.ts`
- `pnpm --filter @patchpilot/api test -- config.test.ts`
- `pnpm --filter @patchpilot/api test -- server.test.ts -t "runtime configuration|preserves auto"`

## Blocked by

- .scratch/pi-runner/issues/01-confirm-pi-mvp-security-and-runtime-boundary.md
