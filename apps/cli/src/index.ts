import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type {
  AcceptanceDecision,
  AgentRun,
  AgentRunnerKind,
  PatchPilotSnapshot,
  Prd,
  Requirement,
  RequirementTemplate,
  WorkItem
} from "@patchpilot/domain";
import { runWorkerTick } from "@patchpilot/worker";

const defaultApiBaseUrl = "http://localhost:4000";
const templates = ["feature", "bug", "ui", "document"] as const;
const runners = ["simulated", "codex"] as const;
const acceptanceStatuses = ["accepted", "rejected"] as const;

type CliAcceptanceStatus = (typeof acceptanceStatuses)[number];

interface ParsedArgs {
  command: string;
  options: Record<string, string | boolean>;
  positionals: string[];
}

interface CliContext {
  apiBaseUrl: string;
  json: boolean;
  authUserId?: string;
  authRole?: string;
}

interface CreatePrdResponse {
  requirement: Requirement;
  prd: Prd;
}

interface ApprovePrdResponse {
  prd: Prd;
  workItems: WorkItem[];
}

interface StartTeamResponse {
  prd: Prd;
  workItems: WorkItem[];
  runs: AgentRun[];
  skippedWorkItems: WorkItem[];
}

interface TeamAcceptanceResponse {
  decisions: AcceptanceDecision[];
  workItems: WorkItem[];
  runs: AgentRun[];
}

interface HappyPathResult {
  requirement: Requirement;
  prd: Prd;
  workItems: WorkItem[];
  runs: AgentRun[];
  acceptance: TeamAcceptanceResponse;
  report: string;
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);
  const context = getContext(parsed);

  try {
    switch (parsed.command) {
      case "help":
      case "--help":
      case "-h":
        console.log(helpText());
        return;
      case "submit":
        await commandSubmit(parsed, context);
        return;
      case "create-prd":
        await commandCreatePrd(parsed, context);
        return;
      case "approve-prd":
        await commandApprovePrd(parsed, context);
        return;
      case "snapshot":
        await commandSnapshot(context);
        return;
      case "start-team":
        await commandStartTeam(parsed, context);
        return;
      case "worker-once":
        await commandWorkerOnce(parsed, context);
        return;
      case "accept-prd":
        await commandAcceptPrd(parsed, context);
        return;
      case "report":
        await commandReport(parsed, context);
        return;
      case "happy-path":
        await commandHappyPath(parsed, context);
        return;
      default:
        throw new Error(`Unknown command "${parsed.command}". Run "patchpilot help".`);
    }
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const command = args[0] ?? "help";
  const options: ParsedArgs["options"] = {};
  const positionals: string[] = [];

  for (let index = 1; index < args.length; index += 1) {
    const token = args[index];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const raw = token.slice(2);
    const separatorIndex = raw.indexOf("=");
    if (separatorIndex >= 0) {
      options[raw.slice(0, separatorIndex)] = raw.slice(separatorIndex + 1);
      continue;
    }

    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      options[raw] = next;
      index += 1;
    } else {
      options[raw] = true;
    }
  }

  return { command, options, positionals };
}

export function buildReport(snapshot: PatchPilotSnapshot, filters: { prdId?: string; requirementId?: string } = {}) {
  const prds = snapshot.prds.filter((prd) => matchesFilters(prd, filters));
  const requirements = snapshot.requirements.filter((requirement) =>
    filters.requirementId ? requirement.id === filters.requirementId : prds.some((prd) => prd.requirementId === requirement.id)
  );
  const prdIds = new Set(prds.map((prd) => prd.id));
  const workItems = snapshot.workItems.filter((item) => prdIds.has(item.prdId));
  const runs = snapshot.agentRuns.filter((run) => prdIds.has(run.prdId));
  const runIds = new Set(runs.map((run) => run.id));
  const testCases = snapshot.testCases.filter((testCase) => prdIds.has(testCase.prdId));
  const testRuns = snapshot.testRuns.filter((run) => run.prdId && prdIds.has(run.prdId));
  const workspaceRuns = snapshot.workspaceRuns.filter((workspace) => prdIds.has(workspace.prdId));
  const pullRequests = snapshot.pullRequests.filter((pullRequest) => prdIds.has(pullRequest.prdId));
  const reviews = snapshot.reviewRecords.filter((review) => prdIds.has(review.prdId));
  const audits = snapshot.auditEvents.filter((event) => event.prdId && prdIds.has(event.prdId));
  const acceptances = snapshot.acceptances.filter((acceptance) => runIds.has(acceptance.runId));

  return [
    "# PatchPilot Delivery Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Requirements: ${requirements.length}`,
    `PRDs: ${prds.length}`,
    `Work items: ${workItems.length}`,
    `Agent runs: ${runs.length}`,
    `Workspace runs: ${workspaceRuns.length}`,
    `Test cases: ${testCases.length}`,
    `Passed test runs: ${testRuns.filter((run) => run.status === "passed").length}/${testRuns.length}`,
    `Pull requests: ${pullRequests.length}`,
    `Approved reviews: ${reviews.filter((review) => review.status === "approved").length}/${reviews.length}`,
    `Accepted runs: ${acceptances.filter((acceptance) => acceptance.status === "accepted").length}/${runs.length}`,
    `Audit events: ${audits.length}`,
    "",
    "## PRDs",
    ...prds.flatMap((prd) => {
      const prdWorkItems = workItems.filter((item) => item.prdId === prd.id);
      const prdRuns = runs.filter((run) => run.prdId === prd.id);
      return [
        "",
        `### ${prd.title}`,
        "",
        `- PRD: ${prd.id}`,
        `- Requirement: ${prd.requirementId}`,
        `- Status: ${prd.status}`,
        `- Work items: ${formatCounts(prdWorkItems.map((item) => item.status))}`,
        `- Runs: ${formatCounts(prdRuns.map((run) => run.status))}`
      ];
    }),
    "",
    "## Evidence",
    "",
    `- Workspace runs: ${formatCounts(workspaceRuns.map((workspace) => workspace.status))}`,
    `- Test cases: ${formatCounts(testCases.map((testCase) => testCase.status))}`,
    `- Test runs: ${formatCounts(testRuns.map((testRun) => testRun.status))}`,
    `- Pull requests: ${formatCounts(pullRequests.map((pullRequest) => pullRequest.status))}`,
    `- Reviews: ${formatCounts(reviews.map((review) => review.status))}`,
    "",
    "## Acceptance",
    "",
    `- Decisions: ${formatCounts(acceptances.map((acceptance) => acceptance.status))}`
  ].join("\n");
}

export function summarizeSnapshot(snapshot: PatchPilotSnapshot) {
  return {
    requirements: snapshot.requirements.length,
    prds: snapshot.prds.length,
    workItems: snapshot.workItems.length,
    agentRuns: snapshot.agentRuns.length,
    testCases: snapshot.testCases.length,
    testRuns: snapshot.testRuns.length,
    pullRequests: snapshot.pullRequests.length,
    reviewRecords: snapshot.reviewRecords.length,
    auditEvents: snapshot.auditEvents.length,
    bugs: snapshot.bugs.length
  };
}

async function commandSubmit(parsed: ParsedArgs, context: CliContext) {
  const input = requireOption(parsed, "input");
  const template = parseTemplate(option(parsed, "template") ?? "feature");
  const requirement = await requestJson<Requirement>(context, "/api/requirements", {
    method: "POST",
    body: JSON.stringify({ rawInput: input, template })
  });
  print(context, requirement, `Created requirement ${requirement.id}`);
}

async function commandCreatePrd(parsed: ParsedArgs, context: CliContext) {
  const requirementId = requireOption(parsed, "requirement");
  const response = await requestJson<CreatePrdResponse>(context, `/api/requirements/${requirementId}/prd`, {
    method: "POST"
  });
  print(context, response, `Created PRD ${response.prd.id}`);
}

async function commandApprovePrd(parsed: ParsedArgs, context: CliContext) {
  const prdId = requireOption(parsed, "prd");
  const response = await requestJson<ApprovePrdResponse>(context, `/api/prds/${prdId}/approve`, {
    method: "POST"
  });
  print(context, response, `Approved ${response.prd.id} with ${response.workItems.length} work items`);
}

async function commandSnapshot(context: CliContext) {
  const snapshot = await getSnapshot(context);
  print(context, snapshot, JSON.stringify(summarizeSnapshot(snapshot), null, 2));
}

async function commandStartTeam(parsed: ParsedArgs, context: CliContext) {
  const prdId = requireOption(parsed, "prd");
  const runner = parseRunner(option(parsed, "runner"));
  const response = await requestJson<StartTeamResponse>(context, `/api/prds/${encodeURIComponent(prdId)}/start-team`, {
    method: "POST",
    body: JSON.stringify({ runner })
  });
  print(context, response, `Started ${response.runs.length} runs for ${response.prd.id}`);
}

async function commandWorkerOnce(parsed: ParsedArgs, context: CliContext) {
  const runner = parseRunner(option(parsed, "runner"));
  const result = await runWorkerTick(
    { apiBaseUrl: context.apiBaseUrl, intervalMs: 1, once: true, runner, silent: true },
    { throwOnError: true }
  );
  print(context, result, `Worker tick completed: ${result.dispatched}/${result.planned} dispatched`);
}

async function commandAcceptPrd(parsed: ParsedArgs, context: CliContext) {
  const prdId = requireOption(parsed, "prd");
  const status = parseAcceptanceStatus(option(parsed, "status") ?? "accepted");
  const reason = option(parsed, "reason");
  const response = await requestJson<TeamAcceptanceResponse>(context, `/api/prds/${encodeURIComponent(prdId)}/acceptance`, {
    method: "POST",
    body: JSON.stringify({ status, reason })
  });
  print(context, response, `${status === "accepted" ? "Accepted" : "Rejected"} ${response.decisions.length} runs for ${prdId}`);
}

async function commandReport(parsed: ParsedArgs, context: CliContext) {
  const snapshot = await getSnapshot(context);
  const report = buildReport(snapshot, {
    prdId: option(parsed, "prd"),
    requirementId: option(parsed, "requirement")
  });
  const out = option(parsed, "out");
  if (out) {
    await writeFile(out, report, "utf8");
  }
  print(context, { report, out }, out ? `Wrote report to ${out}` : report);
}

async function commandHappyPath(parsed: ParsedArgs, context: CliContext) {
  const result = await runHappyPath(context, {
    input: requireOption(parsed, "input"),
    template: parseTemplate(option(parsed, "template") ?? "feature"),
    runner: parseRunner(option(parsed, "runner"))
  });
  const out = option(parsed, "out");
  if (out) {
    await writeFile(out, result.report, "utf8");
  }
  print(
    context,
    { ...result, out },
    out
      ? `Accepted ${result.acceptance.decisions.length} runs for ${result.prd.id}; wrote report to ${out}`
      : `Accepted ${result.acceptance.decisions.length} runs for ${result.prd.id}`
  );
}

export async function runHappyPath(
  context: CliContext,
  input: { input: string; template: RequirementTemplate; runner?: AgentRunnerKind }
): Promise<HappyPathResult> {
  const requirement = await requestJson<Requirement>(context, "/api/requirements", {
    method: "POST",
    body: JSON.stringify({ rawInput: input.input, template: input.template })
  });
  const { prd } = await requestJson<CreatePrdResponse>(context, `/api/requirements/${requirement.id}/prd`, {
    method: "POST"
  });
  const approval = await requestJson<ApprovePrdResponse>(context, `/api/prds/${prd.id}/approve`, {
    method: "POST"
  });

  await runWorkerTick(
    { apiBaseUrl: context.apiBaseUrl, intervalMs: 1, once: true, runner: input.runner, silent: true },
    { throwOnError: true }
  );
  const completed = await pollTeamCompletion(context, prd.id, approval.workItems.map((item) => item.id));
  const acceptance = await requestJson<TeamAcceptanceResponse>(context, `/api/prds/${prd.id}/acceptance`, {
    method: "POST",
    body: JSON.stringify({ status: "accepted" })
  });
  const snapshot = await getSnapshot(context);

  return {
    requirement,
    prd,
    workItems: completed.workItems,
    runs: completed.runs,
    acceptance,
    report: buildReport(snapshot, { prdId: prd.id })
  };
}

async function pollTeamCompletion(context: CliContext, prdId: string, workItemIds: string[]) {
  const expected = new Set(workItemIds);
  return poll(async () => {
    const snapshot = await getSnapshot(context);
    const workItems = snapshot.workItems.filter((item) => expected.has(item.id));
    const runs = snapshot.agentRuns.filter((run) => run.prdId === prdId && expected.has(run.workItemId));
    if (workItems.length !== expected.size) return undefined;
    if (runs.length < expected.size) return undefined;
    if (!workItems.every((item) => item.status === "review")) return undefined;
    if (!runs.every((run) => run.status === "succeeded")) return undefined;
    return { workItems, runs };
  }, 15000);
}

async function getSnapshot(context: CliContext) {
  return requestJson<PatchPilotSnapshot>(context, "/api/snapshot", { method: "GET" });
}

async function requestJson<T>(context: CliContext, path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (context.authUserId && context.authRole) {
    headers.set("x-patchpilot-user", context.authUserId);
    headers.set("x-patchpilot-role", context.authRole);
  }
  const response = await fetch(`${context.apiBaseUrl}${path}`, { ...init, headers });
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function poll<T>(read: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function getContext(parsed: ParsedArgs): CliContext {
  const authUserId = trimOptional(
    option(parsed, "auth-user") ??
      process.env.PATCHPILOT_AUTH_USER ??
      process.env.PATCHPILOT_CLI_AUTH_USER
  );
  const authRole = trimOptional(
    option(parsed, "auth-role") ??
      process.env.PATCHPILOT_AUTH_ROLE ??
      process.env.PATCHPILOT_CLI_AUTH_ROLE
  );
  return {
    apiBaseUrl: trimTrailingSlash(option(parsed, "api") ?? process.env.PATCHPILOT_API_BASE_URL ?? defaultApiBaseUrl),
    json: parsed.options.json === true,
    ...(authUserId && authRole ? { authUserId, authRole } : {})
  };
}

function option(parsed: ParsedArgs, key: string) {
  const value = parsed.options[key];
  return typeof value === "string" ? value : undefined;
}

function requireOption(parsed: ParsedArgs, key: string) {
  const value = option(parsed, key);
  if (!value) throw new Error(`Missing required --${key}`);
  return value;
}

function parseTemplate(value: string): RequirementTemplate {
  if (templates.includes(value as RequirementTemplate)) return value as RequirementTemplate;
  throw new Error(`Invalid template "${value}". Expected one of: ${templates.join(", ")}`);
}

function parseRunner(value: string | undefined): AgentRunnerKind | undefined {
  if (!value) return undefined;
  if (runners.includes(value as AgentRunnerKind)) return value as AgentRunnerKind;
  throw new Error(`Invalid runner "${value}". Expected one of: ${runners.join(", ")}`);
}

function parseAcceptanceStatus(value: string): CliAcceptanceStatus {
  if (acceptanceStatuses.includes(value as CliAcceptanceStatus)) {
    return value as CliAcceptanceStatus;
  }
  throw new Error(`Invalid acceptance status "${value}". Expected one of: ${acceptanceStatuses.join(", ")}`);
}

function matchesFilters(prd: Prd, filters: { prdId?: string; requirementId?: string }) {
  if (filters.prdId && prd.id !== filters.prdId) return false;
  if (filters.requirementId && prd.requirementId !== filters.requirementId) return false;
  return true;
}

function formatCounts(values: string[]) {
  if (values.length === 0) return "none";
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([value, count]) => `${value}=${count}`).join(", ");
}

function print(context: CliContext, payload: unknown, text: string) {
  console.log(context.json ? JSON.stringify(payload, null, 2) : text);
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function trimOptional(value: string | undefined) {
  const normalized = value?.trim();
  return normalized || undefined;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function helpText() {
  return [
    "PatchPilot CLI",
    "",
    "Commands:",
    "  submit --input <text> [--template feature|bug|ui|document]",
    "  create-prd --requirement <requirement-id>",
    "  approve-prd --prd <prd-id>",
    "  snapshot [--json]",
    "  start-team --prd <prd-id> [--runner simulated|codex]",
    "  worker-once [--runner simulated|codex]",
    "  accept-prd --prd <prd-id> [--status accepted|rejected] [--reason <text>]",
    "  report [--prd <prd-id>] [--requirement <requirement-id>] [--out report.md]",
    "  happy-path --input <text> [--template feature|bug|ui|document] [--runner simulated|codex] [--out report.md]",
    "",
    "Global options:",
    "  --api <url>   API base URL, default http://localhost:4000",
    "  --auth-user <id> --auth-role <role>   Auth context for protected approval actions",
    "  --json        Print machine-readable JSON",
    "",
    "Auth env: PATCHPILOT_AUTH_USER and PATCHPILOT_AUTH_ROLE"
  ].join("\n");
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void runCli();
}
