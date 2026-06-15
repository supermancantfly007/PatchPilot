# ADR-0012: Pi Durable Adapter Path

Status: accepted

Date: 2026-06-15

## Context

The Pi JSON CLI MVP now has:

- fake Pi JSON happy path through the same worktree, test, diff, commit, and artifact boundary;
- JSONL failure, repair, unknown-event, and bounded tool evidence handling;
- structured availability checks for Pi version `0.79.3` and Node `>=22.19.0`;
- fail-closed security preflight for provider, exact egress host, Capability Manifest, Secret Broker, sandbox, and Pi internal command-policy evidence;
- fake Pi API E2E and opt-in real Pi smoke documentation.

The MVP intentionally keeps Pi's coding-agent capability intact. PatchPilot provides the outer worktree, sandbox, egress, Secret Broker, Capability Manifest, Audit Event, and artifact boundaries. Pi JSON CLI tool events are evidence after execution; they are not a production-grade pre-execution command policy for Pi internal shell-capable tools.

ADR-0003 already says Codex should move from the current one-shot CLI helper toward a durable runner contract before SDK becomes the production default. Pi should follow the same provider-neutral direction rather than inventing a separate lifecycle model.

## Decision

Continue `pi --mode json` as the local, CI, and preview adapter. Do not promote it to production durable semantics.

Define a provider-neutral durable runner contract before adding a Pi durable adapter. The contract must cover `start`, `resume`, `cancel`, `streamEvents`, `collectArtifacts`, and `summarizeFailure`, plus idempotent provider-handle reuse.

After that contract exists, implement `pi --mode rpc` as the next Pi durable adapter path. RPC is the right next step because it can preserve a provider session across prompts, expose explicit abort/state operations, and keep Pi out of the API process while matching the current subprocess isolation model.

Defer direct Pi SDK embedding until the durable runner contract, repository state, artifact boundaries, and RPC learnings are in place. SDK/custom tools are likely necessary for production-enforceable pre-execution command policy for Pi internal shell/file/network-affecting tool actions, but they should enter behind the same durable runner contract rather than becoming a separate product path.

Do not use reduced Pi toolsets as the default security strategy. If a deployment tier deliberately chooses reduced-tool mode, it must be an explicit, audited capability configuration. The primary production path remains full Pi capability plus PatchPilot outer enforcement, and SDK/custom tools or a platform-owned Pi extension for pre-execution policy decisions where that tier requires it.

## Product Requirements

Durable runner work must support:

- `cancel`: terminate or abort the provider run, record whether the provider acknowledged cancellation, and preserve workspace state for audit.
- `resume`: continue after approval, failed tests, rejection, or worker restart when the provider exposes reusable session state; otherwise record that a new provider session was linked to the same Agent Run.
- `stream`: normalize lifecycle, progress, agent output, reasoning summaries, tool calls, state changes, policy denials, and usage into provider-neutral AgentRun events.
- `state inspection`: read provider status, session id, last assistant message, pending tool/action state, and current failure if exposed.
- `artifact collection`: store raw provider streams, transcripts, final message, session export, debug logs, and tool output as redacted artifacts with checksums instead of product-state payloads.
- `session export`: persist enough provider identity and metadata to resume or diagnose without copying plaintext auth state or provider-private files into the worktree.

## State And Artifact Boundaries

Pi session state, auth state, and provider metadata must stay outside the task worktree.

PatchPilot product state may store redacted provider-neutral identifiers:

- runner provider surface: `json-cli`, `rpc`, or `sdk`;
- Pi session id/name/file reference when exposed;
- provider name, model, thinking mode, and version;
- run-scoped state root, artifact ids, checksums, and retention tier;
- whether resume/cancel/state inspection is supported for this handle.

PatchPilot product state must not store plaintext API keys, OAuth tokens, provider auth files, full raw transcripts, or unbounded tool output. Those belong either nowhere, or in redacted artifacts with retention metadata and access controls under ADR-0008 and ADR-0009.

## Exit Criteria For Pi RPC Preview

Pi RPC can become the preview durable adapter when:

1. The provider-neutral runner contract exists with contract tests shared by Codex CLI, Pi JSON CLI, and Pi RPC fixtures.
2. RPC start/resume/cancel/stream/state operations are covered by fake Pi RPC fixtures.
3. Provider handle metadata is persisted in AgentRun or linked artifacts without leaking session/auth state.
4. Cancellation and resume behavior are observable in Audit Events and AgentRun failure/status evidence.
5. JSON CLI remains available as the local/fallback adapter and keeps its E2E smoke.

## Exit Criteria For Pi SDK / Custom Tools

Pi SDK or platform-owned Pi extensions become the production-enforcement path only when:

1. Shell, file write/edit, and network-affecting tool actions can call PatchPilot policy before execution.
2. Capability Manifest decisions cover command/path/network/secret access for those tool actions.
3. Contract tests prove denied actions do not execute.
4. SDK/custom-tool events normalize to the same AgentRun, TestRun, Artifact, and Audit Event model.
5. Full Pi coding-agent capability remains available unless a deployment tier explicitly selects a reduced-tool capability profile.

## Consequences

- The immediate next work is not "SDK now"; it is durable runner contract first, then Pi RPC preview.
- JSON CLI remains valuable and supported for local, CI, preview, fake E2E, and compatibility.
- Production-enforceable Pi command policy requires SDK/custom tools or an equivalent platform-owned pre-execution extension.
- PatchPilot avoids a false security posture: observed-after-execution Pi tool events are useful evidence, but not strict command authorization.
- Future issues should use provider-neutral runner vocabulary where possible, even while the package remains `@patchpilot/codex-runner`.
