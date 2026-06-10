import type {
  AcceptanceQualityGateCheck,
  AcceptanceQualityGateResult,
  AgentRun,
  AuditChainVerification,
  BugStatus,
  PatchPilotSnapshot,
  PullRequestStatus
} from "@patchpilot/domain";

const readyPullRequestStatuses = new Set<PullRequestStatus>(["ready_for_review", "approved", "merged"]);
const resolvedDefectStatuses = new Set<BugStatus>(["closed", "unreproducible"]);

export function evaluateAcceptancePageQualityGate(input: {
  snapshot: PatchPilotSnapshot;
  prdId: string;
  runIds: string[];
  workItemIds: string[];
  scope: AcceptanceQualityGateResult["scope"];
  auditVerification?: AuditChainVerification;
}): AcceptanceQualityGateResult {
  const prd = input.snapshot.prds.find((item) => item.id === input.prdId);
  const runIdSet = new Set(input.runIds);
  const workItemIdSet = new Set(input.workItemIds);
  const scopedTestCases = input.snapshot.testCases.filter(
    (testCase) => testCase.prdId === input.prdId && workItemIdSet.has(testCase.workItemId)
  );
  const testCaseIdSet = new Set(scopedTestCases.map((testCase) => testCase.id));
  const scopedTestRuns = input.snapshot.testRuns.filter(
    (testRun) =>
      (testRun.runId !== undefined && runIdSet.has(testRun.runId)) ||
      (testRun.testCaseId !== undefined && testCaseIdSet.has(testRun.testCaseId) && testRun.runId !== undefined && runIdSet.has(testRun.runId))
  );
  const requiredCriteria = uniqueStrings((prd?.acceptanceCriteria ?? []).map(normalizeGateText).filter(Boolean));
  const coveredCriteria = new Set(
    scopedTestCases.flatMap((testCase) => testCase.linkedAcceptanceCriteria.map(normalizeGateText)).filter(Boolean)
  );
  const coveredCriteriaCount = requiredCriteria.filter((criterion) => coveredCriteria.has(criterion)).length;
  const passedTestCases = scopedTestCases.filter(
    (testCase) => testCase.status === "passed" && testCase.lastRunId !== undefined && runIdSet.has(testCase.lastRunId)
  );
  const flakyTestCaseIds = scopedTestCases.filter((testCase) => testCase.flaky).map((testCase) => testCase.id);
  const flakyTestRunIds = scopedTestRuns.filter((testRun) => testRun.flakySignal).map((testRun) => testRun.id);
  const unresolvedDefects = input.snapshot.bugs.filter((bug) => {
    if (bug.prdId !== input.prdId || resolvedDefectStatuses.has(bug.status)) return false;
    if (input.scope === "prd") return true;
    return (
      (bug.sourceRunId !== undefined && runIdSet.has(bug.sourceRunId)) ||
      (bug.workItemId !== undefined && workItemIdSet.has(bug.workItemId))
    );
  });
  const contracts = input.snapshot.interfaceContracts.filter((contract) => contract.prdId === input.prdId);
  const compatibleContracts = contracts.filter((contract) => contract.status === "approved");
  const pullRequests = input.snapshot.pullRequests.filter((pullRequest) => runIdSet.has(pullRequest.runId));
  const readyPullRequests = pullRequests.filter((pullRequest) => readyPullRequestStatuses.has(pullRequest.status));
  const auditVerification = input.auditVerification ?? {
    valid: false,
    checkedEvents: input.snapshot.auditEvents.length,
    headHash: null,
    errors: ["Audit chain verification has not loaded."]
  };

  const metrics = {
    acceptanceCriteriaTotal: requiredCriteria.length,
    acceptanceCriteriaCovered: coveredCriteriaCount,
    acceptanceCriteriaCoverageRate: ratioPercent(coveredCriteriaCount, requiredCriteria.length),
    testCaseTotal: scopedTestCases.length,
    testCasePassed: passedTestCases.length,
    testCasePassRate: ratioPercent(passedTestCases.length, scopedTestCases.length),
    unresolvedDefectCount: unresolvedDefects.length,
    flakyCount: new Set([...flakyTestCaseIds, ...flakyTestRunIds]).size,
    contractTotal: contracts.length,
    contractCompatible: compatibleContracts.length,
    pullRequestTotal: input.runIds.length,
    pullRequestReady: readyPullRequests.length,
    auditEventCount: auditVerification.checkedEvents
  };

  const checks: AcceptanceQualityGateCheck[] = [
    {
      key: "acceptance_criteria_coverage",
      label: "验收标准覆盖率",
      passed: metrics.acceptanceCriteriaTotal > 0 && metrics.acceptanceCriteriaCovered === metrics.acceptanceCriteriaTotal,
      summary:
        metrics.acceptanceCriteriaTotal > 0
          ? `${metrics.acceptanceCriteriaCovered}/${metrics.acceptanceCriteriaTotal} 条验收标准已被 TestCase 覆盖`
          : "没有可验收的 PRD 验收标准",
      details: requiredCriteria
        .filter((criterion) => !coveredCriteria.has(criterion))
        .map((criterion) => `缺少覆盖：${criterion}`)
    },
    {
      key: "test_case_pass_rate",
      label: "TestCase 通过率",
      passed: metrics.testCaseTotal > 0 && metrics.testCasePassed === metrics.testCaseTotal,
      summary:
        metrics.testCaseTotal > 0
          ? `${metrics.testCasePassRate}% (${metrics.testCasePassed}/${metrics.testCaseTotal}) TestCase 已通过`
          : "没有可追溯的 TestCase 证据",
      details: scopedTestCases
        .filter((testCase) => testCase.status !== "passed" || !testCase.lastRunId || !runIdSet.has(testCase.lastRunId))
        .map((testCase) => `${testCase.title}：${testCase.status}`)
    },
    {
      key: "unresolved_defects",
      label: "未解决缺陷",
      passed: metrics.unresolvedDefectCount === 0,
      summary:
        metrics.unresolvedDefectCount === 0
          ? "没有阻塞验收的未解决 Defect"
          : `${metrics.unresolvedDefectCount} 个 Defect 尚未关闭或标记无法复现`,
      details: unresolvedDefects.map((defect) => `${defect.id}：${defect.title} (${defect.status})`)
    },
    {
      key: "flaky_tests",
      label: "Flaky 信号",
      passed: metrics.flakyCount === 0,
      summary: metrics.flakyCount === 0 ? "没有 TestCase 或 TestRun 标记为 flaky" : `${metrics.flakyCount} 条测试证据存在 flaky 信号`,
      details: [
        ...flakyTestCaseIds.map((id) => `Flaky TestCase：${id}`),
        ...flakyTestRunIds.map((id) => `Flaky TestRun：${id}`)
      ]
    },
    {
      key: "contract_compatibility",
      label: "契约兼容性",
      passed: metrics.contractTotal > 0 && metrics.contractCompatible === metrics.contractTotal,
      summary:
        metrics.contractTotal > 0
          ? `${metrics.contractCompatible}/${metrics.contractTotal} 个 InterfaceContract 已批准且兼容`
          : "没有 InterfaceContract 兼容性证据",
      details: contracts
        .filter((contract) => contract.status !== "approved")
        .map((contract) => `${contract.name}：${contract.status}`)
    },
    {
      key: "pr_status",
      label: "PR 状态",
      passed: input.runIds.length > 0 && readyPullRequests.length === input.runIds.length,
      summary:
        input.runIds.length > 0
          ? `${readyPullRequests.length}/${input.runIds.length} 个 run 有可审查 PR`
          : "没有待验收的 run",
      details: input.runIds.flatMap((runId) => {
        const pullRequest = pullRequests.find((item) => item.runId === runId);
        if (!pullRequest) return [`缺少 PullRequest 记录：${runId}`];
        if (!readyPullRequestStatuses.has(pullRequest.status)) return [`${pullRequest.id}：${pullRequest.status}`];
        return [];
      })
    },
    {
      key: "audit_integrity",
      label: "审计完整性",
      passed: auditVerification.valid && auditVerification.checkedEvents > 0,
      summary: auditVerification.valid
        ? `${auditVerification.checkedEvents} 条 AuditEvent hash chain 完整`
        : `AuditEvent hash chain 校验失败：${auditVerification.errors[0] ?? "未知错误"}`,
      details: auditVerification.errors
    }
  ];

  return {
    scope: input.scope,
    prdId: input.prdId,
    runIds: input.runIds,
    workItemIds: input.workItemIds,
    passed: checks.every((check) => check.passed),
    checks,
    blockingReasons: checks.filter((check) => !check.passed).map((check) => check.summary),
    metrics
  };
}

export function acceptanceGateRunIds(params: {
  isTeamAcceptance: boolean;
  run: Pick<AgentRun, "id" | "workItemId">;
  teamWorkItems: { id: string }[];
  runsByWorkItem: Map<string, Pick<AgentRun, "id" | "workItemId">>;
}) {
  if (!params.isTeamAcceptance) return [params.run.id];
  return params.teamWorkItems.flatMap((item) => {
    const itemRun = params.runsByWorkItem.get(item.id);
    return itemRun ? [itemRun.id] : [];
  });
}

function normalizeGateText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function uniqueStrings(values: string[]) {
  return [...new Set(values)];
}

function ratioPercent(numerator: number, denominator: number) {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}
