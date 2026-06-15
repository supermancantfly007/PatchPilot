# 实现 Pi availability、版本和 Node engine 检查

Status: done
Type: AFK

## What to build

让 Pi runner availability 能表达可用、降级和不可用，而不是只有 boolean。检查应覆盖 Pi binary 是否存在、`pi --version` 是否成功、版本是否落在当前验证窗口、当前 Node runtime 是否满足 Pi engine 要求，以及本地 fake Pi 测试模式是否被明确标记。

## Acceptance criteria

- [x] Availability 返回结构化状态：available、degraded 或 unavailable，并包含 reason、mode 和必要 details。
- [x] `pi --version` 成功时返回可诊断版本信息；ENOENT 和 non-zero exit 返回明确 unavailable reason。
- [x] Pi 版本低于或超出已验证兼容窗口时被标记为 unavailable 或 degraded，不静默进入真实 Work Item run。
- [x] 当前 Node runtime 不满足 Pi engine 要求时返回 unavailable，reason 包含当前版本和要求版本。
- [x] Fake Pi 测试模式与真实 Pi 模式在 availability evidence 中可区分。
- [x] Runtime config 和 health UI/API 能显示 Pi 可用、降级或不可用原因。
- [x] 单元测试覆盖 installed、missing、bad version、bad engine、fake mode 和 command failure。

## Verification

- `pnpm --filter @patchpilot/codex-runner test -- piRunner.test.ts`
- `pnpm --filter @patchpilot/codex-runner typecheck`
- `pnpm --filter @patchpilot/contracts test -- openapi.test.ts`
- `pnpm --filter @patchpilot/contracts typecheck`
- `pnpm --filter @patchpilot/domain typecheck`
- `pnpm --filter @patchpilot/api test -- server.test.ts`
- `pnpm --filter @patchpilot/api typecheck`
- `pnpm openapi:check`
- `pnpm events:check`

## Blocked by

- .scratch/pi-runner/issues/04-route-codex-and-pi-through-runner-registry.md
