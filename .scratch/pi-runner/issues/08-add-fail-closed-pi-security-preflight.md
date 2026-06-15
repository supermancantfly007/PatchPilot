# 为 Pi launch 加 fail-closed 安全 preflight

Status: ready-for-agent
Type: AFK

## What to build

在 Pi 真正启动前执行安全 preflight，确保生产或无人值守 Pi run 在 sandbox、egress policy、Capability Manifest、Secret Broker、provider host mapping 或 pre-execution command policy 不满足要求时 fail closed。Local 或 preview 降级模式必须显式配置并记录 reduced isolation evidence。该 preflight 不应通过删减 Pi toolset 来解决问题；如果保留完整 Pi 能力但某个 deployment tier 只能事后观察内部 tool action，就必须记录 enforcement gap 并按 tier policy 决定是否允许运行。

## Acceptance criteria

- [ ] 真实 Pi run 要求显式支持的 provider；unknown、empty real provider 或未映射 provider 被拒绝。
- [ ] Provider egress 只接受 exact host mapping；broad wildcard 或缺失 mapping 在生产或无人值守模式下 fail closed。
- [ ] 请求的 provider secret 必须由 active Capability Manifest 授权，并通过 Secret Broker 注入；缺失 grant 或 broker failure 在启动前失败。
- [ ] 生产或无人值守 Pi run 在 required sandbox runtime 不可用时启动前失败。
- [ ] 生产或无人值守 Pi run 在 required egress policy 不可用时启动前失败。
- [ ] Pi 默认保留完整 tool capability，包括 shell-capable tools；当目标执行 tier 要求 pre-execution command enforcement 但当前只能事后观察内部 tool action 时，启动前按 tier policy 失败或显式进入 approved degraded mode，并记录 enforcement gap。
- [ ] Local 或 preview Pi run 可使用 reduced isolation，但必须显式配置，并记录 `internalToolCommandPolicy`、`preExecutionCommandPolicy` 和 isolation mode evidence。
- [ ] Pi 子进程 launch evidence 不包含 secret value、host HOME、SSH agent、Docker socket 或 cloud credential env。
- [ ] Audit 或 AgentRun evidence 能区分 policy denied、environment unavailable、provider unsupported 和 local unsafe degraded。
- [ ] 单元测试覆盖 sandbox missing、egress missing、manifest missing、secret denied、provider unknown、wildcard egress、built-in bash enforcement gap 和 explicit local degraded path。

## Blocked by

- .scratch/pi-runner/issues/05-implement-fake-pi-json-happy-path.md
- .scratch/pi-runner/issues/07-add-pi-availability-version-and-engine-checks.md
