import { randomUUID } from "node:crypto";
import {
  createPatchPilotTemporalWorker,
  createTemporalClient,
  InMemoryDefectReproductionActivityStore,
  InMemoryWorkItemExecutionActivityStore,
  queryApprovalProgress,
  queryDefectReproductionProgress,
  queryRetrospectiveProgress,
  queryWorkItemExecutionProgress,
  queryRequirementIntakeProgress,
  queryTemporalCanaryProgress,
  readTemporalConfig,
  signalApprovalApprove,
  signalRequirementClarificationAnswer,
  signalRequirementPrdConfirmation,
  signalTemporalCanary,
  startApprovalWorkflow,
  startDefectReproductionWorkflow,
  startRetrospectiveWorkflow,
  startWorkItemExecutionWorkflow,
  startRequirementIntakeWorkflow,
  startTemporalCanaryWorkflow,
  startWorkItemPlanningWorkflow
} from "../packages/workflows/src/index.ts";

const config = readTemporalConfig();
const canaryIdempotencyKey = `td-204-${randomUUID()}`;
const intakeIdempotencyKey = `td-205-${randomUUID()}`;
const planningIdempotencyKey = `td-206-${randomUUID()}`;
const executionIdempotencyKey = `td-207-${randomUUID()}`;
const approvalIdempotencyKey = `td-208-${randomUUID()}`;
const defectReproductionIdempotencyKey = `td-209-${randomUUID()}`;
const retrospectiveIdempotencyKey = `td-210-${randomUUID()}`;

const workItemExecutionStore = new InMemoryWorkItemExecutionActivityStore();
workItemExecutionStore.failNext("runCodex");
const defectReproductionStore = new InMemoryDefectReproductionActivityStore();
defectReproductionStore.failNext("runDiagnose");

const worker = await createPatchPilotTemporalWorker({
  config,
  workItemExecutionActivityStore: workItemExecutionStore,
  defectReproductionActivityStore: defectReproductionStore
});
const client = await createTemporalClient(config);

await worker.runUntil(async () => {
  const handle = await startTemporalCanaryWorkflow(
    client,
    {
      idempotencyKey: canaryIdempotencyKey,
      label: "TD-204 Temporal SDK acceptance",
      waitForSignal: true
    },
    config
  );

  const waiting = await waitForProgress(handle, "waiting_for_signal");
  assertEqual(waiting.status, "waiting_for_signal", "workflow should wait for signal before activity completion");
  assertEqual(waiting.idempotencyKey, canaryIdempotencyKey, "query should expose the idempotency key");

  await signalTemporalCanary(handle, {
    actor: "td-204-e2e",
    note: "release canary workflow"
  });

  const result = await handle.result();
  assertEqual(result.status, "completed", "workflow should reach terminal state");
  assertEqual(result.idempotencyKey, canaryIdempotencyKey, "activity result should preserve idempotency key");
  assertEqual(result.signal?.actor, "td-204-e2e", "activity should receive signal payload");

  const firstDescription = await handle.describe();
  const duplicateHandle = await startTemporalCanaryWorkflow(
    client,
    {
      idempotencyKey: canaryIdempotencyKey,
      label: "TD-204 Temporal SDK acceptance duplicate",
      waitForSignal: false
    },
    config
  );
  const duplicateDescription = await duplicateHandle.describe();
  assertEqual(
    duplicateDescription.runId,
    firstDescription.runId,
    "duplicate idempotency key should not create a second Temporal run after completion"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: handle.workflowId,
        runId: firstDescription.runId,
        duplicateRunId: duplicateDescription.runId,
        status: result.status,
        idempotencyKey: result.idempotencyKey
      },
      null,
      2
    )
  );

  const intakeHandle = await startRequirementIntakeWorkflow(
    client,
    {
      idempotencyKey: intakeIdempotencyKey,
      rawInput: "Implement requirement intake over Temporal with clarification signals and PRD draft generation.",
      template: "feature"
    },
    config
  );
  const clarifying = await waitForRequirementProgress(intakeHandle, "clarifying");
  assertEqual(clarifying.status, "clarifying", "requirement intake should wait for a clarification answer");
  assertEqual(clarifying.idempotencyKey, intakeIdempotencyKey, "requirement query should expose idempotency key");
  if (!clarifying.currentQuestion) throw new Error("requirement intake query did not expose a current question");

  await signalRequirementClarificationAnswer(intakeHandle, {
    actor: "td-205-e2e",
    answer: "A user can answer the current clarification question and immediately receive a PRD draft."
  });

  const awaitingConfirmation = await waitForRequirementProgress(intakeHandle, "awaiting_confirmation");
  assertEqual(
    awaitingConfirmation.status,
    "awaiting_confirmation",
    "requirement intake should generate a PRD and wait for confirmation"
  );
  if (!awaitingConfirmation.prd) throw new Error("requirement intake did not generate a PRD");
  if (!awaitingConfirmation.prd.bodyMarkdown.includes("immediately receive a PRD draft")) {
    throw new Error("generated PRD did not include the signaled clarification answer");
  }

  await signalRequirementPrdConfirmation(intakeHandle, {
    actor: "td-205-e2e",
    accepted: true,
    note: "PRD draft is ready for the next workflow"
  });
  const intakeResult = await intakeHandle.result();
  assertEqual(intakeResult.status, "completed", "requirement intake should complete after PRD confirmation");
  assertEqual(intakeResult.prd.id, awaitingConfirmation.prd.id, "completed result should keep the generated PRD");

  console.log(
    JSON.stringify(
      {
        workflowId: intakeHandle.workflowId,
        status: intakeResult.status,
        idempotencyKey: intakeResult.idempotencyKey,
        requirementId: intakeResult.requirement.id,
        prdId: intakeResult.prd.id,
        clarificationAnswerCount: intakeResult.clarificationAnswerCount
      },
      null,
      2
    )
  );

  const planningHandle = await startWorkItemPlanningWorkflow(
    client,
    {
      idempotencyKey: planningIdempotencyKey,
      prd: intakeResult.prd,
      maxWorkItems: 4
    },
    config
  );
  const planningResult = await planningHandle.result();
  assertEqual(planningResult.status, "completed", "work item planning result should complete");
  assertEqual(planningResult.prdId, intakeResult.prd.id, "work item planning should expose the source PRD");
  assertBetween(planningResult.workItems.length, 1, 4, "work item planning should create 1-4 work items");
  assertEqual(
    planningResult.testCases.length,
    planningResult.workItems.length,
    "work item planning should create one TestCase per WorkItem"
  );
  assertEqual(planningResult.interfaceContracts.length, 3, "work item planning should create the contract baseline");
  assertEqual(
    new Set(planningResult.workItems.map((item) => item.id)).size,
    planningResult.workItems.length,
    "work item planning should not duplicate WorkItem ids"
  );
  if (!planningResult.workItems.every((item) => item.scope.includes("垂直切片") && item.testSuggestions.length > 0)) {
    throw new Error("planned WorkItems did not include vertical scope and test suggestions");
  }
  if (!planningResult.interfaceContracts.every((contract) => contract.status === "approved")) {
    throw new Error("planned InterfaceContracts were not approved baselines");
  }

  const planningDescription = await planningHandle.describe();
  const duplicatePlanningHandle = await startWorkItemPlanningWorkflow(
    client,
    {
      idempotencyKey: planningIdempotencyKey,
      prd: intakeResult.prd,
      maxWorkItems: 1
    },
    config
  );
  const duplicatePlanningDescription = await duplicatePlanningHandle.describe();
  assertEqual(
    duplicatePlanningDescription.runId,
    planningDescription.runId,
    "duplicate planning idempotency key should not create a second Temporal run"
  );
  const duplicatePlanningResult = await duplicatePlanningHandle.result();
  assertEqual(
    duplicatePlanningResult.workItems.length,
    planningResult.workItems.length,
    "duplicate planning start should not create a different WorkItem plan"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: planningHandle.workflowId,
        runId: planningDescription.runId,
        duplicateRunId: duplicatePlanningDescription.runId,
        status: planningResult.status,
        idempotencyKey: planningResult.idempotencyKey,
        prdId: planningResult.prdId,
        workItemIds: planningResult.workItems.map((item) => item.id),
        testCaseIds: planningResult.testCases.map((testCase) => testCase.id),
        interfaceContractIds: planningResult.interfaceContracts.map((contract) => contract.id)
      },
      null,
      2
    )
  );

  const executionWorkItem = planningResult.workItems[0];
  if (!executionWorkItem) throw new Error("planning did not produce a WorkItem for TD-207 execution");
  const executionHandle = await startWorkItemExecutionWorkflow(
    client,
    {
      idempotencyKey: executionIdempotencyKey,
      prd: intakeResult.prd,
      workItem: executionWorkItem,
      testCases: planningResult.testCases,
      runner: "codex",
      workspaceRoot: ".patchpilot/temporal-e2e",
      baseBranch: "main",
      baseCommit: "base-td207-e2e",
      previewUrl: "http://localhost:3000",
      testCommand: "pnpm --filter @patchpilot/workflows test"
    },
    config
  );
  const executionProgress = await waitForExecutionProgress(executionHandle, "completed");
  assertEqual(executionProgress.status, "completed", "work item execution query should reach completed");
  assertEqual(executionProgress.auditEventCount, 9, "execution query should expose the terminal audit chain count");

  const executionResult = await executionHandle.result();
  assertEqual(executionResult.status, "completed", "work item execution should complete");
  assertEqual(executionResult.workItem.status, "review", "completed WorkItem should wait in review state");
  assertEqual(executionResult.agentRun.status, "succeeded", "completed AgentRun should succeed");
  assertEqual(executionResult.workspaceRun.status, "archived", "completed WorkspaceRun should be archived");
  assertEqual(executionResult.pullRequest.status, "ready_for_review", "execution should create a PR record");
  assertEqual(executionResult.reviewRecord.status, "approved", "execution should create an approved review record");
  assertEqual(executionResult.testRuns.length, 1, "execution should record TestRun evidence");
  assertEqual(executionResult.testRuns[0].status, "passed", "execution TestRun should pass");
  assertEqual(
    executionResult.evidenceChain.auditEventIds.length,
    executionResult.auditEvents.length,
    "terminal evidence chain should include every audit event"
  );
  assertEqual(
    workItemExecutionStore.getAttemptCount("runCodex"),
    2,
    "injected Codex activity failure should be retried by Temporal policy"
  );

  const executionDescription = await executionHandle.describe();
  const duplicateExecutionHandle = await startWorkItemExecutionWorkflow(
    client,
    {
      idempotencyKey: executionIdempotencyKey,
      prd: intakeResult.prd,
      workItem: executionWorkItem,
      testCases: planningResult.testCases,
      runner: "simulated"
    },
    config
  );
  const duplicateExecutionDescription = await duplicateExecutionHandle.describe();
  assertEqual(
    duplicateExecutionDescription.runId,
    executionDescription.runId,
    "duplicate execution idempotency key should not create a second Temporal run"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: executionHandle.workflowId,
        runId: executionDescription.runId,
        duplicateRunId: duplicateExecutionDescription.runId,
        status: executionResult.status,
        idempotencyKey: executionResult.idempotencyKey,
        workItemId: executionResult.workItemId,
        agentRunId: executionResult.agentRun.id,
        workspaceRunId: executionResult.workspaceRun.id,
        testRunIds: executionResult.evidenceChain.testRunIds,
        pullRequestId: executionResult.pullRequest.id,
        reviewRecordId: executionResult.reviewRecord.id,
        auditEventCount: executionResult.auditEvents.length,
        codexActivityAttempts: workItemExecutionStore.getAttemptCount("runCodex")
      },
      null,
      2
    )
  );

  const pausedRun = {
    id: `run_td_208_${randomUUID()}`,
    requirementId: intakeResult.requirement.id,
    prdId: intakeResult.prd.id,
    workItemId: executionWorkItem.id,
    runner: "codex",
    status: "needs_approval",
    currentStep: "developing",
    timeline: executionResult.agentRun.timeline,
    events: executionResult.agentRun.events.slice(0, 3),
    costEstimateUsd: 1.25,
    startedAt: new Date().toISOString()
  };
  const approvalHandle = await startApprovalWorkflow(
    client,
    {
      idempotencyKey: approvalIdempotencyKey,
      kind: "budget_exceeded",
      targetType: "agent_run",
      targetId: pausedRun.id,
      requestedBy: "budget-governor",
      requestedReason: "Temporal approval workflow acceptance gate.",
      riskLevel: "high",
      expiresAt: "2999-01-01T00:00:00.000Z",
      requirementId: pausedRun.requirementId,
      prdId: pausedRun.prdId,
      workItemId: pausedRun.workItemId,
      runId: pausedRun.id,
      pausedRun
    },
    config
  );
  const waitingApproval = await waitForApprovalProgress(approvalHandle, "waiting_for_decision");
  assertEqual(waitingApproval.status, "waiting_for_decision", "approval workflow should wait for a decision signal");
  assertEqual(waitingApproval.approval?.status, "pending", "approval should be pending before signal");
  assertEqual(waitingApproval.run?.status, "needs_approval", "linked run should remain paused before approval");

  await signalApprovalApprove(approvalHandle, {
    decidedBy: "td-208-e2e",
    decisionReason: "Approve the paused run for Temporal acceptance."
  });
  const approvalResult = await approvalHandle.result();
  assertEqual(approvalResult.status, "approved", "approval workflow should complete as approved");
  assertEqual(approvalResult.approval.status, "approved", "approval record should be approved");
  assertEqual(approvalResult.approval.approvedBy, "td-208-e2e", "approval record should keep the approver");
  assertEqual(approvalResult.run?.status, "running", "approval signal should resume the paused run");
  if (!approvalResult.auditEvents.some((event) => event.action === "agent_run.resumed")) {
    throw new Error("approval workflow did not record agent_run.resumed audit evidence");
  }

  const approvalDescription = await approvalHandle.describe();
  const duplicateApprovalHandle = await startApprovalWorkflow(
    client,
    {
      idempotencyKey: approvalIdempotencyKey,
      kind: "budget_exceeded",
      targetType: "agent_run",
      targetId: pausedRun.id,
      requestedBy: "duplicate-requester",
      requestedReason: "Duplicate approval start should reuse the existing workflow.",
      riskLevel: "critical",
      expiresAt: "2999-01-01T00:00:00.000Z",
      pausedRun
    },
    config
  );
  const duplicateApprovalDescription = await duplicateApprovalHandle.describe();
  assertEqual(
    duplicateApprovalDescription.runId,
    approvalDescription.runId,
    "duplicate approval idempotency key should not create a second Temporal run"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: approvalHandle.workflowId,
        runId: approvalDescription.runId,
        duplicateRunId: duplicateApprovalDescription.runId,
        status: approvalResult.status,
        idempotencyKey: approvalResult.idempotencyKey,
        approvalId: approvalResult.approval.id,
        resumedRunId: approvalResult.run?.id,
        resumedRunStatus: approvalResult.run?.status,
        auditEventCount: approvalResult.auditEvents.length
      },
      null,
      2
    )
  );

  const defectBug = {
    id: `bug_td_209_${randomUUID()}`,
    title: "保存按钮没有反馈",
    description: "点击保存后页面没有任何反馈。",
    reproductionSteps: "打开设置页\n修改标题\n点击保存",
    expectedBehavior: "展示保存成功提示。",
    actualBehavior: "页面没有变化。",
    severity: "high",
    status: "reported",
    reporter: "td-209-e2e",
    requirementId: `req_bug_td_209_${randomUUID()}`,
    prdId: `prd_bug_td_209_${randomUUID()}`,
    workItemId: `wi_bug_td_209_${randomUUID()}_bugrepro`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  const defectReproductionWorkItem = {
    id: defectBug.workItemId,
    prdId: defectBug.prdId,
    title: `复现 bug：${defectBug.title}`,
    status: "ready",
    role: "test",
    sourceBugId: defectBug.id,
    scope: "测试 agent 根据复现步骤确认问题存在，记录最小复现和回归测试建议，然后交给开发 agent 修复。",
    nonGoals: ["不自动发布", "不修改无关模块", "不访问生产数据"],
    acceptanceCriteria: [
      "复现步骤被记录并给出确认结果",
      "失败现象、期望行为和实际行为被整理成可执行修复上下文",
      "生成后续开发修复任务"
    ],
    testSuggestions: ["用 bug 复现步骤写回归检查", "记录最小复现路径", "给开发 agent 留下回归测试建议"],
    version: 1,
    createdAt: defectBug.createdAt,
    updatedAt: defectBug.updatedAt
  };
  const defectHandle = await startDefectReproductionWorkflow(
    client,
    {
      idempotencyKey: defectReproductionIdempotencyKey,
      bug: defectBug,
      reproductionWorkItem: defectReproductionWorkItem,
      runner: "codex",
      workspaceRoot: ".patchpilot/temporal-e2e",
      diagnoseCommand: `/diagnose ${defectBug.id}`,
      reproductionExpected: true
    },
    config
  );
  const defectProgress = await waitForDefectReproductionProgress(defectHandle, "completed");
  assertEqual(defectProgress.status, "completed", "defect reproduction query should reach completed");
  assertEqual(defectProgress.auditEventCount, 7, "defect reproduction should expose the terminal audit chain count");
  assertEqual(defectProgress.bug?.status, "reproduced", "defect reproduction should mark the bug reproduced");
  if (!defectProgress.fixWorkItem) throw new Error("defect reproduction did not expose the developer fix WorkItem");

  const defectResult = await defectHandle.result();
  assertEqual(defectResult.status, "completed", "defect reproduction workflow should complete");
  assertEqual(defectResult.bug.status, "reproduced", "defect reproduction result should mark the bug reproduced");
  assertEqual(defectResult.reproductionEvidence.reproduced, true, "defect reproduction should capture reproduced evidence");
  assertEqual(defectResult.reproductionEvidence.diagnosePrompt, "/diagnose", "defect reproduction should be /diagnose driven");
  assertEqual(defectResult.testRun.status, "failed", "pre-fix reproduction TestRun should record the observed failure");
  assertEqual(defectResult.agentRun.status, "succeeded", "reproduction AgentRun should finish successfully");
  assertEqual(defectResult.workspaceRun.status, "archived", "reproduction WorkspaceRun should be archived");
  assertEqual(defectResult.fixWorkItem?.role, "backend", "reproduced bug should create a backend fix WorkItem");
  assertEqual(defectResult.fixWorkItem?.sourceBugId, defectBug.id, "fix WorkItem should stay linked to the bug");
  assertEqual(
    defectResult.evidenceChain.auditEventIds.length,
    defectResult.auditEvents.length,
    "defect evidence chain should include every audit event"
  );
  assertEqual(
    defectReproductionStore.getAttemptCount("runDiagnose"),
    2,
    "injected diagnose activity failure should be retried by Temporal policy"
  );

  const defectDescription = await defectHandle.describe();
  const duplicateDefectHandle = await startDefectReproductionWorkflow(
    client,
    {
      idempotencyKey: defectReproductionIdempotencyKey,
      bug: defectBug,
      reproductionWorkItem: defectReproductionWorkItem,
      runner: "simulated",
      reproductionExpected: false
    },
    config
  );
  const duplicateDefectDescription = await duplicateDefectHandle.describe();
  assertEqual(
    duplicateDefectDescription.runId,
    defectDescription.runId,
    "duplicate defect reproduction idempotency key should not create a second Temporal run"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: defectHandle.workflowId,
        runId: defectDescription.runId,
        duplicateRunId: duplicateDefectDescription.runId,
        status: defectResult.status,
        idempotencyKey: defectResult.idempotencyKey,
        bugId: defectResult.bug.id,
        bugStatus: defectResult.bug.status,
        reproductionWorkItemId: defectResult.reproductionWorkItem.id,
        agentRunId: defectResult.agentRun.id,
        workspaceRunId: defectResult.workspaceRun.id,
        testRunId: defectResult.testRun.id,
        fixWorkItemId: defectResult.fixWorkItem?.id,
        auditEventCount: defectResult.auditEvents.length,
        diagnoseActivityAttempts: defectReproductionStore.getAttemptCount("runDiagnose")
      },
      null,
      2
    )
  );

  const retrospectiveHandle = await startRetrospectiveWorkflow(
    client,
    {
      idempotencyKey: retrospectiveIdempotencyKey,
      prd: intakeResult.prd,
      workItems: [executionResult.workItem],
      agentRuns: [executionResult.agentRun],
      workspaceRuns: [executionResult.workspaceRun],
      testRuns: executionResult.testRuns,
      pullRequests: [executionResult.pullRequest],
      reviewRecords: [executionResult.reviewRecord],
      auditEvents: executionResult.auditEvents,
      artifacts: executionResult.artifacts,
      acceptances: [
        {
          runId: executionResult.agentRun.id,
          status: "accepted",
          decidedAt: new Date().toISOString()
        }
      ]
    },
    config
  );
  const retrospectiveProgress = await waitForRetrospectiveProgress(retrospectiveHandle, "completed");
  assertEqual(retrospectiveProgress.status, "completed", "retrospective query should reach completed");
  assertEqual(retrospectiveProgress.artifact?.kind, "retrospective", "retrospective query should expose artifact");
  assertEqual(retrospectiveProgress.summary?.acceptance.terminal, true, "retrospective should summarize terminal acceptance");

  const retrospectiveResult = await retrospectiveHandle.result();
  assertEqual(retrospectiveResult.status, "completed", "retrospective workflow should complete");
  assertEqual(retrospectiveResult.artifact.kind, "retrospective", "retrospective workflow should create retrospective artifact");
  assertEqual(retrospectiveResult.artifact.prdId, intakeResult.prd.id, "retrospective artifact should be scoped to the PRD");
  assertEqual(retrospectiveResult.summary.cost.actualUsd, executionResult.agentRun.costActualUsd, "retrospective should summarize actual cost");
  assertEqual(retrospectiveResult.summary.tests.passRate, 100, "retrospective should summarize passing tests");
  assertEqual(retrospectiveResult.summary.risk.highestRisk, executionResult.agentRun.result.riskLevel, "retrospective should summarize risk");
  assertEqual(retrospectiveResult.summary.audit.eventCount, executionResult.auditEvents.length, "retrospective should summarize audit events");
  assertEqual(retrospectiveResult.summary.audit.chainValid, true, "retrospective should validate the provided audit chain order");
  assertEqual(retrospectiveResult.summary.acceptance.terminal, true, "retrospective should record terminal PRD acceptance");

  const retrospectiveDescription = await retrospectiveHandle.describe();
  const duplicateRetrospectiveHandle = await startRetrospectiveWorkflow(
    client,
    {
      idempotencyKey: retrospectiveIdempotencyKey,
      prd: intakeResult.prd,
      workItems: [],
      agentRuns: [],
      testRuns: [],
      auditEvents: []
    },
    config
  );
  const duplicateRetrospectiveDescription = await duplicateRetrospectiveHandle.describe();
  assertEqual(
    duplicateRetrospectiveDescription.runId,
    retrospectiveDescription.runId,
    "duplicate retrospective idempotency key should not create a second Temporal run"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: retrospectiveHandle.workflowId,
        runId: retrospectiveDescription.runId,
        duplicateRunId: duplicateRetrospectiveDescription.runId,
        status: retrospectiveResult.status,
        idempotencyKey: retrospectiveResult.idempotencyKey,
        prdId: retrospectiveResult.prdId,
        artifactId: retrospectiveResult.artifact.id,
        artifactKind: retrospectiveResult.artifact.kind,
        actualCostUsd: retrospectiveResult.summary.cost.actualUsd,
        testPassRate: retrospectiveResult.summary.tests.passRate,
        highestRisk: retrospectiveResult.summary.risk.highestRisk,
        auditEventCount: retrospectiveResult.summary.audit.eventCount,
        auditChainValid: retrospectiveResult.summary.audit.chainValid,
        acceptanceTerminal: retrospectiveResult.summary.acceptance.terminal
      },
      null,
      2
    )
  );
});

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertBetween(actual, minimum, maximum, message) {
  if (actual < minimum || actual > maximum) {
    throw new Error(`${message}: expected ${actual} to be between ${minimum} and ${maximum}`);
  }
}

async function waitForProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryTemporalCanaryProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`workflow did not reach query status ${expectedStatus}`);
}

async function waitForRequirementProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryRequirementIntakeProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`requirement intake workflow did not reach query status ${expectedStatus}`);
}

async function waitForExecutionProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryWorkItemExecutionProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`work item execution workflow did not reach query status ${expectedStatus}`);
}

async function waitForApprovalProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryApprovalProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`approval workflow did not reach query status ${expectedStatus}`);
}

async function waitForDefectReproductionProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryDefectReproductionProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`defect reproduction workflow did not reach query status ${expectedStatus}`);
}

async function waitForRetrospectiveProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryRetrospectiveProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`retrospective workflow did not reach query status ${expectedStatus}`);
}
