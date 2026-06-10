import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateCapabilityManifest } from "@patchpilot/policy";
import {
  CommandExecutionPolicyDeniedError,
  asCommandAuditEvidenceList,
  executeCommand,
  shellJoin,
  spawnCommand
} from "./index";

describe("command execution wrapper", () => {
  it("denies commands before they can execute and emits audit evidence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patchpilot-command-deny-"));
    const marker = join(dir, "marker.txt");
    const manifest = generateCapabilityManifest({
      commands: {
        allow: ["node -e*"],
        deny: ["node"]
      }
    });
    const auditEvents: unknown[] = [];

    await expect(executeCommand({
      kind: "test",
      command: nodeCommand(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'bypassed')`),
      cwd: dir,
      timeoutMs: 5000,
      capabilityManifest: manifest,
      auditSink: (event) => {
        auditEvents.push(event);
      }
    })).rejects.toThrow(CommandExecutionPolicyDeniedError);

    await expect(readFile(marker, "utf8")).rejects.toThrow();
    expect(asCommandAuditEvidenceList(auditEvents)).toEqual([
      expect.objectContaining({
        action: "command.policy_denied",
        kind: "test",
        manifestId: manifest.id,
        policyDecision: expect.objectContaining({
          decision: "denied",
          reason: "command_denylisted",
          matchedPattern: "node"
        })
      })
    ]);
  });

  it("captures output, exit code, timeout state, and redacts logs", async () => {
    const secret = "patchpilot_fixture_secret_command_executor_123";
    const result = await executeCommand({
      kind: "shell",
      command: nodeCommand(`console.log('${secret}')`),
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 4096
    });

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("[REDACTED:token]");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.auditEvents.map((event) => event.action)).toEqual(["command.started", "command.completed"]);
    expect(result.auditEvents.at(-1)).toMatchObject({
      exitCode: 0,
      timedOut: false,
      outputPreview: expect.stringContaining("[REDACTED:token]")
    });
  });

  it("redacts known secrets from inherited environment output", async () => {
    const envKey = "PATCHPILOT_COMMAND_EXECUTOR_TEST_TOKEN";
    const secret = "short-env-secret-value";
    const previous = process.env[envKey];
    process.env[envKey] = secret;
    try {
      const result = await executeCommand({
        kind: "shell",
        command: nodeCommand(`console.log(process.env.${envKey})`),
        cwd: process.cwd(),
        timeoutMs: 5000,
        maxOutputBytes: 4096
      });

      expect(result.output).toContain("[REDACTED:secret]");
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      if (previous === undefined) delete process.env[envKey];
      else process.env[envKey] = previous;
    }
  });

  it("caps timeout from the active capability manifest", async () => {
    const manifest = generateCapabilityManifest({
      commands: {
        allow: ["node -e*"]
      },
      testTimeoutMs: 20
    });
    const result = await executeCommand({
      kind: "test",
      command: nodeCommand("setTimeout(() => {}, 1000)"),
      cwd: process.cwd(),
      timeoutMs: 5000,
      capabilityManifest: manifest
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("wraps delegated execution without bypassing policy", async () => {
    const manifest = generateCapabilityManifest({
      commands: {
        allow: ["pnpm test"]
      }
    });
    let delegated = false;
    const result = await executeCommand({
      kind: "test",
      command: "pnpm test",
      cwd: process.cwd(),
      timeoutMs: 5000,
      capabilityManifest: manifest,
      executor: async (options) => {
        delegated = true;
        expect(options.timeoutMs).toBe(5000);
        return {
          exitCode: 0,
          output: "delegated ok",
          stdout: "delegated ok",
          stderr: "",
          timedOut: false,
          durationMs: 7
        };
      }
    });

    expect(delegated).toBe(true);
    expect(result.output).toContain("delegated ok");
    expect(result.auditEvents.map((event) => event.action)).toEqual([
      "command.policy_allowed",
      "command.started",
      "command.completed"
    ]);
  });

  it("streams a spawned command while retaining completion audit", async () => {
    const spawned = await spawnCommand({
      kind: "codex",
      command: process.execPath,
      args: ["-e", "process.stdin.on('data', chunk => process.stdout.write(chunk))"],
      cwd: process.cwd(),
      timeoutMs: 5000
    });
    let streamed = "";
    spawned.child.stdout.on("data", (chunk: Buffer) => {
      streamed += chunk.toString("utf8");
    });
    spawned.child.stdin.end("hello-stream");

    const result = await spawned.done;
    expect(result.exitCode).toBe(0);
    expect(streamed).toBe("hello-stream");
    expect(result.stdout).toBe("hello-stream");
    expect(result.auditEvents.map((event) => event.action)).toEqual(["command.started", "command.completed"]);
  });

  it("quotes commands consistently for policy display", () => {
    expect(shellJoin(["git", "commit", "-m", "hello world"])).toBe("'git' 'commit' '-m' 'hello world'");
  });
});

function nodeCommand(script: string) {
  return `node -e ${JSON.stringify(script.replace(/\s+/g, " ").trim())}`;
}
