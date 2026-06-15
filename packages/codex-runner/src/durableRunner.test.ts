import { describe, expect, it } from "vitest";
import type {
  DurableRunnerArtifacts,
  DurableRunnerCancelResult,
  DurableRunnerFailureSummary,
  DurableRunnerHandle,
  DurableRunnerStartInput,
  DurableRunnerState,
  DurableAgentRunner
} from "./index";

describe("DurableAgentRunner contract", () => {
  it("supports provider-neutral start, idempotent handle reuse, streaming, artifacts, and failure summary", async () => {
    const runner = new FakeDurableRunner();
    const startInput = makeStartInput({ idempotencyKey: "start-1", supportsResume: true, supportsCancel: true });

    const firstHandle = await runner.start(startInput);
    const duplicateHandle = await runner.start(startInput);

    expect(duplicateHandle).toEqual(firstHandle);
    expect(firstHandle).toMatchObject({
      runner: "pi",
      surface: "pi-rpc",
      runId: "run_durable",
      workspaceRunId: "ws_run_durable",
      workItemId: "wi_durable",
      idempotencyKey: "start-1",
      providerRunId: "provider-start-1",
      sessionId: "session-start-1",
      status: "running",
      supportsResume: true,
      supportsCancel: true,
      supportsStateInspection: true,
      artifactIds: []
    });

    await runner.finish(firstHandle, "succeeded");
    await expect(collectAsync(runner.streamEvents({ handle: firstHandle }))).resolves.toEqual([
      expect.objectContaining({ type: "agent.started", message: "pi-rpc provider run started" }),
      expect.objectContaining({ type: "agent.output", message: "pi-rpc provider run succeeded" })
    ]);
    await expect(runner.collectArtifacts({ handle: firstHandle })).resolves.toMatchObject({
      handle: expect.objectContaining({ providerRunId: "provider-start-1" }),
      artifactIds: ["artifact-provider-start-1-transcript"],
      transcriptArtifactId: "artifact-provider-start-1-transcript"
    });
    await expect(runner.summarizeFailure({ handle: firstHandle })).resolves.toMatchObject({
      failureType: undefined,
      message: "pi-rpc provider run succeeded",
      artifactIds: ["artifact-provider-start-1-transcript"]
    });
  });

  it("records supported resume and unsupported resume fallback as provider handle metadata", async () => {
    const runner = new FakeDurableRunner();
    const resumable = await runner.start(makeStartInput({ idempotencyKey: "resumable", supportsResume: true }));
    const resumed = await runner.resume({
      handle: resumable,
      idempotencyKey: "resume-1",
      prompt: "continue after approval"
    });

    expect(resumed).toMatchObject({
      providerRunId: "provider-resumable",
      sessionId: "session-resumable",
      status: "running",
      resumeCount: 1,
      metadata: expect.objectContaining({
        lastResumePrompt: "continue after approval"
      })
    });

    const nonResumable = await runner.start(makeStartInput({ idempotencyKey: "non-resumable", supportsResume: false }));
    const fallback = await runner.resume({
      handle: nonResumable,
      idempotencyKey: "resume-fallback",
      prompt: "continue with a linked provider session"
    });

    expect(fallback).toMatchObject({
      providerRunId: "provider-resume-fallback",
      sessionId: "session-resume-fallback",
      parentProviderRunId: "provider-non-resumable",
      resumeCount: 0,
      metadata: expect.objectContaining({
        resumeMode: "new_linked_session"
      })
    });
  });

  it("distinguishes acknowledged cancellation from best-effort local termination", async () => {
    const runner = new FakeDurableRunner();
    const cancellable = await runner.start(makeStartInput({ idempotencyKey: "cancel-ok", supportsCancel: true }));
    await expect(runner.cancel({ handle: cancellable, reason: "user requested" })).resolves.toMatchObject({
      acknowledged: true,
      processTerminated: true,
      workspaceRetained: true,
      handle: expect.objectContaining({ status: "cancelled" })
    } satisfies Partial<DurableRunnerCancelResult>);

    const bestEffort = await runner.start(makeStartInput({ idempotencyKey: "cancel-best-effort", supportsCancel: false }));
    await expect(runner.cancel({ handle: bestEffort, reason: "worker shutdown" })).resolves.toMatchObject({
      acknowledged: false,
      processTerminated: true,
      workspaceRetained: true,
      handle: expect.objectContaining({ status: "cancelled" })
    } satisfies Partial<DurableRunnerCancelResult>);
  });

  it("exposes state inspection without raw provider transcripts in product state", async () => {
    const runner = new FakeDurableRunner();
    const handle = await runner.start(makeStartInput({ idempotencyKey: "state" }));
    await runner.finish(handle, "failed");

    await expect(runner.inspectState({ handle })).resolves.toMatchObject({
      status: "failed",
      lastAssistantMessage: "pi-rpc provider run failed",
      artifactIds: ["artifact-provider-state-transcript"]
    } satisfies Partial<DurableRunnerState>);
    await expect(runner.summarizeFailure({ handle })).resolves.toMatchObject({
      failureType: "deterministic",
      message: "pi-rpc provider run failed",
      artifactIds: ["artifact-provider-state-transcript"]
    } satisfies Partial<DurableRunnerFailureSummary>);
  });
});

class FakeDurableRunner implements DurableAgentRunner {
  private readonly startsByIdempotencyKey = new Map<string, DurableRunnerHandle>();
  private readonly handles = new Map<string, DurableRunnerHandle>();
  private readonly terminalMessages = new Map<string, string>();

  async start(input: DurableRunnerStartInput): Promise<DurableRunnerHandle> {
    const existing = this.startsByIdempotencyKey.get(input.idempotencyKey);
    if (existing) return existing;
    const handle = makeHandle({
      idempotencyKey: input.idempotencyKey,
      supportsResume: input.capabilities.resume,
      supportsCancel: input.capabilities.cancel
    });
    this.startsByIdempotencyKey.set(input.idempotencyKey, handle);
    this.handles.set(handle.providerRunId, handle);
    this.terminalMessages.set(handle.providerRunId, "pi-rpc provider run started");
    return handle;
  }

  async resume(input: { handle: DurableRunnerHandle; idempotencyKey: string; prompt: string }) {
    if (!input.handle.supportsResume) {
      const fallback = makeHandle({
        idempotencyKey: input.idempotencyKey,
        supportsResume: input.handle.supportsResume,
        supportsCancel: input.handle.supportsCancel,
        parentProviderRunId: input.handle.providerRunId,
        metadata: {
          resumeMode: "new_linked_session",
          lastResumePrompt: input.prompt
        }
      });
      this.handles.set(fallback.providerRunId, fallback);
      return fallback;
    }

    const resumed = {
      ...input.handle,
      status: "running" as const,
      resumeCount: (input.handle.resumeCount ?? 0) + 1,
      metadata: {
        ...(input.handle.metadata ?? {}),
        lastResumePrompt: input.prompt
      }
    };
    this.handles.set(resumed.providerRunId, resumed);
    return resumed;
  }

  async cancel(input: { handle: DurableRunnerHandle; reason?: string }): Promise<DurableRunnerCancelResult> {
    const cancelled = {
      ...input.handle,
      status: "cancelled" as const,
      endedAt: "2026-01-01T00:00:01.000Z",
      metadata: {
        ...(input.handle.metadata ?? {}),
        cancelReason: input.reason
      }
    };
    this.handles.set(cancelled.providerRunId, cancelled);
    return {
      handle: cancelled,
      acknowledged: input.handle.supportsCancel,
      processTerminated: true,
      workspaceRetained: true,
      reason: input.reason
    };
  }

  async *streamEvents(input: { handle: DurableRunnerHandle }) {
    yield {
      type: "agent.started" as const,
      message: `${input.handle.surface} provider run started`
    };
    yield {
      type: "agent.output" as const,
      message: this.terminalMessages.get(input.handle.providerRunId) ?? `${input.handle.surface} provider run running`
    };
  }

  async collectArtifacts(input: { handle: DurableRunnerHandle }): Promise<DurableRunnerArtifacts> {
    const artifactIds = [`artifact-${input.handle.providerRunId}-transcript`];
    return {
      handle: {
        ...input.handle,
        artifactIds
      },
      artifactIds,
      transcriptArtifactId: artifactIds[0]
    };
  }

  async inspectState(input: { handle: DurableRunnerHandle }): Promise<DurableRunnerState> {
    return {
      handle: this.handles.get(input.handle.providerRunId) ?? input.handle,
      status: this.handles.get(input.handle.providerRunId)?.status ?? input.handle.status,
      lastAssistantMessage: this.terminalMessages.get(input.handle.providerRunId),
      artifactIds: [`artifact-${input.handle.providerRunId}-transcript`]
    };
  }

  async summarizeFailure(input: { handle: DurableRunnerHandle }): Promise<DurableRunnerFailureSummary> {
    const state = await this.inspectState(input);
    return {
      failureType: state.status === "failed" ? "deterministic" : undefined,
      message: state.lastAssistantMessage ?? "No provider message recorded.",
      artifactIds: state.artifactIds
    };
  }

  async finish(handle: DurableRunnerHandle, status: "succeeded" | "failed") {
    const finished = {
      ...handle,
      status,
      endedAt: "2026-01-01T00:00:02.000Z"
    };
    this.handles.set(handle.providerRunId, finished);
    this.terminalMessages.set(handle.providerRunId, `${handle.surface} provider run ${status}`);
  }
}

function makeStartInput(input: {
  idempotencyKey: string;
  supportsResume?: boolean;
  supportsCancel?: boolean;
}): DurableRunnerStartInput {
  return {
    runner: "pi",
    surface: "pi-rpc",
    runId: "run_durable",
    workspaceRunId: "ws_run_durable",
    workItemId: "wi_durable",
    workspacePath: "/tmp/patchpilot/worktrees/run_durable",
    taskFilePath: "/tmp/patchpilot/worktrees/run_durable/PATCHPILOT_TASK.md",
    idempotencyKey: input.idempotencyKey,
    prompt: "Complete the durable runner task.",
    capabilities: {
      resume: input.supportsResume ?? false,
      cancel: input.supportsCancel ?? false,
      stateInspection: true,
      artifactCollection: true
    },
    providerOptions: {
      provider: "fake",
      model: "fake-model"
    }
  };
}

function makeHandle(input: {
  idempotencyKey: string;
  supportsResume?: boolean;
  supportsCancel?: boolean;
  parentProviderRunId?: string;
  metadata?: Record<string, unknown>;
}): DurableRunnerHandle {
  return {
    runner: "pi",
    surface: "pi-rpc",
    runId: "run_durable",
    workspaceRunId: "ws_run_durable",
    workItemId: "wi_durable",
    idempotencyKey: input.idempotencyKey,
    providerRunId: `provider-${input.idempotencyKey}`,
    sessionId: `session-${input.idempotencyKey}`,
    ...(input.parentProviderRunId ? { parentProviderRunId: input.parentProviderRunId } : {}),
    status: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
    supportsResume: Boolean(input.supportsResume),
    supportsCancel: Boolean(input.supportsCancel),
    supportsStateInspection: true,
    artifactIds: [],
    resumeCount: 0,
    metadata: input.metadata ?? {}
  };
}

async function collectAsync<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
