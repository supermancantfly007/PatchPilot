import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTestOutput, runTestCommand } from "./index";

describe("TestRunner", () => {
  it("records a passing command with artifact and runtime metadata", async () => {
    const run = await runTestCommand({
      command: nodeCommand("console.log('ok')"),
      cwd: process.cwd(),
      timeoutMs: 5000,
      collectGitMetadata: false
    });

    expect(run.status).toBe("passed");
    expect(run.summary).toContain("ok");
    expect(run.exitCode).toBe(0);
    expect(run.runner).toBe("patchpilot-test-runner");
    expect(run.environmentImage).toBe("local");
    expect(run.workspacePath).toBe(process.cwd());
    expect(run.logArtifactId).toMatch(/^artifact_test_log_/);
    expect(run.artifactIds).toEqual([run.logArtifactId]);
    expect(run.retryCount).toBe(0);
    expect(run.flakySignal).toBe(false);
  });

  it("captures failures and exit codes", async () => {
    const run = await runTestCommand({
      command: nodeCommand("console.error('expected failure'); process.exit(2)"),
      cwd: process.cwd(),
      timeoutMs: 5000,
      collectGitMetadata: false
    });

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBe(2);
    expect(run.failureSummary).toContain("expected failure");
  });

  it("fails timed out commands", async () => {
    const run = await runTestCommand({
      command: nodeCommand("setTimeout(() => {}, 1000)"),
      cwd: process.cwd(),
      timeoutMs: 50,
      collectGitMetadata: false
    });

    expect(run.status).toBe("failed");
    expect(run.exitCode).toBeNull();
    expect(run.failureSummary).toContain("超时");
  });

  it("retries transient failures and marks flaky signals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "patchpilot-test-runner-"));
    const statePath = join(dir, "attempt.txt");
    await writeFile(statePath, "0");

    const run = await runTestCommand({
      command: nodeCommand(`
        const fs = require('fs');
        const path = ${JSON.stringify(statePath)};
        const attempt = Number(fs.readFileSync(path, 'utf8'));
        fs.writeFileSync(path, String(attempt + 1));
        if (attempt === 0) {
          console.error('first attempt failed');
          process.exit(1);
        }
        console.log('second attempt passed');
      `),
      cwd: dir,
      timeoutMs: 5000,
      maxAttempts: 2,
      collectGitMetadata: false
    });

    expect(run.status).toBe("passed");
    expect(run.retryCount).toBe(1);
    expect(run.attempt).toBe(2);
    expect(run.maxAttempts).toBe(2);
    expect(run.flakySignal).toBe(true);
    expect(run.summary).toContain("flaky signal");
  });

  it("parses JSON and JUnit reports", () => {
    expect(parseTestOutput(JSON.stringify({
      numTotalTests: 4,
      numPassedTests: 3,
      numFailedTests: 1,
      failureSummary: "one failed assertion"
    }))).toMatchObject({
      format: "json",
      total: 4,
      passed: 3,
      failed: 1,
      failureSummary: "one failed assertion"
    });

    expect(parseTestOutput(`
      <testsuites>
        <testsuite tests="2" failures="1" errors="0" skipped="0">
          <testcase name="fails"><failure>expected true</failure></testcase>
        </testsuite>
      </testsuites>
    `)).toMatchObject({
      format: "junit",
      total: 2,
      passed: 1,
      failed: 1,
      failureSummary: "expected true"
    });
  });
});

function nodeCommand(script: string) {
  return `node -e ${JSON.stringify(script.replace(/\s+/g, " ").trim())}`;
}
