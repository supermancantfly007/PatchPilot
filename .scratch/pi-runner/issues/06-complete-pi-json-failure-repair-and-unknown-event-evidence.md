# 补齐 Pi JSON 失败、repair、unknown event 证据

Status: ready-for-agent
Type: AFK

## What to build

扩展 Pi JSON runner 的非 happy path，使失败、timeout、测试失败 repair、tool failure、unknown event 和 raw JSONL artifact 都能进入 PatchPilot 的 evidence model。该切片应证明 Pi 协议漂移不会静默丢失关键证据，且 repair pass 复用同一 workspace 产生可审查结果。

## Acceptance criteria

- [ ] Pi process non-zero exit、invalid JSONL、timeout 和 missing lifecycle event 都映射为明确 failure summary。
- [ ] 测试失败时触发配置允许的一次 Pi repair pass，并在同一 workspace 中继续工作。
- [ ] Repair prompt 包含测试失败摘要，但不把 secret、完整原始日志或大段输出放入 argv。
- [ ] Tool start/end events 提取 tool id、tool name、status、command、exit code、duration 和简短摘要。
- [ ] Large tool output、raw Pi JSONL 和 provider transcript 进入 redacted artifact，不作为无界 AgentRun event payload。
- [ ] Unknown Pi events 被记录为 redacted progress summary 和 raw artifact reference，不导致 otherwise successful run 失败。
- [ ] Assistant final message 在 success、failure、timeout、cancel 等路径都被安全清理或归档。
- [ ] Golden fixtures 覆盖 success、tool failure、unknown event 和 parser drift。
- [ ] 单元测试覆盖 parsePiEvent 的 session header、assistant text、text delta、tool event、bash command、failure 和 unknown event。

## Blocked by

- .scratch/pi-runner/issues/05-implement-fake-pi-json-happy-path.md
