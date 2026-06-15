import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentRunEvent, Prd, Requirement, WorkItem } from "@patchpilot/domain";
import {
  defaultContainerSandboxConfig,
  defaultEgressPolicyConfig,
  LocalPiRunner,
  type CodexRunnerConfig,
  type CodexRunnerEvent
} from "./index";

describe("LocalPiRunner", () => {
  it("runs fake Pi JSON through the same worktree, test, diff, commit, and artifact boundary", async () => {
    const fixture = await createGitFixture();
    const fakePiPath = join(fixture.root, "fake-pi.cjs");
    await writeFakePiExecutable(fakePiPath);
    const previousEnv = pickEnv(["SSH_AUTH_SOCK", "DOCKER_HOST", "DOCKER_CONFIG", "AWS_ACCESS_KEY_ID"]);
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    process.env.DOCKER_CONFIG = "/tmp/docker-config";
    process.env.AWS_ACCESS_KEY_ID = "host-cloud-key";

    const context = makeContext();
    const events: CodexRunnerEvent[] = [];
    const runner = new LocalPiRunner();

    try {
      const result = await runner.run(
        context,
        async (event) => {
          events.push(event);
        },
        makeRunnerConfig({
          command: fakePiPath,
          repositoryRoot: fixture.repo,
          workspaceRoot: fixture.workspaceRoot,
          stateRoot: fixture.stateRoot
        })
      );

      expect(result.runner).toBe("pi");
      expect(result.summary).toContain("Fake Pi summary");
      expect(result.changedFiles).toEqual(["src/pi-output.txt"]);
      expect(result.diffSummary).toMatchObject({
        hasChanges: true,
        changedFiles: ["src/pi-output.txt"]
      });
      expect(result.tests).toEqual([
        expect.objectContaining({
          status: "passed",
          command: "test -f src/pi-output.txt",
          branch: result.branchName,
          commit: result.headCommit
        })
      ]);
      expect(result.agentMessages).toContain("Fake Pi summary");
      expect(result.toolCalls).toEqual([
        expect.objectContaining({
          id: "tool-1",
          name: "bash",
          status: "completed",
          command: "printf fake-pi"
        })
      ]);
      expect(result.codexSessionId).toBeUndefined();

      const eventTypes = events.map((event) => event.type);
      expect(eventTypes).toEqual(expect.arrayContaining<AgentRunEvent["type"]>([
        "workspace.created",
        "agent.started",
        "agent.output",
        "agent.tool.started",
        "agent.tool.completed",
        "test.started",
        "test.passed",
        "git.diff.created"
      ]));
      expect(eventTypes).not.toContain("codex.started");
      expect(eventTypes).not.toContain("codex.output");

      const observation = JSON.parse(
        await readFile(join(fixture.stateRoot, "runner", "pi", context.runId, "sessions", "observation.json"), "utf8")
      ) as {
        argv: string[];
        cwd: string;
        env: Record<string, string | undefined>;
        prompt: string;
      };
      expect(observation.cwd).toBe(result.workspacePath);
      expect(observation.argv.slice(0, 3)).toEqual(["--mode", "json", "--no-session"]);
      expect(observation.prompt).toContain("Read the task file:");
      expect(observation.prompt).toContain("PATCHPILOT_TASK.md");
      expect(observation.prompt).not.toContain("full PRD context marker");
      expect(observation.prompt).not.toContain("Acceptance Criteria");
      expect(observation.env.HOME).toBe(join(fixture.stateRoot, "runner", "pi", context.runId, "home"));
      expect(observation.env.PI_CODING_AGENT_DIR).toBe(join(fixture.stateRoot, "runner", "pi", context.runId, "agent"));
      expect(observation.env.PI_CODING_AGENT_SESSION_DIR).toBe(join(fixture.stateRoot, "runner", "pi", context.runId, "sessions"));
      expect(observation.env.PI_CODING_AGENT_DIR?.startsWith(result.workspacePath ?? "")).toBe(false);
      expect(observation.env.PI_CODING_AGENT_SESSION_DIR?.startsWith(result.workspacePath ?? "")).toBe(false);
      expect(observation.env.PI_SKIP_VERSION_CHECK).toBe("1");
      expect(observation.env.PI_TELEMETRY).toBe("0");
      expect(observation.env.SSH_AUTH_SOCK).toBeUndefined();
      expect(observation.env.DOCKER_HOST).toBeUndefined();
      expect(observation.env.DOCKER_CONFIG).toBeUndefined();
      expect(observation.env.AWS_ACCESS_KEY_ID).toBeUndefined();

      const committedFiles = await runGit(["show", "--name-only", "--format=", result.headCommit ?? "HEAD"], result.workspacePath ?? fixture.repo);
      expect(committedFiles.stdout.trim().split("\n")).toEqual(["src/pi-output.txt"]);
    } finally {
      restoreEnv(previousEnv);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

function makeRunnerConfig(input: {
  command: string;
  repositoryRoot: string;
  workspaceRoot: string;
  stateRoot: string;
}): CodexRunnerConfig {
  const { egressPolicy: _egressPolicy, ...containerSandbox } = defaultContainerSandboxConfig();
  return {
    test: {
      command: "test -f src/pi-output.txt",
      timeoutMs: 30_000,
      maxRepairAttempts: 0
    },
    dev: {
      repositoryRoot: input.repositoryRoot,
      workspaceRoot: input.workspaceRoot,
      previewUrl: "http://preview.local"
    },
    security: {
      codexSandbox: "workspace-write",
      codexBypass: false,
      containerSandbox,
      egressPolicy: {
        ...defaultEgressPolicyConfig(),
        enabled: false
      },
      secretBroker: {
        enabled: false,
        allowedSecrets: [],
        allowProductionSecrets: false
      }
    },
    budget: {
      codexTimeoutMs: 30_000,
      maxCostUsd: 0,
      prdUsd: 0,
      workItemUsd: 0,
      runUsd: 0,
      softThresholdRatio: 0.8
    },
    pi: {
      command: input.command,
      provider: "",
      model: "",
      thinking: "",
      agentDir: "",
      sessionDir: "",
      stateRoot: input.stateRoot,
      timeoutMs: 30_000,
      skipVersionCheck: true,
      disableTelemetry: true,
      offline: false
    }
  };
}

function makeContext() {
  const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const requirement: Requirement = {
    id: "req_pi",
    title: "Pi requirement",
    rawInput: "Ship a Pi runner without leaking the full PRD context marker into argv.",
    template: "feature",
    status: "approved",
    simpleSummary: "Ship a Pi runner",
    clarificationQuestions: [],
    clarificationTurns: [],
    createdAt: now,
    updatedAt: now
  };
  const prd: Prd = {
    id: "prd_pi",
    requirementId: requirement.id,
    version: 1,
    status: "approved",
    title: "Pi runner PRD",
    bodyMarkdown: "## PRD\nThis is the full PRD context marker that belongs in PATCHPILOT_TASK.md.",
    acceptanceCriteria: ["Pi runner completes"]
  };
  const workItem: WorkItem = {
    id: "wi_pi",
    prdId: prd.id,
    title: "Fake Pi happy path",
    status: "ready",
    role: "backend",
    scope: "Run fake Pi JSON and collect evidence",
    nonGoals: [],
    acceptanceCriteria: ["Pi runner completes"],
    testSuggestions: ["test -f src/pi-output.txt"]
  };
  return {
    runId: "run_pi_happy",
    requirement,
    prd,
    workItem
  };
}

async function createGitFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "patchpilot-pi-runner-")));
  const repo = join(root, "repo");
  const workspaceRoot = join(root, "worktrees");
  const stateRoot = join(root, "state");
  await runGit(["init", "--initial-branch=main", repo], root);
  await runGit(["config", "user.email", "test@example.com"], repo);
  await runGit(["config", "user.name", "PatchPilot Test"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "README.md"), "# fixture\n");
  await writeFile(join(repo, "src", "index.txt"), "initial\n");
  await runGit(["add", "README.md", "src/index.txt"], repo);
  await runGit(["commit", "-m", "initial"], repo);
  return { root: resolve(root), repo, workspaceRoot, stateRoot };
}

async function writeFakePiExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const argv = process.argv.slice(2);
const prompt = argv.at(-1) || "";
mkdirSync(join(process.cwd(), "src"), { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_SESSION_DIR, { recursive: true });
writeFileSync(join(process.cwd(), "src", "pi-output.txt"), "fake pi completed\\n");
writeFileSync(join(process.env.PI_CODING_AGENT_SESSION_DIR, "observation.json"), JSON.stringify({
  argv,
  cwd: process.cwd(),
  prompt,
  env: {
    HOME: process.env.HOME,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK,
    PI_TELEMETRY: process.env.PI_TELEMETRY,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID
  }
}, null, 2));
console.log(JSON.stringify({ type: "session", sessionId: "pi-session-123", cwd: process.cwd(), version: "0.79.3" }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "message_update", role: "assistant", delta: "Fake Pi is editing files" }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "bash", args: { command: "printf fake-pi" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "tool-1", toolName: "bash", status: "success", result: { exitCode: 0 }, durationMs: 12 }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Fake Pi summary" }] } }));
console.log(JSON.stringify({ type: "agent_end" }));
`, "utf8");
  await chmod(path, 0o755);
}

function runGit(args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`git ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`));
    });
  });
}

function pickEnv(keys: string[]) {
  return new Map(keys.map((key) => [key, process.env[key]] as const));
}

function restoreEnv(previous: Map<string, string | undefined>) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
