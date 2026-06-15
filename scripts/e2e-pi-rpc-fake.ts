import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateCapabilityManifest } from "../packages/policy/src/index";
import {
  buildPiCommandPolicyAllow,
  LocalPiRpcDurableRunner
} from "../packages/codex-runner/src/index";
import {
  assert,
  assertEqual,
  cleanupTemp,
  createTinyProject,
  git,
  runProcess,
  tempPrefix
} from "./pi-e2e-lib.mjs";

const root = await mkdtemp(tempPrefix("patchpilot-pi-rpc-fake-e2e-"));
const projectRoot = join(root, "tiny-project");
const workspacePath = join(root, "workspace-run");
const fakePiPath = join(root, "fake-pi-rpc.cjs");
const transcriptPath = join(root, "artifacts", "pi-rpc-transcript.jsonl");
let failed = false;

try {
  await createTinyProject(projectRoot, { provider: "fake" });
  await writeFakePiRpcExecutable(fakePiPath);
  await git(["worktree", "add", "-b", "patchpilot/pi-rpc-fake-e2e", workspacePath, "HEAD"], projectRoot);
  await writeFile(join(workspacePath, "PATCHPILOT_TASK.md"), "Change src/status.txt to READY.\n");

  const manifest = generateCapabilityManifest({
    runId: "run_pi_rpc_fake_e2e",
    prdId: "prd_pi_rpc_fake_e2e",
    workItem: {
      id: "wi_pi_rpc_fake_e2e",
      prdId: "prd_pi_rpc_fake_e2e",
      requiredCapabilities: []
    },
    testCommand: "node test.mjs",
    commands: {
      allow: buildPiCommandPolicyAllow(fakePiPath)
    },
    createdBy: "pi-rpc-fake-e2e"
  });
  const runner = new LocalPiRpcDurableRunner({
    command: fakePiPath,
    timeoutMs: 30_000,
    transcriptPath,
    capabilityManifest: manifest,
    env: {
      PATH: process.env.PATH ?? "",
      PI_CODING_AGENT_SESSION_DIR: join(root, "sessions")
    }
  });

  const handle = await runner.start({
    runner: "pi",
    surface: "pi-rpc",
    runId: "run_pi_rpc_fake_e2e",
    workspaceRunId: "ws_pi_rpc_fake_e2e",
    workItemId: "wi_pi_rpc_fake_e2e",
    workspacePath,
    taskFilePath: join(workspacePath, "PATCHPILOT_TASK.md"),
    idempotencyKey: "pi-rpc-fake-start",
    prompt: "Inspect the task and keep the workspace unchanged.",
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
  assertEqual(handle.status, "succeeded", "initial Pi RPC prompt should complete");
  assertEqual(
    (await readFile(join(workspacePath, "src", "status.txt"), "utf8")).trim(),
    "TODO",
    "initial Pi RPC prompt should not edit the prepared worktree"
  );

  const failingTest = await runProcess("node", ["test.mjs"], { cwd: workspacePath });
  assert(failingTest.code !== 0, "target test should fail before Pi RPC resume edits the workspace");

  const resumed = await runner.resume({
    handle,
    idempotencyKey: "pi-rpc-fake-resume",
    prompt: "Test failed. Change src/status.txt to READY."
  });
  assertEqual(resumed.status, "succeeded", "Pi RPC resume prompt should complete");
  assertEqual(resumed.providerRunId, handle.providerRunId, "Pi RPC resume should reuse the provider run");

  const passedTest = await runProcess("node", ["test.mjs"], { cwd: workspacePath });
  assertEqual(passedTest.code, 0, `target test should pass after Pi RPC resume\n${passedTest.stdout}\n${passedTest.stderr}`);

  const events = await collectAsync(runner.streamEvents({ handle: resumed }));
  for (const expected of ["agent.started", "agent.output", "agent.tool.started", "agent.tool.completed"]) {
    assert(events.some((event) => event.type === expected), `Pi RPC event stream should include ${expected}`);
  }

  const state = await runner.inspectState({ handle: resumed });
  assertEqual(state.status, "succeeded", "Pi RPC state inspection should report succeeded");
  assertEqual(state.lastAssistantMessage, "Fake Pi RPC E2E summary", "Pi RPC state should expose final assistant summary");

  const diff = await git(["diff", "--name-only"], workspacePath);
  assertEqual(diff.stdout.trim(), "src/status.txt", "Pi RPC preview diff should include only the target file");
  await git(["add", "src/status.txt"], workspacePath);
  await git(["commit", "-m", "Pi RPC fake E2E change"], workspacePath);
  const branchStatus = await git(["show", "patchpilot/pi-rpc-fake-e2e:src/status.txt"], projectRoot);
  assertEqual(branchStatus.stdout.trim(), "READY", "Pi RPC preview commit should contain the workspace change");
  assertEqual(
    (await readFile(join(projectRoot, "src", "status.txt"), "utf8")).trim(),
    "TODO",
    "target repo main worktree should remain unchanged until merge"
  );

  const artifacts = await runner.collectArtifacts({ handle: resumed });
  assert(artifacts.transcriptArtifactId?.includes("pi-rpc-transcript"), "Pi RPC artifact collection should expose transcript artifact id");
  const transcript = await readFile(transcriptPath, "utf8");
  assert(transcript.includes('"method":"prompt"'), "Pi RPC transcript should include prompt RPC requests");
  assert(transcript.includes('"type":"tool_execution_end"'), "Pi RPC transcript should include raw provider tool events");

  const cancelled = await runner.cancel({ handle: resumed, reason: "e2e cleanup" });
  assert(cancelled.acknowledged, "Pi RPC cancel should be provider-acknowledged");
  assert(cancelled.processTerminated, "Pi RPC cancel should terminate the fake process");
  assert(cancelled.workspaceRetained, "Pi RPC cancel should retain workspace evidence");
  await runner.dispose();

  console.log("PatchPilot fake Pi RPC durable E2E passed");
} catch (error) {
  failed = true;
  console.error(`Fixture root kept for inspection: ${root}`);
  throw error;
} finally {
  await cleanupTemp(root, failed);
}

async function writeFakePiRpcExecutable(path: string) {
  await mkdir(join(path, ".."), { recursive: true });
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

const sessionId = "fake-rpc-e2e-session";
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
    console.log(JSON.stringify({ type: "message_update", role: "assistant", delta: "Fake Pi RPC E2E handling prompt" }));
    if (/READY|Test failed/i.test(prompt)) {
      mkdirSync(join(process.cwd(), "src"), { recursive: true });
      console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "rpc-e2e-tool", toolName: "bash", args: { command: "printf READY > src/status.txt" } }));
      writeFileSync(join(process.cwd(), "src", "status.txt"), "READY\\n");
      console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "rpc-e2e-tool", toolName: "bash", status: "success", result: { exitCode: 0 }, durationMs: 6 }));
    }
    lastAssistantText = "Fake Pi RPC E2E summary";
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
