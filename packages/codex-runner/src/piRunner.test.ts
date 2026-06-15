import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentRunEvent, Prd, Requirement, WorkItem } from "@patchpilot/domain";
import { generateCapabilityManifest } from "@patchpilot/policy";
import {
  defaultContainerSandboxConfig,
  defaultEgressPolicyConfig,
  evaluatePiSecurityPreflight,
  LocalPiRunner,
  parsePiEvent,
  type CodexRunError,
  type CodexRunnerConfig,
  type CodexRunnerEvent
} from "./index";

describe("LocalPiRunner", () => {
  it("fails closed Pi security preflight unless real-provider boundaries or explicit local degraded mode are present", async () => {
    const fixture = await createGitFixture();
    const context = makeContext();
    const workItemWithSecret = {
      ...context.workItem,
      requiredCapabilities: ["secret:openai-api-key"]
    };
    const baseConfig = makeRunnerConfig({
      command: "pi",
      repositoryRoot: fixture.repo,
      workspaceRoot: fixture.workspaceRoot,
      stateRoot: fixture.stateRoot,
      provider: "openai",
      containerSandboxEnabled: true,
      egressPolicyEnabled: true,
      egressAllowedHosts: ["api.openai.com"],
      secretBrokerEnabled: true,
      secretEnv: {
        OPENAI_API_KEY: "test-openai-key"
      }
    });
    const manifest = generateCapabilityManifest({
      runId: context.runId,
      prdId: context.prd.id,
      workItem: workItemWithSecret,
      testCommand: baseConfig.test.command,
      testTimeoutMs: baseConfig.test.timeoutMs,
      security: baseConfig.security,
      budget: baseConfig.budget,
      commands: {
        allow: ["pi --mode json", "pi --version"]
      },
      createdBy: "pi-runner-test"
    });
    const manifestWithoutSecret = generateCapabilityManifest({
      runId: context.runId,
      prdId: context.prd.id,
      workItem: context.workItem,
      testCommand: baseConfig.test.command,
      testTimeoutMs: baseConfig.test.timeoutMs,
      security: baseConfig.security,
      budget: baseConfig.budget,
      commands: {
        allow: ["pi --mode json", "pi --version"]
      },
      createdBy: "pi-runner-test"
    });

    try {
      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          pi: { ...baseConfig.pi!, provider: "" }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("provider")
      });

      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          pi: { ...baseConfig.pi!, provider: "google" }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("Unsupported Pi provider")
      });

      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          security: {
            ...baseConfig.security,
            egressPolicy: {
              ...baseConfig.security.egressPolicy,
              allowedHosts: ["*.openai.com"]
            }
          }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("wildcard")
      });

      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          security: {
            ...baseConfig.security,
            containerSandbox: {
              ...baseConfig.security.containerSandbox,
              enabled: false
            }
          }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("container sandbox")
      });

      await expect(evaluatePiSecurityPreflight({
        config: baseConfig,
        capabilityManifest: manifest,
        containerRuntimeResolver: async () => undefined
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "environment_failed",
        reason: expect.stringContaining("runtime")
      });

      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          security: {
            ...baseConfig.security,
            egressPolicy: {
              ...baseConfig.security.egressPolicy,
              enabled: false
            }
          }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("egress policy")
      });

      await expect(evaluatePiSecurityPreflight({
        config: baseConfig,
        capabilityManifest: undefined
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("Capability Manifest")
      });

      await expect(evaluatePiSecurityPreflight({
        config: baseConfig,
        capabilityManifest: manifestWithoutSecret
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("openai-api-key")
      });

      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          security: {
            ...baseConfig.security,
            secretBroker: {
              ...baseConfig.security.secretBroker,
              enabled: false
            }
          }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("Secret Broker")
      });

      await expect(evaluatePiSecurityPreflight({
        config: {
          ...baseConfig,
          security: {
            ...baseConfig.security,
            secretEnv: {}
          }
        },
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("openai-api-key")
      });

      await expect(evaluatePiSecurityPreflight({
        config: baseConfig,
        capabilityManifest: manifest
      })).resolves.toMatchObject({
        status: "failed",
        failureType: "policy_denied",
        reason: expect.stringContaining("pre-execution command enforcement")
      });

      const previousEnv = pickEnv([
        "PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE",
        "PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY"
      ]);
      process.env.PATCHPILOT_PI_ALLOW_LOCAL_UNSAFE = "1";
      process.env.PATCHPILOT_PI_ALLOW_OBSERVED_INTERNAL_TOOL_POLICY = "1";
      try {
        await expect(evaluatePiSecurityPreflight({
          config: {
            ...baseConfig,
            security: {
              ...baseConfig.security,
              containerSandbox: {
                ...baseConfig.security.containerSandbox,
                enabled: false
              },
              egressPolicy: {
                ...baseConfig.security.egressPolicy,
                enabled: false
              }
            }
          },
          capabilityManifest: manifest
        })).resolves.toMatchObject({
          status: "passed",
          evidence: expect.objectContaining({
            mode: "local_unsafe",
            isolationMode: "host_user",
            egressPolicy: "disabled_explicit_local_degraded",
            internalToolCommandPolicy: "observed_after_execution",
            preExecutionCommandPolicy: "pi_process_only",
            enforcementGaps: expect.arrayContaining(["pi_internal_tool_pre_execution"])
          })
        });
      } finally {
        restoreEnv(previousEnv);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("reports structured Pi availability for installed, missing, bad version, bad engine, fake mode, and command failure", async () => {
    const fixture = await createGitFixture();
    const compatiblePiPath = join(fixture.root, "pi-compatible.cjs");
    const oldPiPath = join(fixture.root, "pi-old.cjs");
    const futurePiPath = join(fixture.root, "pi-future.cjs");
    const failingPiPath = join(fixture.root, "pi-failing.cjs");
    const fakePiPath = join(fixture.root, "fake-pi-version.cjs");
    await writeVersionPiExecutable(compatiblePiPath, { version: "0.79.3" });
    await writeVersionPiExecutable(oldPiPath, { version: "0.70.0" });
    await writeVersionPiExecutable(futurePiPath, { version: "0.80.0" });
    await writeVersionPiExecutable(failingPiPath, { exitCode: 7, stderr: "bad pi install" });
    await writeVersionPiExecutable(fakePiPath, { version: "0.0.0-test" });

    try {
      await expect(new LocalPiRunner(undefined, { command: compatiblePiPath }).availability(fixture.repo))
        .resolves.toMatchObject({
          runner: "pi",
          status: "available",
          available: true,
          runnerAvailable: true,
          gitWorkspaceAvailable: true,
          mode: "local_unsafe",
          details: expect.objectContaining({
            command: compatiblePiPath,
            version: "0.79.3",
            verifiedVersion: "0.79.3",
            nodeVersion: process.version,
            requiredNodeEngine: ">=22.19.0"
          })
        });

      await expect(new LocalPiRunner(undefined, { command: join(fixture.root, "missing-pi") }).availability(fixture.repo))
        .resolves.toMatchObject({
          runner: "pi",
          status: "unavailable",
          available: false,
          runnerAvailable: false,
          reason: "Pi CLI is not installed"
        });

      await expect(new LocalPiRunner(undefined, { command: oldPiPath }).availability(fixture.repo))
        .resolves.toMatchObject({
          status: "unavailable",
          runnerAvailable: false,
          reason: expect.stringContaining("0.70.0")
        });

      await expect(new LocalPiRunner(undefined, { command: futurePiPath }).availability(fixture.repo))
        .resolves.toMatchObject({
          status: "degraded",
          available: false,
          runnerAvailable: false,
          reason: expect.stringContaining("0.80.0")
        });

      await expect(new LocalPiRunner(undefined, { command: compatiblePiPath }, { nodeVersion: "v20.11.0" }).availability(fixture.repo))
        .resolves.toMatchObject({
          status: "unavailable",
          runnerAvailable: false,
          reason: expect.stringContaining("v20.11.0")
        });

      await expect(new LocalPiRunner(undefined, { command: fakePiPath, provider: "fake" }).availability(fixture.repo))
        .resolves.toMatchObject({
          status: "degraded",
          available: true,
          runnerAvailable: true,
          mode: "fake",
          reason: expect.stringContaining("Fake Pi")
        });

      await expect(new LocalPiRunner(undefined, { command: failingPiPath }).availability(fixture.repo))
        .resolves.toMatchObject({
          status: "unavailable",
          runnerAvailable: false,
          reason: expect.stringContaining("bad pi install")
        });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

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
      expect(result.providerMetadata).toMatchObject({
        surface: "pi-json-cli",
        provider: "fake",
        version: "0.79.3",
        sessionId: "pi-session-123",
        supportsResume: false,
        supportsCancel: false,
        supportsStateInspection: false,
        supportsArtifactCollection: true,
        stateRootRef: `runner/pi/${context.runId}`,
        agentStateRef: `runner/pi/${context.runId}/agent`,
        sessionStateRef: `runner/pi/${context.runId}/sessions`
      });
      expect(result.providerMetadata?.artifactIds).toEqual([expect.stringContaining("pi_transcript")]);
      expect(result.providerArtifactSources).toEqual([
        expect.objectContaining({
          id: expect.stringContaining("pi_transcript"),
          kind: "trace",
          contentType: "application/jsonl",
          retentionTier: "tier_3_raw_run_artifact",
          metadata: expect.objectContaining({
            artifactRole: "pi_json_transcript",
            runnerSurface: "pi-json-cli",
            sessionId: "pi-session-123"
          })
        })
      ]);
      expect(result.securityPreflightEvidence).toMatchObject({
        mode: "fake",
        isolationMode: "host_user",
        egressPolicy: "disabled_fake",
        secretBroker: "not_required",
        internalToolCommandPolicy: "not_applicable",
        preExecutionCommandPolicy: "not_applicable"
      });

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
      const workspaceFiles = await readdir(result.workspacePath ?? fixture.repo);
      const transcriptFile = workspaceFiles.find((file) => file.startsWith(".patchpilot-pi-transcript-"));
      expect(transcriptFile).toBeDefined();
      expect(await readFile(join(result.workspacePath ?? fixture.repo, transcriptFile ?? ""), "utf8"))
        .toContain('"type":"agent_start"');
    } finally {
      restoreEnv(previousEnv);
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("runs one Pi repair pass in the same worktree after configured tests fail", async () => {
    const fixture = await createGitFixture();
    const fakePiPath = join(fixture.root, "fake-pi-repair.cjs");
    await writeRepairingFakePiExecutable(fakePiPath);
    const context = { ...makeContext(), runId: "run_pi_repair" };
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
          stateRoot: fixture.stateRoot,
          testCommand: "test -f src/pi-repaired.txt",
          maxRepairAttempts: 1
        })
      );

      expect(result.runner).toBe("pi");
      expect(result.summary).toContain("Repair summary");
      expect(result.changedFiles).toEqual(["src/pi-repaired.txt"]);
      expect(result.tests[0]).toEqual(expect.objectContaining({
        status: "passed",
        command: "test -f src/pi-repaired.txt"
      }));
      expect(result.agentMessages).toEqual(expect.arrayContaining(["First attempt summary", "Repair summary"]));
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "test.failed",
        "test.passed",
        "agent.started",
        "agent.output"
      ]));

      const observation = JSON.parse(
        await readFile(join(fixture.stateRoot, "runner", "pi", context.runId, "sessions", "repair-observation.json"), "utf8")
      ) as {
        prompts: string[];
        cwd: string[];
      };
      expect(observation.cwd).toEqual([result.workspacePath, result.workspacePath]);
      expect(observation.prompts[1]).toContain("Test failed");
      expect(observation.prompts[1]).toContain("test -f src/pi-repaired.txt");
      expect(observation.prompts[1]).not.toContain("full PRD context marker");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails Pi runs with invalid JSONL and missing lifecycle evidence", async () => {
    const fixture = await createGitFixture();
    const invalidPiPath = join(fixture.root, "fake-pi-invalid.cjs");
    await writeInvalidJsonFakePiExecutable(invalidPiPath);
    const runner = new LocalPiRunner();

    try {
      await expect(runner.run(
        makeContext(),
        async () => undefined,
        makeRunnerConfig({
          command: invalidPiPath,
          repositoryRoot: fixture.repo,
          workspaceRoot: fixture.workspaceRoot,
          stateRoot: fixture.stateRoot
        })
      )).rejects.toMatchObject({
        name: "CodexRunError",
        failureType: "environment_failed"
      } satisfies Partial<CodexRunError>);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("maps Pi non-zero exit, timeout, and missing lifecycle evidence to clear failures", async () => {
    const cases = [
      {
        runId: "run_pi_nonzero",
        fileName: "fake-pi-nonzero.cjs",
        write: writeNonZeroFakePiExecutable,
        expectedFailureType: "deterministic",
        expectedMessage: "exit 2"
      },
      {
        runId: "run_pi_timeout",
        fileName: "fake-pi-timeout.cjs",
        write: writeTimeoutFakePiExecutable,
        expectedFailureType: "transient",
        expectedMessage: "timed out",
        timeoutMs: 100
      },
      {
        runId: "run_pi_missing_lifecycle",
        fileName: "fake-pi-missing-lifecycle.cjs",
        write: writeMissingLifecycleFakePiExecutable,
        expectedFailureType: "environment_failed",
        expectedMessage: "Missing lifecycle event: agent_end"
      }
    ] as const;

    for (const scenario of cases) {
      const fixture = await createGitFixture();
      const fakePiPath = join(fixture.root, scenario.fileName);
      await scenario.write(fakePiPath);
      const runner = new LocalPiRunner();
      let error: unknown;

      try {
        await runner.run(
          { ...makeContext(), runId: scenario.runId },
          async () => undefined,
          makeRunnerConfig({
            command: fakePiPath,
            repositoryRoot: fixture.repo,
            workspaceRoot: fixture.workspaceRoot,
            stateRoot: fixture.stateRoot,
            timeoutMs: "timeoutMs" in scenario ? scenario.timeoutMs : undefined
          })
        );
      } catch (caught) {
        error = caught;
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }

      expect(error).toMatchObject({
        name: "CodexRunError",
        failureType: scenario.expectedFailureType
      });
      expect((error as Error).message).toContain(scenario.expectedMessage);
    }
  });

  it("parses Pi fixtures into provider-neutral events and bounded tool evidence", async () => {
    const [successLine, toolFailureLine, unknownLine] = (await readFile(
      new URL("./fixtures/pi-parser-events.jsonl", import.meta.url),
      "utf8"
    )).trim().split("\n");
    const success = parsePiEvent(successLine ?? "");
    expect(success).toMatchObject({
      type: "agent.output",
      agentMessage: "Done from fixture"
    });

    const toolFailure = parsePiEvent(toolFailureLine ?? "");
    expect(toolFailure).toMatchObject({
      type: "agent.tool.failed",
      toolCall: expect.objectContaining({
        id: "fixture-tool",
        name: "bash",
        status: "failed",
        command: "pnpm test",
        exitCode: 1,
        durationMs: 123
      })
    });
    expect(toolFailure.toolCall?.summary.length).toBeLessThanOrEqual(500);

    const unknown = parsePiEvent(unknownLine ?? "");
    expect(unknown).toMatchObject({
      type: "agent.progress",
      message: "Pi event: new_protocol_event"
    });
  });
});

function makeRunnerConfig(input: {
  command: string;
  repositoryRoot: string;
  workspaceRoot: string;
  stateRoot: string;
  provider?: string;
  containerSandboxEnabled?: boolean;
  egressPolicyEnabled?: boolean;
  egressAllowedHosts?: string[];
  secretBrokerEnabled?: boolean;
  secretEnv?: Record<string, string>;
  testCommand?: string;
  maxRepairAttempts?: number;
  timeoutMs?: number;
}): CodexRunnerConfig {
  const { egressPolicy: _egressPolicy, ...containerSandbox } = defaultContainerSandboxConfig();
  return {
    test: {
      command: input.testCommand ?? "test -f src/pi-output.txt",
      timeoutMs: 30_000,
      maxRepairAttempts: input.maxRepairAttempts ?? 0
    },
    dev: {
      repositoryRoot: input.repositoryRoot,
      workspaceRoot: input.workspaceRoot,
      previewUrl: "http://preview.local"
    },
    security: {
      codexSandbox: "workspace-write",
      codexBypass: false,
      containerSandbox: {
        ...containerSandbox,
        enabled: input.containerSandboxEnabled ?? containerSandbox.enabled
      },
      egressPolicy: {
        ...defaultEgressPolicyConfig(),
        enabled: input.egressPolicyEnabled ?? false,
        allowedHosts: input.egressAllowedHosts ?? defaultEgressPolicyConfig().allowedHosts
      },
      secretBroker: {
        enabled: input.secretBrokerEnabled ?? false,
        allowedSecrets: [],
        allowProductionSecrets: false
      },
      ...(input.secretEnv ? { secretEnv: input.secretEnv } : {})
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
      provider: input.provider ?? "",
      model: "",
      thinking: "",
      agentDir: "",
      sessionDir: "",
      stateRoot: input.stateRoot,
      timeoutMs: input.timeoutMs ?? 30_000,
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

async function writeVersionPiExecutable(path: string, options: {
  version?: string;
  exitCode?: number;
  stderr?: string;
}) {
  await writeFile(path, `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  ${options.stderr ? `console.error(${JSON.stringify(options.stderr)});` : ""}
  ${options.version ? `console.log("pi ${options.version}");` : ""}
  process.exit(${options.exitCode ?? 0});
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "agent_end" }));
`, "utf8");
  await chmod(path, 0o755);
}

async function writeRepairingFakePiExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const prompt = process.argv.at(-1) || "";
const sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
const countPath = join(sessionDir, "repair-count.txt");
const observationPath = join(sessionDir, "repair-observation.json");
mkdirSync(join(process.cwd(), "src"), { recursive: true });
mkdirSync(sessionDir, { recursive: true });
const count = existsSync(countPath) ? Number(readFileSync(countPath, "utf8")) + 1 : 1;
writeFileSync(countPath, String(count));
const observation = existsSync(observationPath) ? JSON.parse(readFileSync(observationPath, "utf8")) : { prompts: [], cwd: [] };
observation.prompts.push(prompt);
observation.cwd.push(process.cwd());
writeFileSync(observationPath, JSON.stringify(observation, null, 2));
console.log(JSON.stringify({ type: "session", sessionId: "pi-repair-session", cwd: process.cwd(), version: "0.79.3" }));
console.log(JSON.stringify({ type: "agent_start" }));
if (count === 1) {
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "First attempt summary" }] } }));
} else {
  writeFileSync(join(process.cwd(), "src", "pi-repaired.txt"), "repair completed\\n");
  console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Repair summary" }] } }));
}
console.log(JSON.stringify({ type: "agent_end" }));
`, "utf8");
  await chmod(path, 0o755);
}

async function writeInvalidJsonFakePiExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", sessionId: "pi-invalid-session", version: "0.79.3" }));
console.log("not-json");
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "agent_end" }));
`, "utf8");
  await chmod(path, 0o755);
}

async function writeNonZeroFakePiExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
process.exit(2);
`, "utf8");
  await chmod(path, 0o755);
}

async function writeTimeoutFakePiExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
setTimeout(() => {}, 10_000);
`, "utf8");
  await chmod(path, 0o755);
}

async function writeMissingLifecycleFakePiExecutable(path: string) {
  await writeFile(path, `#!/usr/bin/env node
console.log(JSON.stringify({ type: "session", sessionId: "pi-missing-lifecycle", version: "0.79.3" }));
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Lifecycle summary" }] } }));
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
