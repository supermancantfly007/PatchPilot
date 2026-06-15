# 添加 fake Pi E2E、opt-in real Pi smoke 和运行文档

Status: done
Type: AFK

## What to build

添加 Pi runner 的端到端验证和运维文档。默认 E2E 使用 fake Pi，不需要真实 LLM provider、API key 或外网调用；真实 Pi smoke 只能 opt-in，并在文档中列出版本、provider、secret、egress、sandbox 和降级模式前提。

## Acceptance criteria

- [x] 新增 fake Pi E2E 命令，能在无真实 provider credentials 的环境中验证 API start run、worktree、event parsing、test、diff、commit 和 artifact。
- [x] 新增 opt-in real Pi smoke 命令，并默认跳过，避免 CI 意外调用真实 LLM。
- [x] Real smoke 启动前检查 Pi version、Node engine、provider config、secret grant、exact egress host、git workspace 和 sandbox evidence。
- [x] 文档说明如何安装或配置 Pi runner、如何使用 fake Pi、如何运行 real smoke、如何解释 preview/local unsafe evidence。
- [x] 文档明确 Pi 没有内置 sandbox，PatchPilot 的 worktree、sandbox、egress、Secret Broker、Capability Manifest 和 Audit Event 仍是安全边界。
- [x] 文档明确 PatchPilot 不应人为限制 Codex 或 Pi 的 coding agent 能力；安全 posture 来自外层隔离、授权、审计和 evidence，不来自删减 provider 工具。
- [x] README 或运行手册说明 `auto` 仍默认 Codex，Pi 需要显式选择。
- [x] Existing Codex E2E 和 happy path 文档不变。

## Verification

- `pnpm e2e:pi-fake`
- `pnpm e2e:pi-real-smoke`
- `node --check scripts/pi-e2e-lib.mjs && node --check scripts/e2e-pi-fake.mjs && node --check scripts/e2e-pi-real-smoke.mjs`
- `pnpm lint:repo`
- `pnpm --filter @patchpilot/api typecheck`

## Blocked by

- .scratch/pi-runner/issues/08-add-fail-closed-pi-security-preflight.md
