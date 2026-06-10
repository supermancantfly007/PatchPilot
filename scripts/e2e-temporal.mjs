import { randomUUID } from "node:crypto";
import {
  createPatchPilotTemporalWorker,
  createTemporalClient,
  InMemoryWorkItemExecutionActivityStore,
  queryApprovalProgress,
  queryWorkItemExecutionProgress,
  queryRequirementIntakeProgress,
  queryTemporalCanaryProgress,
  readTemporalConfig,
  signalApprovalApprove,
  signalRequirementClarificationAnswer,
  signalRequirementPrdConfirmation,
  signalTemporalCanary,
  startApprovalWorkflow,
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

const workItemExecutionStore = new InMemoryWorkItemExecutionActivityStore();
workItemExecutionStore.failNext("runCodex");

const worker = await createPatchPilotTemporalWorker({ config, workItemExecutionActivityStore: workItemExecutionStore });
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
