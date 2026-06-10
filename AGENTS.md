# PatchPilot Agent Guidance

PatchPilot is an agent delivery control platform built around Codex. The platform coordinates requirement clarification, PRD creation, task breakdown, interface contracts, implementation agents, test agents, bug reproduction, pull requests, audit trails, and final acceptance.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

This repo uses the default mattpocock/skills triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo: read `CONTEXT.md` and relevant ADRs under `docs/adr/`. See `docs/agents/domain.md`.

### Task completion

When completing a `.scratch/agent-platform/TODO.md` task, finish code review, unit tests, and relevant E2E checks, then mark the task done, commit the changes, and push the commit to the remote before moving on to the next task.
