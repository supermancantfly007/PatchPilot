import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { TestRun, TestRunStatus } from "@patchpilot/domain";
import { enforceCommandPolicy, type CapabilityManifest } from "@patchpilot/policy";

export type TestOutputFormat = "auto" | "json" | "junit" | "text";

export interface ParsedTestOutput {
  format: Exclude<TestOutputFormat, "auto">;
  summary: string;
  failureSummary?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
}

export interface CommandExecutorOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  maxOutputBytes?: number;
  capabilityManifest?: CapabilityManifest;
}

export interface CommandExecutorResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

export type CommandExecutor = (options: CommandExecutorOptions) => Promise<CommandExecutorResult>;

export interface TestRunnerOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxAttempts?: number;
  parseFormat?: TestOutputFormat;
  runId?: string;
  prdId?: string;
  workItemId?: string;
  testCaseId?: string;
  pullRequestId?: string;
  runner?: string;
  environmentImage?: string;
  workspacePath?: string;
  env?: NodeJS.ProcessEnv;
  inheritEnv?: boolean;
  collectGitMetadata?: boolean;
  maxOutputBytes?: number;
  executor?: CommandExecutor;
  capabilityManifest?: CapabilityManifest;
}

interface CommandAttempt {
  attempt: number;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  durationMs: number;
}

interface GitMetadata {
  commit?: string;
  branch?: string;
}

export class TestRunner {
  constructor(private readonly defaults: Partial<TestRunnerOptions> = {}) {}

  run(options: TestRunnerOptions) {
    return runTestCommand({ ...this.defaults, ...options });
  }
}

export async function runTestCommand(options: TestRunnerOptions): Promise<TestRun> {
  const command = options.command.trim();
  if (!command) throw new Error("Test command must not be empty");
  if (options.capabilityManifest) enforceCommandPolicy(options.capabilityManifest, command);
  const timeoutMs = Math.min(options.timeoutMs, options.capabilityManifest?.runtime.maxRuntimeMs ?? options.timeoutMs);

  const startedAt = new Date();
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 1));
  const attempts: CommandAttempt[] = [];
  let passedAttempt: CommandAttempt | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await executeTestCommand(options.executor, {
      command,
      cwd: options.cwd,
      timeoutMs,
      env: options.env,
      inheritEnv: options.inheritEnv,
      maxOutputBytes: options.maxOutputBytes,
      capabilityManifest: options.capabilityManifest
    });
    const commandAttempt = { attempt, ...result };
    attempts.push(commandAttempt);

    const parsed = parseTestOutput(commandAttempt.output, options.parseFormat ?? "auto");
    const parsedHasFailures = (parsed.failed ?? 0) > 0;
    if (commandAttempt.exitCode === 0 && !commandAttempt.timedOut && !parsedHasFailures) {
      passedAttempt = commandAttempt;
      break;
    }
  }

  const endedAt = new Date();
  const lastAttempt = attempts[attempts.length - 1];
  if (!lastAttempt) throw new Error("Test runner did not execute any attempts");

  const parsed = parseTestOutput(lastAttempt.output, options.parseFormat ?? "auto");
  const retryCount = attempts.length - 1;
  const flakySignal = Boolean(passedAttempt && attempts.some((attempt) => attempt.exitCode !== 0 || attempt.timedOut));
  const status = statusForAttempt(lastAttempt, parsed);
  const failureSummary = status === "failed" ? summarizeFailure(lastAttempt, parsed, timeoutMs) : undefined;
  const logArtifactId = `artifact_test_log_${randomUUID()}`;
  const git = options.collectGitMetadata === false ? {} : await readGitMetadata(options.cwd);

  return {
    id: `test_${randomUUID()}`,
    ...(options.testCaseId ? { testCaseId: options.testCaseId } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.prdId ? { prdId: options.prdId } : {}),
    ...(options.workItemId ? { workItemId: options.workItemId } : {}),
    status,
    command,
    summary: summarizeRun(status, parsed, lastAttempt, retryCount, maxAttempts, timeoutMs),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    exitCode: lastAttempt.exitCode,
    ...(failureSummary ? { failureSummary } : {}),
    retryCount,
    attempt: lastAttempt.attempt,
    maxAttempts,
    flakySignal,
    runner: options.runner ?? "patchpilot-test-runner",
    environmentImage: options.environmentImage ?? "local",
    workspacePath: options.workspacePath ?? options.cwd,
    ...(git.commit ? { commit: git.commit } : {}),
    ...(git.branch ? { branch: git.branch } : {}),
    ...(options.pullRequestId ? { pullRequestId: options.pullRequestId } : {}),
    logArtifactId,
    artifactIds: [logArtifactId]
  };
}

function executeTestCommand(
  executor: CommandExecutor | undefined,
  options: CommandExecutorOptions
) {
  if (executor) return executor(options);
  return runShellCommand(options.command, options.cwd, options.timeoutMs, {
    env: options.env,
    inheritEnv: options.inheritEnv,
    maxOutputBytes: options.maxOutputBytes
  });
}

export function parseTestOutput(output: string, format: TestOutputFormat = "auto"): ParsedTestOutput {
  if (format === "json" || format === "auto") {
    const parsedJson = parseJsonOutput(output);
    if (parsedJson || format === "json") return parsedJson ?? parseTextOutput(output, "json");
  }

  if (format === "junit" || format === "auto") {
    const parsedJunit = parseJunitOutput(output);
    if (parsedJunit || format === "junit") return parsedJunit ?? parseTextOutput(output, "junit");
  }

  return parseTextOutput(output, "text");
}

function statusForAttempt(attempt: CommandAttempt, parsed: ParsedTestOutput): TestRunStatus {
  if (attempt.timedOut || attempt.exitCode !== 0) return "failed";
  return (parsed.failed ?? 0) > 0 ? "failed" : "passed";
}

function summarizeRun(
  status: TestRunStatus,
  parsed: ParsedTestOutput,
  attempt: CommandAttempt,
  retryCount: number,
  maxAttempts: number,
  timeoutMs: number
) {
  if (attempt.timedOut) {
    return `测试命令超时，已运行超过 ${timeoutMs}ms。`;
  }

  const base = status === "passed" ? parsed.summary || "项目测试通过" : summarizeFailure(attempt, parsed, timeoutMs);
  if (status === "passed" && retryCount > 0) {
    return `${base} 第 ${attempt.attempt}/${maxAttempts} 次尝试通过，记录 flaky signal。`;
  }
  return base;
}

function summarizeFailure(attempt: CommandAttempt, parsed: ParsedTestOutput, timeoutMs: number) {
  if (attempt.timedOut) return `测试命令超时，已运行超过 ${timeoutMs}ms。`;
  return parsed.failureSummary || parsed.summary || tail(attempt.output.trim(), 1600) || `测试命令失败，退出码 ${attempt.exitCode}`;
}

function parseJsonOutput(output: string): ParsedTestOutput | undefined {
  const candidate = parseJsonCandidate(output);
  if (!candidate) return undefined;

  const total = pickNumber(candidate, ["numTotalTests", "total", "tests"]);
  const passed = pickNumber(candidate, ["numPassedTests", "passed"]);
  const failed = pickNumber(candidate, ["numFailedTests", "failed", "failures", "errors"]);
  const skipped = pickNumber(candidate, ["numPendingTests", "numTodoTests", "skipped", "pending"]);
  const stats = asRecord(candidate.stats);
  const statsTotal = stats ? pickNumber(stats, ["tests", "total"]) : undefined;
  const statsPassed = stats ? pickNumber(stats, ["passes", "passed"]) : undefined;
  const statsFailed = stats ? pickNumber(stats, ["failures", "failed"]) : undefined;
  const statsSkipped = stats ? pickNumber(stats, ["pending", "skipped"]) : undefined;

  const normalized = {
    total: total ?? statsTotal,
    passed: passed ?? statsPassed,
    failed: failed ?? statsFailed,
    skipped: skipped ?? statsSkipped
  };
  const summaryFromJson = stringValue(candidate.summary);
  const failureSummary = stringValue(candidate.failureSummary) || summarizeJsonFailures(candidate);
  const summary = summaryFromJson || renderCountSummary("JSON", normalized);

  return {
    format: "json",
    summary,
    ...(failureSummary ? { failureSummary } : {}),
    ...definedCounts(normalized)
  };
}

function parseJsonCandidate(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim();
  const candidates = [trimmed, ...trimmed.split("\n").map((line) => line.trim()).reverse()];

  for (const candidate of candidates) {
    if (!candidate.startsWith("{") || !candidate.endsWith("}")) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = asRecord(parsed);
      if (record) return record;
    } catch {
      // Keep trying later lines; many runners mix logs and JSON.
    }
  }
  return undefined;
}

function parseJunitOutput(output: string): ParsedTestOutput | undefined {
  const suites = [...output.matchAll(/<testsuite\b([^>]*)>/g)];
  const suiteAttributes = suites.map((suite) => parseXmlAttributes(suite[1] ?? ""));
  const attributes = suiteAttributes.length > 0
    ? sumSuiteAttributes(suiteAttributes)
    : parseXmlAttributes(output.match(/<testsuites\b([^>]*)>/)?.[1] ?? "");

  if (!attributes.tests && !attributes.failures && !attributes.errors && !attributes.skipped) return undefined;

  const failed = attributes.failures + attributes.errors;
  const counts = {
    total: attributes.tests,
    passed: Math.max(0, attributes.tests - failed - attributes.skipped),
    failed,
    skipped: attributes.skipped
  };
  const failureSummary = firstXmlFailure(output);

  return {
    format: "junit",
    summary: renderCountSummary("JUnit", counts),
    ...(failureSummary ? { failureSummary } : {}),
    ...definedCounts(counts)
  };
}

function parseTextOutput(output: string, format: Exclude<TestOutputFormat, "auto">): ParsedTestOutput {
  const summary = tail(output.trim(), 1600) || "No test output captured";
  return {
    format,
    summary,
    failureSummary: summary
  };
}

function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  options: { env?: NodeJS.ProcessEnv; inheritEnv?: boolean; maxOutputBytes?: number } = {}
): Promise<Omit<CommandAttempt, "attempt">> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("sh", ["-lc", command], {
      cwd,
      env: options.inheritEnv === false ? options.env ?? {} : { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    let timedOut = false;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 1000).unref();
    }, timeoutMs);

    const append = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > maxOutputBytes) output = output.slice(output.length - maxOutputBytes);
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({
        exitCode: 1,
        output: error.message,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({
        exitCode,
        output,
        timedOut,
        durationMs: Date.now() - startedAt
      });
    });
  });
}

async function readGitMetadata(cwd: string): Promise<GitMetadata> {
  const [commit, branch] = await Promise.all([
    readGitValue("git rev-parse HEAD", cwd),
    readGitValue("git rev-parse --abbrev-ref HEAD", cwd)
  ]);
  return {
    ...(commit ? { commit } : {}),
    ...(branch && branch !== "HEAD" ? { branch } : {})
  };
}

async function readGitValue(command: string, cwd: string) {
  const result = await runShellCommand(command, cwd, 5000, { maxOutputBytes: 4096 });
  if (result.exitCode !== 0) return undefined;
  const value = result.output.trim();
  return value || undefined;
}

function parseXmlAttributes(value: string) {
  const attributes = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const key of Object.keys(attributes) as Array<keyof typeof attributes>) {
    const raw = value.match(new RegExp(`${key}="([^"]+)"`))?.[1];
    const parsed = raw ? Number(raw) : 0;
    attributes[key] = Number.isFinite(parsed) ? parsed : 0;
  }
  return attributes;
}

function sumSuiteAttributes(items: ReturnType<typeof parseXmlAttributes>[]) {
  return items.reduce(
    (total, item) => ({
      tests: total.tests + item.tests,
      failures: total.failures + item.failures,
      errors: total.errors + item.errors,
      skipped: total.skipped + item.skipped
    }),
    { tests: 0, failures: 0, errors: 0, skipped: 0 }
  );
}

function firstXmlFailure(output: string) {
  const match = output.match(/<(failure|error)\b[^>]*>([\s\S]*?)<\/\1>/);
  if (!match?.[2]) return undefined;
  return tail(match[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), 1600);
}

function summarizeJsonFailures(candidate: Record<string, unknown>) {
  const testResults = Array.isArray(candidate.testResults) ? candidate.testResults : [];
  for (const result of testResults) {
    const record = asRecord(result);
    const assertionResults = Array.isArray(record?.assertionResults) ? record.assertionResults : [];
    for (const assertion of assertionResults) {
      const assertionRecord = asRecord(assertion);
      const messages = assertionRecord?.failureMessages;
      if (Array.isArray(messages) && typeof messages[0] === "string") return tail(messages[0], 1600);
    }
  }
  return undefined;
}

function renderCountSummary(
  label: string,
  counts: { total?: number; passed?: number; failed?: number; skipped?: number }
) {
  const parts = [
    countPart(counts.total, "tests"),
    countPart(counts.passed, "passed"),
    countPart(counts.failed, "failed"),
    countPart(counts.skipped, "skipped")
  ].filter(Boolean);
  return parts.length > 0 ? `${label}: ${parts.join(", ")}` : `${label}: test report parsed`;
}

function countPart(value: number | undefined, label: string) {
  return value === undefined ? undefined : `${value} ${label}`;
}

function pickNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function definedCounts(counts: { total?: number; passed?: number; failed?: number; skipped?: number }) {
  return {
    ...(counts.total !== undefined ? { total: counts.total } : {}),
    ...(counts.passed !== undefined ? { passed: counts.passed } : {}),
    ...(counts.failed !== undefined ? { failed: counts.failed } : {}),
    ...(counts.skipped !== undefined ? { skipped: counts.skipped } : {})
  };
}

function tail(value: string, max: number) {
  return value.length > max ? value.slice(value.length - max) : value;
}
