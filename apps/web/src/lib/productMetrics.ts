import type {
  AcceptanceDecision,
  AgentRun,
  ApprovalRecord,
  AuditChainVerification,
  AuditEvent,
  PatchPilotSnapshot,
  TestRun
} from "@patchpilot/domain";

export type FailureReasonKey = Exclude<AgentRun["failureType"], undefined> | "cancelled" | "unknown";

export interface RateMetric {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export interface RequirementToPrSample {
  requirementId: string;
  pullRequestId: string;
  durationMs: number;
}

export interface FailureReasonMetric {
  key: FailureReasonKey;
  count: number;
  costUsd: number;
}

export interface AuditMissingTarget {
  type: AuditEvent["targetType"];
  id: string;
}

export interface ProductMetricsDashboard {
  requirementToPr: {
    averageMs: number | null;
    count: number;
    samples: RequirementToPrSample[];
  };
  autonomousCompletion: RateMetric;
  firstTestPass: RateMetric;
  humanInterventions: {
    total: number;
    approvalCount: number;
    acceptanceDecisionCount: number;
    rejectionCount: number;
  };
  failureReasons: FailureReasonMetric[];
  costPerAcceptedPr: {
    valueUsd: number | null;
    totalCostUsd: number;
    acceptedPrCount: number;
  };
  reproductionSuccess: RateMetric;
  auditCompleteness: RateMetric & {
    checkedEvents: number;
    chainValid?: boolean;
    missingTargets: AuditMissingTarget[];
  };
  reworkRounds: {
    total: number;
    average: number | null;
    max: number;
    workItemCount: number;
  };
  finalAcceptance: RateMetric;
}

interface ProductMetricsOptions {
  auditVerification?: AuditChainVerification | null;
}

const terminalRunStatuses = new Set<AgentRun["status"]>(["succeeded", "failed", "cancelled"]);
const completedTestStatuses = new Set<TestRun["status"]>(["passed", "failed", "blocked", "skipped"]);
const attemptedBugStatuses = new Set(["reproduced", "unreproducible", "fixing", "verifying", "closed"]);
const successfulBugStatuses = new Set(["reproduced", "fixing", "verifying", "closed"]);

export function computeProductMetrics(
  snapshot: PatchPilotSnapshot,
  options: ProductMetricsOptions = {}
): ProductMetricsDashboard {
  const requirementToPrSamples = requirementToPullRequestSamples(snapshot);
  const terminalRuns = snapshot.agentRuns.filter((run) => terminalRunStatuses.has(run.status));
  const rejectedRunIds = new Set(snapshot.acceptances.filter((decision) => decision.status === "rejected").map((decision) => decision.runId));
  const autonomousRuns = terminalRuns.filter(
    (run) => run.status === "succeeded" && !rejectedRunIds.has(run.id) && !hasRunApproval(snapshot.approvals, run)
  );
  const firstTests = firstTestRuns(snapshot.testRuns);
  const firstPassedTests = firstTests.filter((testRun) => testRun.status === "passed");
  const acceptedRunIds = new Set(snapshot.acceptances.filter((decision) => decision.status === "accepted").map((decision) => decision.runId));
  const acceptedPrs = snapshot.pullRequests.filter((pullRequest) => acceptedRunIds.has(pullRequest.runId));
  const totalCostUsd = snapshot.agentRuns.reduce((total, run) => total + runCostUsd(run), 0);
  const attemptedBugs = snapshot.bugs.filter((bug) => attemptedBugStatuses.has(bug.status));
  const reproducedBugs = attemptedBugs.filter((bug) => successfulBugStatuses.has(bug.status));
  const latestAcceptance = latestAcceptanceByWorkItem(snapshot.acceptances, snapshot.agentRuns);
  const finalAccepted = latestAcceptance.filter((decision) => decision.status === "accepted");
  const reworkCounts = snapshot.workItems.map((workItem) => workItem.reworkCount ?? 0);
  const totalReworkRounds = reworkCounts.reduce((total, count) => total + count, 0);
  const auditCompleteness = auditCompletenessMetric(snapshot, options.auditVerification);

  return {
    requirementToPr: {
      averageMs: average(requirementToPrSamples.map((sample) => sample.durationMs)),
      count: requirementToPrSamples.length,
      samples: requirementToPrSamples
    },
    autonomousCompletion: rate(autonomousRuns.length, terminalRuns.length),
    firstTestPass: rate(firstPassedTests.length, firstTests.length),
    humanInterventions: {
      total: snapshot.approvals.length + snapshot.acceptances.length,
      approvalCount: snapshot.approvals.length,
      acceptanceDecisionCount: snapshot.acceptances.length,
      rejectionCount: snapshot.acceptances.filter((decision) => decision.status === "rejected").length
    },
    failureReasons: failureReasonMetrics(snapshot.agentRuns),
    costPerAcceptedPr: {
      valueUsd: acceptedPrs.length > 0 ? totalCostUsd / acceptedPrs.length : null,
      totalCostUsd,
      acceptedPrCount: acceptedPrs.length
    },
    reproductionSuccess: rate(reproducedBugs.length, attemptedBugs.length),
    auditCompleteness,
    reworkRounds: {
      total: totalReworkRounds,
      average: reworkCounts.length > 0 ? totalReworkRounds / reworkCounts.length : null,
      max: reworkCounts.length > 0 ? Math.max(...reworkCounts) : 0,
      workItemCount: reworkCounts.length
    },
    finalAcceptance: rate(finalAccepted.length, latestAcceptance.length)
  };
}

export function formatMetricPercent(metric: Pick<RateMetric, "rate">) {
  return metric.rate === null ? "暂无" : `${metric.rate}%`;
}

export function formatDurationCompact(durationMs: number | null) {
  if (durationMs === null) return "暂无";
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(hours / 24);
  return `${days} 天`;
}

export function formatMetricNumber(value: number, digits = 0) {
  return new Intl.NumberFormat("zh-CN", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits
  }).format(value);
}

function requirementToPullRequestSamples(snapshot: PatchPilotSnapshot): RequirementToPrSample[] {
  return snapshot.requirements.flatMap((requirement) => {
    const requirementCreatedAt = dateMs(requirement.createdAt);
    const pullRequest = earliestByDate(
      snapshot.pullRequests.filter((item) => item.requirementId === requirement.id),
      (item) => item.createdAt
    );
    if (!pullRequest || requirementCreatedAt === null) return [];
    const pullRequestCreatedAt = dateMs(pullRequest.createdAt);
    if (pullRequestCreatedAt === null) return [];
    return [
      {
        requirementId: requirement.id,
        pullRequestId: pullRequest.id,
        durationMs: Math.max(0, pullRequestCreatedAt - requirementCreatedAt)
      }
    ];
  });
}

function hasRunApproval(approvals: ApprovalRecord[], run: AgentRun) {
  return approvals.some(
    (approval) =>
      approval.runId === run.id ||
      approval.targetId === run.id ||
      approval.id === run.budgetApprovalId ||
      approval.workItemId === run.workItemId
  );
}

function firstTestRuns(testRuns: TestRun[]) {
  const firstByEvidenceKey = new Map<string, TestRun>();
  const completedTests = testRuns.filter((testRun) => completedTestStatuses.has(testRun.status));
  for (const testRun of completedTests) {
    const key = testRun.testCaseId ?? testRun.workItemId ?? testRun.runId ?? testRun.id;
    const current = firstByEvidenceKey.get(key);
    if (!current || compareTestRunDate(testRun, current) < 0) {
      firstByEvidenceKey.set(key, testRun);
    }
  }
  return [...firstByEvidenceKey.values()];
}

function latestAcceptanceByWorkItem(acceptances: AcceptanceDecision[], runs: AgentRun[]) {
  const runById = new Map(runs.map((run) => [run.id, run]));
  const latestByWorkItem = new Map<string, AcceptanceDecision>();
  for (const decision of acceptances) {
    const key = runById.get(decision.runId)?.workItemId ?? decision.runId;
    const current = latestByWorkItem.get(key);
    if (!current || compareAcceptanceDate(decision, current) > 0) {
      latestByWorkItem.set(key, decision);
    }
  }
  return [...latestByWorkItem.values()];
}

function failureReasonMetrics(runs: AgentRun[]): FailureReasonMetric[] {
  const failures = new Map<FailureReasonKey, FailureReasonMetric>();
  for (const run of runs) {
    if (run.status !== "failed" && run.status !== "cancelled" && !run.failureType) continue;
    const key: FailureReasonKey = run.failureType ?? (run.status === "cancelled" ? "cancelled" : "unknown");
    const current = failures.get(key) ?? { key, count: 0, costUsd: 0 };
    current.count += 1;
    current.costUsd += runCostUsd(run);
    failures.set(key, current);
  }
  return [...failures.values()].sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function auditCompletenessMetric(
  snapshot: PatchPilotSnapshot,
  auditVerification?: AuditChainVerification | null
): ProductMetricsDashboard["auditCompleteness"] {
  const eventTargets = new Set(snapshot.auditEvents.map((event) => auditTargetKey(event.targetType, event.targetId)));
  const expectedTargets = expectedAuditTargets(snapshot);
  const coveredTargets = expectedTargets.filter((target) => eventTargets.has(auditTargetKey(target.type, target.id)));
  const missingTargets = expectedTargets.filter((target) => !eventTargets.has(auditTargetKey(target.type, target.id)));

  return {
    ...rate(coveredTargets.length, expectedTargets.length),
    checkedEvents: auditVerification?.checkedEvents ?? snapshot.auditEvents.length,
    ...(auditVerification ? { chainValid: auditVerification.valid } : {}),
    missingTargets
  };
}

function expectedAuditTargets(snapshot: PatchPilotSnapshot): AuditMissingTarget[] {
  const targets = new Map<string, AuditMissingTarget>();
  const push = (type: AuditEvent["targetType"], id: string | undefined) => {
    if (!id) return;
    const key = auditTargetKey(type, id);
    if (!targets.has(key)) targets.set(key, { type, id });
  };

  snapshot.prds.filter((prd) => prd.status === "approved").forEach((prd) => push("prd", prd.id));
  snapshot.workItems
    .filter((workItem) => !["proposed", "ready"].includes(workItem.status) || (workItem.reworkCount ?? 0) > 0)
    .forEach((workItem) => push("work_item", workItem.id));
  snapshot.agentRuns
    .filter((run) => run.status === "needs_approval" || terminalRunStatuses.has(run.status))
    .forEach((run) => push("agent_run", run.id));
  snapshot.workspaceRuns.forEach((workspaceRun) => push("workspace_run", workspaceRun.id));
  snapshot.testRuns.filter((testRun) => completedTestStatuses.has(testRun.status)).forEach((testRun) => push("test_run", testRun.id));
  snapshot.interfaceContracts
    .filter((contract) => contract.status !== "draft" || contract.registry !== undefined)
    .forEach((contract) => push("interface_contract", contract.id));
  snapshot.pullRequests.forEach((pullRequest) => push("pull_request", pullRequest.id));
  snapshot.reviewRecords.forEach((reviewRecord) => push("review_record", reviewRecord.id));
  snapshot.approvals.forEach((approval) => push("approval", approval.id));
  snapshot.bugs.forEach((bug) => push("bug", bug.id));
  snapshot.acceptances.forEach((decision) => push("acceptance", decision.runId));

  return [...targets.values()];
}

function rate(numerator: number, denominator: number): RateMetric {
  return {
    numerator,
    denominator,
    rate: denominator > 0 ? Math.round((numerator / denominator) * 100) : null
  };
}

function average(values: number[]) {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function runCostUsd(run: Pick<AgentRun, "costActualUsd" | "costEstimateUsd">) {
  return run.costActualUsd ?? run.costEstimateUsd ?? 0;
}

function dateMs(value?: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function earliestByDate<T>(items: T[], getDate: (item: T) => string | undefined): T | undefined {
  return [...items].sort((left, right) => {
    const leftMs = dateMs(getDate(left)) ?? Number.POSITIVE_INFINITY;
    const rightMs = dateMs(getDate(right)) ?? Number.POSITIVE_INFINITY;
    return leftMs - rightMs;
  })[0];
}

function compareTestRunDate(left: TestRun, right: TestRun) {
  const leftMs = dateMs(left.startedAt ?? left.endedAt) ?? Number.POSITIVE_INFINITY;
  const rightMs = dateMs(right.startedAt ?? right.endedAt) ?? Number.POSITIVE_INFINITY;
  return leftMs - rightMs || left.id.localeCompare(right.id);
}

function compareAcceptanceDate(left: AcceptanceDecision, right: AcceptanceDecision) {
  const leftMs = dateMs(left.decidedAt) ?? Number.NEGATIVE_INFINITY;
  const rightMs = dateMs(right.decidedAt) ?? Number.NEGATIVE_INFINITY;
  return leftMs - rightMs || left.runId.localeCompare(right.runId);
}

function auditTargetKey(type: AuditEvent["targetType"], id: string) {
  return `${type}:${id}`;
}
