import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCapabilityManifest } from "@patchpilot/policy";
import {
  buildPiCommandPolicyAllow,
  LocalPiRpcDurableRunner,
  type DurableRunnerHandle
} from "./index";

describe("LocalPiRpcDurableRunner", () => {
  it("drives a fake pi --mode rpc process through start, resume, stream, state, artifacts, and cancel", async () => {
    const root = await mkdtemp(join(tmpdir(), "patchpilot-pi-rpc-runner-"));
    const workspacePath = join(root, "workspace");
    const fakePiPath = join(root, "fake-pi-rpc.cjs");
    const transcriptPath = join(root, "artifacts", "pi-rpc-transcript.jsonl");
    await mkdir(join(workspacePath, "src"), { recursive: true });
    await writeFile(join(workspacePath, "PATCHPILOT_TASK.md"), "Change src/status.txt to READY.\n");
    await writeFile(join(workspacePath, "src", "status.txt"), "TODO\n");
    await writeFakePiRpcExecutable(fakePiPath);

    const manifest = generateCapabilityManifest({
      runId: "run_rpc",
      prdId: "prd_rpc",
      workItem: {
        id: "wi_rpc",
        prdId: "prd_rpc",
        requiredCapabilities: []
      },
      testCommand: "node test.mjs",
      commands: {
        allow: buildPiCommandPolicyAllow(fakePiPath)
      },
      createdBy: "pi-rpc-test"
    });
    const runner = new LocalPiRpcDurableRunner({
      command: fakePiPath,
      timeoutMs: 10_000,
      transcriptPath,
      capabilityManifest: manifest,
      env: {
        PATH: process.env.PATH ?? "",
        PI_CODING_AGENT_SESSION_DIR: join(root, "sessions")
      }
    });

    try {
      const handle = await runner.start({
        runner: "pi",
        surface: "pi-rpc",
        runId: "run_rpc",
        workspaceRunId: "ws_run_rpc",
        workItemId: "wi_rpc",
        workspacePath,
        taskFilePath: join(workspacePath, "PATCHPILOT_TASK.md"),
        idempotencyKey: "start-rpc",
        prompt: "Inspect the task but do not edit yet.",
        capabilities: {
          resume: true,
          cancel: true,
          stateInspection: true,
          artifactCollection: true
        },
        providerOptions: {
          provider: "fake",
          model: "fake-rpc"
        }
      });
      await expect(runner.start({
        runner: "pi",
        surface: "pi-rpc",
        runId: "run_rpc",
        workspaceRunId: "ws_run_rpc",
        workItemId: "wi_rpc",
        workspacePath,
        taskFilePath: join(workspacePath, "PATCHPILOT_TASK.md"),
        idempotencyKey: "start-rpc",
        prompt: "duplicate",
        capabilities: {
          resume: true,
          cancel: true,
          stateInspection: true,
          artifactCollection: true
        }
      })).resolves.toEqual(handle);
      expect(handle).toMatchObject({
        runner: "pi",
        surface: "pi-rpc",
        runId: "run_rpc",
        workspaceRunId: "ws_run_rpc",
        workItemId: "wi_rpc",
        idempotencyKey: "start-rpc",
        status: "succeeded",
        supportsResume: true,
        supportsCancel: true,
        supportsStateInspection: true,
        sessionId: "fake-rpc-session"
      });
      await expect(readFile(join(workspacePath, "src", "status.txt"), "utf8")).resolves.toBe("TODO\n");

      const resumed = await runner.resume({
        handle,
        idempotencyKey: "resume-rpc",
        prompt: "Test failed. Change src/status.txt to READY."
      });
      expect(resumed).toMatchObject({
        providerRunId: handle.providerRunId,
        sessionId: "fake-rpc-session",
        resumeCount: 1,
        status: "succeeded",
        metadata: expect.objectContaining({
          lastResumePrompt: "Test failed. Change src/status.txt to READY."
        })
      } satisfies Partial<DurableRunnerHandle>);
      await expect(readFile(join(workspacePath, "src", "status.txt"), "utf8")).resolves.toBe("READY\n");

      await expect(collectAsync(runner.streamEvents({ handle: resumed }))).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "agent.started" }),
        expect.objectContaining({ type: "agent.output", message: expect.stringContaining("Fake Pi RPC summary") }),
        expect.objectContaining({ type: "agent.tool.started" }),
        expect.objectContaining({ type: "agent.tool.completed" })
      ]));
      await expect(runner.inspectState({ handle: resumed })).resolves.toMatchObject({
        status: "succeeded",
        lastAssistantMessage: "Fake Pi RPC summary",
        artifactIds: [expect.stringContaining("pi-rpc-transcript")]
      });
      await expect(runner.collectArtifacts({ handle: resumed })).resolves.toMatchObject({
        artifactIds: [expect.stringContaining("pi-rpc-transcript")],
        transcriptArtifactId: expect.stringContaining("pi-rpc-transcript")
      });
      const transcript = await readFile(transcriptPath, "utf8");
      expect(transcript).toContain('"method":"prompt"');
      expect(transcript).toContain('"type":"tool_execution_end"');
      expect(transcript.length).toBeGreaterThan(100);

      await expect(runner.cancel({ handle: resumed, reason: "test cleanup" })).resolves.toMatchObject({
        acknowledged: true,
        processTerminated: true,
        workspaceRetained: true,
        handle: expect.objectContaining({
          status: "cancelled"
        })
      });
    } finally {
      await runner.dispose().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeFakePiRpcExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const readline = require("node:readline");

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("0.79.3");
  process.exit(0);
}
if (!args.includes("--mode") || !args.includes("rpc")) {
  console.error("expected --mode rpc");
  process.exit(2);
}

const sessionId = "fake-rpc-session";
let status = "running";
let lastAssistantText = "";
let promptCount = 0;
console.log(JSON.stringify({ type: "session", sessionId, mode: "rpc" }));

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "prompt") {
    promptCount += 1;
    const prompt = request.params?.prompt || "";
    console.log(JSON.stringify({ type: "agent_start", sessionId, promptCount }));
    console.log(JSON.stringify({ type: "message_update", role: "assistant", delta: "Fake Pi RPC handling prompt" }));
    if (/READY|Test failed/i.test(prompt)) {
      mkdirSync(join(process.cwd(), "src"), { recursive: true });
      console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "rpc-tool-1", toolName: "bash", args: { command: "printf READY > src/status.txt" } }));
      writeFileSync(join(process.cwd(), "src", "status.txt"), "READY\\n");
      console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "rpc-tool-1", toolName: "bash", status: "success", result: { exitCode: 0 }, durationMs: 5 }));
    }
    lastAssistantText = "Fake Pi RPC summary";
    status = "succeeded";
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: lastAssistantText }] } }));
    console.log(JSON.stringify({ type: "agent_end", sessionId }));
    console.log(JSON.stringify({ id: request.id, ok: true, result: { status, sessionId, lastAssistantText } }));
    return;
  }
  if (request.method === "get_state") {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { status, sessionId, promptCount, lastAssistantText } }));
    return;
  }
  if (request.method === "get_last_assistant_text") {
    console.log(JSON.stringify({ id: request.id, ok: true, result: { text: lastAssistantText } }));
    return;
  }
  if (request.method === "abort") {
    status = "cancelled";
    console.log(JSON.stringify({ id: request.id, ok: true, result: { status, sessionId, acknowledged: true } }));
    process.exit(0);
  }
  console.log(JSON.stringify({ id: request.id, ok: false, error: "unknown method" }));
});
`, "utf8");
  await chmod(path, 0o755);
}

async function collectAsync<T>(iterable: AsyncIterable<T>) {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
