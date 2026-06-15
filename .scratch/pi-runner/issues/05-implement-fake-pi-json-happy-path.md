# 实现 fake Pi JSON happy path

Status: ready-for-agent
Type: AFK

## What to build

实现 LocalPiRunner 的最小 JSON CLI happy path，并用 fake Pi executable 验证完整 Work Item 执行闭环。该切片应证明 Pi runner 可以复用 PatchPilot 的 worktree、任务文件、runner event normalization、测试、diff、commit、artifact 和 result shape，而不调用真实 LLM provider。实现不得为了简化安全模型而人为削弱 Pi 的 coding agent 能力；隔离和审计由 PatchPilot 外壳负责。

## Acceptance criteria

- [ ] `PATCHPILOT_RUNNER=pi` 或 request runner override 可以启动一个使用 fake Pi 的 Work Item run。
- [ ] Pi 子进程在 prepared worktree 中运行，并使用 `spawn` 参数数组而不是 shell 拼接。
- [ ] Pi prompt 只携带短指令和任务文件引用；详细上下文保存在 PatchPilot 控制的任务文件或 artifact 中。
- [ ] Pi command 不继承 host/global/personal project resources、extensions、prompt templates、themes 或 native context files；受控 worktree 或平台托管资源可用时不得因为 provider 是 Pi 而被人为禁用。
- [ ] Pi 保留完整 coding agent 能力，包括读取、编辑、写入、搜索、shell/test 执行和必要上下文使用；PatchPilot 只负责把这些能力约束在 run-scoped workspace、environment 和 evidence boundary 内。
- [ ] Pi 子进程环境使用 allowlist，不继承 host HOME、SSH agent、Docker socket、cloud credential env 或无关 host env。
- [ ] Pi agent/session 目录解析为平台拥有的 worktree 外绝对路径；指向 worktree 内时被拒绝。
- [ ] Fake Pi JSONL 的 session、assistant message、tool events 被解析为 provider-neutral AgentRun evidence。
- [ ] 最终 assistant summary 被收集为 artifact source，且 `.patchpilot-pi-*.md` 不进入 changed files、diff summary 或 commit。
- [ ] 配置的测试命令在 Pi 完成后运行，结果与 Codex 路径一致进入 AgentRun result。
- [ ] Diff 和 commit evidence 对 Pi run 可用，现有 Codex happy path 不变。

## Blocked by

- .scratch/pi-runner/issues/04-route-codex-and-pi-through-runner-registry.md
