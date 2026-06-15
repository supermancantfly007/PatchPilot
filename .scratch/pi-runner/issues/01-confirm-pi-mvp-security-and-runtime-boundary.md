# 确认 Pi MVP 安全和运行边界

Status: done
Type: HITL

## What to build

确认 Pi Runner MVP 的不可逆或高影响产品决策，使后续 AFK issue 可以按同一安全边界实现。该切片不实现运行代码，产出应是可引用的决策记录，覆盖 MVP 是否使用 Pi JSON CLI、`auto` 是否继续解析为 Codex、如何避免继承 host/global/personal 状态、认证和 provider 范围、Pi 状态目录位置，以及 JSON CLI + 内置 `bash` 的 evidence 和生产安全语义。核心原则是：不要人为限制 Codex 或 Pi 的 coding agent 能力；PatchPilot 的控制点应在 workspace、sandbox、egress、Secret Broker、Capability Manifest、Audit Event 和 artifact evidence 外壳上，而不是通过削弱 provider 工具能力来获得安全感。

## Acceptance criteria

- [x] 明确确认 MVP 使用 Pi JSON CLI，而不是 RPC 或 SDK。
- [x] 明确确认 `auto` 默认继续解析为 Codex，不做 Pi 自动 fallback。
- [x] 明确确认不人为削弱 Codex 或 Pi 的工具、模型、编辑、shell、测试、上下文理解和代码生成能力；限制只来自 PatchPilot run-scoped policy、isolation、authorization 和 evidence boundary。
- [x] 明确确认 Pi 不继承 host/global/personal 状态；若使用 Pi native project resources、extensions、prompt templates、themes 或 context files，必须来自受控 worktree 或平台托管目录，并被记录为 run evidence。
- [x] 明确确认 Pi 认证 MVP 优先使用 API key 和 Secret Broker；平台托管 OAuth/subscription auth 作为后续决策。
- [x] 明确确认 Pi agent/session 状态目录必须位于平台拥有的 worktree 外目录。
- [x] 明确确认生产或无人值守 Pi run 在 sandbox、egress policy、Capability Manifest、Secret Broker 缺失时 fail closed。
- [x] 明确确认 Pi JSON CLI 可以保留内置 `bash` 等完整 agent 能力；如果目标 deployment tier 不能预执行授权内部 tool action，则 evidence 必须如实标记 enforcement gap，而不是删除能力。
- [x] 明确首批真实 provider 范围，以及是否先支持 Anthropic、OpenAI 或两者。
- [x] 明确首个实现是否使用普通 provider-neutral prompt，还是需要先打包 Pi-specific TDD/diagnose skills。
- [x] 决策结果记录在可被后续 issue 引用的位置。

## Decision record

- MVP runner surface: use `pi --mode json`.
- Default selection: keep `auto -> codex`; Pi requires explicit runner selection.
- Provider capability: do not artificially reduce Codex or Pi coding-agent capabilities. Keep full read/write/edit/search/shell/test/context/model capability where the provider supports it.
- Safety boundary: enforce through PatchPilot-owned worktree, sandbox, egress policy, Secret Broker, Capability Manifest, Audit Events, and artifacts.
- Pi state: agent/auth/session directories must be platform-owned and outside the task worktree.
- Host inheritance: do not inherit host/global/personal Pi resources or credentials; worktree-scoped and platform-owned resources may be used with evidence.
- Auth: use API-key auth through Secret Broker for MVP. Platform-owned OAuth/subscription auth is follow-up work.
- Production/unattended posture: fail closed when required sandbox, egress, Capability Manifest, or Secret Broker controls are unavailable.
- Pi internal shell: keep built-in `bash` capability. If a deployment tier cannot pre-authorize internal tool actions, record the enforcement gap and either fail closed or enter an approved degraded mode.
- Initial provider support: implement provider policy in a way that supports exact-host mappings for both OpenAI and Anthropic.
- Skills/prompt: start with provider-neutral prompt instructions; Pi-specific TDD/diagnose skills can be added later if evidence shows they improve outcomes.

## Blocked by

None - can start immediately
