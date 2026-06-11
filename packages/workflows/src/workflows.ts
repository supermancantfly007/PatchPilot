import { condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type {
  ApprovalActivities,
  DefectReproductionActivities,
  RequirementIntakeActivities,
  TemporalCanaryActivities,
  WorkItemExecutionActivities,
  WorkItemPlanningActivities
} from "./activities";
import type {
  ApprovalSignalInput,
  ApprovalWorkflowDecision,
  ApprovalWorkflowInput,
  ApprovalWorkflowProgress,
  ApprovalWorkflowResult,
  DefectReproductionProgress,
  DefectReproductionWorkflowInput,
  DefectReproductionWorkflowResult,
  DraftRequirementPrdActivityResult,
  PlanWorkItemsActivityResult,
  RequirementClarificationAnswerSignalInput,
  RequirementIntakeProgress,
  RequirementIntakeWorkflowInput,
  RequirementIntakeWorkflowResult,
  RequirementPrdConfirmationSignalInput,
  RecordRequirementClarificationAnswerActivityResult,
  TemporalCanaryProgress,
  TemporalCanarySignalInput,
  TemporalCanaryWorkflowInput,
  TemporalCanaryWorkflowResult,
  WorkItemExecutionProgress,
  WorkItemExecutionWorkflowInput,
  WorkItemExecutionWorkflowResult,
  WorkItemPlanningProgress,
  WorkItemPlanningWorkflowInput,
  WorkItemPlanningWorkflowResult
} from "./types";
import {
  approvalActivityOptions,
  defectReproductionActivityOptions,
  requirementIntakeActivityOptions,
  temporalCanaryActivityOptions,
  workItemExecutionActivityOptions,
  workItemPlanningActivityOptions
} from "./policies";

export const approveTemporalCanarySignal = defineSignal<[TemporalCanarySignalInput]>("approveTemporalCanary");
export const temporalCanaryProgressQuery = defineQuery<TemporalCanaryProgress>("temporalCanaryProgress");
export const approveApprovalSignal = defineSignal<[ApprovalSignalInput]>("approveApproval");
export const denyApprovalSignal = defineSignal<[ApprovalSignalInput]>("denyApproval");
export const expireApprovalSignal = defineSignal<[ApprovalSignalInput]>("expireApproval");
export const approvalProgressQuery = defineQuery<ApprovalWorkflowProgress>("approvalProgress");
export const answerRequirementClarificationSignal = defineSignal<[RequirementClarificationAnswerSignalInput]>(
  "answerRequirementClarification"
);
export const confirmRequirementPrdSignal = defineSignal<[RequirementPrdConfirmationSignalInput]>(
  "confirmRequirementPrd"
);
export const requirementIntakeProgressQuery = defineQuery<RequirementIntakeProgress>("requirementIntakeProgress");
export const workItemPlanningProgressQuery = defineQuery<WorkItemPlanningProgress>("workItemPlanningProgress");
export const workItemExecutionProgressQuery = defineQuery<WorkItemExecutionProgress>("workItemExecutionProgress");
export const defectReproductionProgressQuery = defineQuery<DefectReproductionProgress>("defectReproductionProgress");

const activities = proxyActivities<TemporalCanaryActivities>(temporalCanaryActivityOptions);
const approvalActivities = proxyActivities<ApprovalActivities>(approvalActivityOptions);
const requirementActivities = proxyActivities<RequirementIntakeActivities>(requirementIntakeActivityOptions);
const workItemPlanningActivities = proxyActivities<WorkItemPlanningActivities>(workItemPlanningActivityOptions);
const workItemExecutionActivities = proxyActivities<WorkItemExecutionActivities>(workItemExecutionActivityOptions);
const defectReproductionActivities = proxyActivities<DefectReproductionActivities>(defectReproductionActivityOptions);

export async function temporalCanaryWorkflow(
  input: TemporalCanaryWorkflowInput
): Promise<TemporalCanaryWorkflowResult> {
  let signal: TemporalCanarySignalInput | undefined;
  let status: TemporalCanaryProgress["status"] = input.waitForSignal ? "waiting_for_signal" : "signaled";
  const workflowId = workflowInfo().workflowId;

  setHandler(approveTemporalCanarySignal, (payload) => {
    signal = payload;
    status = "signaled";
  });

  setHandler(temporalCanaryProgressQuery, () => ({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    label: input.label,
    status,
    ...(signal ? { signal } : {})
  }));

  if (input.waitForSignal) {
    await condition(() => signal !== undefined);
  }

  const result = await activities.completeCanaryActivity({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    label: input.label,
    ...(signal ? { signal } : {})
  });
  status = "completed";

  return {
    ...result,
    status
  };
}

export async function approvalWorkflow(input: ApprovalWorkflowInput): Promise<ApprovalWorkflowResult> {
  const workflowId = workflowInfo().workflowId;
  let status: ApprovalWorkflowProgress["status"] = "requesting";
  let approval: ApprovalWorkflowProgress["approval"];
  let run: ApprovalWorkflowProgress["run"] = input.pausedRun;
  let decision: ApprovalWorkflowDecision | undefined;
  let auditEvents: ApprovalWorkflowResult["auditEvents"] = [];

  const recordDecision = (nextDecision: ApprovalWorkflowDecision) => {
    if (decision) return;
    decision = nextDecision;
    status = "recording_decision";
  };

  setHandler(approveApprovalSignal, (payload) => {
    recordDecision({ ...payload, status: "approved" });
  });

  setHandler(denyApprovalSignal, (payload) => {
    recordDecision({ ...payload, status: "denied" });
  });

  setHandler(expireApprovalSignal, (payload) => {
    recordDecision({ ...payload, status: "expired" });
  });

  setHandler(approvalProgressQuery, () => ({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    status,
    auditEventCount: auditEvents.length,
    ...(approval ? { approval } : {}),
    ...(run ? { run } : {}),
    ...(decision ? { decision } : {})
  }));

  const requested = await approvalActivities.requestApprovalActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:request:${input.targetType}:${input.targetId}`,
    kind: input.kind,
    targetType: input.targetType,
    targetId: input.targetId,
    requestedBy: input.requestedBy,
    requestedReason: input.requestedReason,
    riskLevel: input.riskLevel,
    expiresAt: input.expiresAt,
    ...(input.requirementId ? { requirementId: input.requirementId } : {}),
    ...(input.prdId ? { prdId: input.prdId } : {}),
    ...(input.workItemId ? { workItemId: input.workItemId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.pausedRun ? { pausedRun: input.pausedRun } : {})
  });
  approval = requested.approval;
  run = requested.run;
  auditEvents = requested.auditEvents;

  if (approval.status !== "pending") {
    status = approval.status;
    return {
      workflowId,
      idempotencyKey: input.idempotencyKey,
      status,
      approval,
      ...(run ? { run } : {}),
      auditEvents,
      auditEventCount: auditEvents.length,
      completedAt: approval.decidedAt ?? approval.updatedAt
    };
  }

  if (!decision) status = "waiting_for_decision";
  await condition(() => decision !== undefined);
  if (!decision) throw new Error("Approval workflow decision signal was not received");

  status = "recording_decision";
  const recorded = await approvalActivities.recordApprovalDecisionActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:decision:${approval.id}:${decision.status}`,
    approval,
    decision,
    ...(run ? { pausedRun: run } : {})
  });
  approval = recorded.approval;
  run = recorded.run;
  auditEvents = [...auditEvents, ...recorded.auditEvents];
  const terminalStatus = recorded.approval.status;
  if (terminalStatus === "pending") throw new Error("Approval workflow decision activity returned pending status");
  status = terminalStatus;

  return {
    workflowId,
    idempotencyKey: input.idempotencyKey,
    status: terminalStatus,
    approval,
    ...(run ? { run } : {}),
    decision,
    auditEvents,
    auditEventCount: auditEvents.length,
    completedAt: recorded.completedAt
  };
}

export async function requirementIntakeWorkflow(
  input: RequirementIntakeWorkflowInput
): Promise<RequirementIntakeWorkflowResult> {
  const workflowId = workflowInfo().workflowId;
  const maxClarificationTurns = Math.max(1, input.maxClarificationTurns ?? 3);
  const answers: RequirementClarificationAnswerSignalInput[] = [];
  let confirmation: RequirementPrdConfirmationSignalInput | undefined;
  let status: RequirementIntakeProgress["status"] = "intaking";
  let clarificationAnswerCount = 0;
  let requirement: RequirementIntakeProgress["requirement"];
  let currentQuestion: RequirementIntakeProgress["currentQuestion"];
  let prd: RequirementIntakeProgress["prd"];

  setHandler(answerRequirementClarificationSignal, (payload) => {
    answers.push(payload);
  });

  setHandler(confirmRequirementPrdSignal, (payload) => {
    confirmation = payload;
  });

  setHandler(requirementIntakeProgressQuery, () => ({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    status,
    clarificationAnswerCount,
    ...(requirement ? { requirement } : {}),
    ...(currentQuestion ? { currentQuestion } : {}),
    ...(prd ? { prd } : {}),
    ...(confirmation ? { confirmation } : {})
  }));

  const intake = await requirementActivities.startRequirementIntakeActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:requirement`,
    rawInput: input.rawInput,
    template: input.template,
    ...(input.artifactReferences ? { artifactReferences: input.artifactReferences } : {}),
    ...(input.requirementId ? { requirementId: input.requirementId } : {})
  });
  requirement = intake.requirement;
  currentQuestion = intake.currentQuestion;
  status = "clarifying";

  while (!prd) {
    await condition(() => answers.length > 0);
    const answer = answers.shift();
    if (!answer || !requirement) continue;

    const answerNumber = clarificationAnswerCount + 1;
    const shouldDraftPrd = !answer.continueClarification || answerNumber >= maxClarificationTurns;
    status = "recording_clarification";
    const recorded: RecordRequirementClarificationAnswerActivityResult =
      await requirementActivities.recordRequirementClarificationAnswerActivity({
        workflowId,
        idempotencyKey: `${input.idempotencyKey}:clarification:${answerNumber}`,
        requirementId: requirement.id,
        ...(currentQuestion ? { questionId: currentQuestion.id } : {}),
        answer,
        shouldDraftPrd
      });
    requirement = recorded.requirement;
    currentQuestion = recorded.nextQuestion;
    clarificationAnswerCount = recorded.clarificationAnswerCount;

    if (!recorded.readyForPrd) {
      status = "clarifying";
      continue;
    }

    status = "drafting_prd";
    const draft: DraftRequirementPrdActivityResult = await requirementActivities.draftRequirementPrdActivity({
      workflowId,
      idempotencyKey: `${input.idempotencyKey}:prd`,
      requirementId: recorded.requirement.id
    });
    requirement = draft.requirement;
    prd = draft.prd;
    currentQuestion = undefined;
    status = "awaiting_confirmation";
  }

  if (!requirement || !prd) throw new Error("Requirement intake workflow did not produce a PRD");
  await condition(() => confirmation !== undefined);
  if (!confirmation) throw new Error("Requirement intake confirmation signal was not received");
  status = "recording_confirmation";
  const confirmed = await requirementActivities.recordRequirementPrdConfirmationActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:confirmation`,
    requirementId: requirement.id,
    prdId: prd.id,
    confirmation
  });
  status = "completed";

  return {
    workflowId,
    idempotencyKey: input.idempotencyKey,
    status: "completed",
    clarificationAnswerCount,
    requirement,
    prd,
    confirmation: confirmed.confirmation,
    completedAt: confirmed.confirmedAt
  };
}

export async function workItemPlanningWorkflow(
  input: WorkItemPlanningWorkflowInput
): Promise<WorkItemPlanningWorkflowResult> {
  const workflowId = workflowInfo().workflowId;
  let status: WorkItemPlanningProgress["status"] = "planning";
  const planningState: { plan?: PlanWorkItemsActivityResult } = {};

  setHandler(workItemPlanningProgressQuery, () => ({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    prdId: input.prd.id,
    status,
    ...(planningState.plan
      ? {
          workItems: planningState.plan.workItems,
          testCases: planningState.plan.testCases,
          interfaceContracts: planningState.plan.interfaceContracts
        }
      : {})
  }));

  const plan = await workItemPlanningActivities.planWorkItemsActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:plan:${input.prd.id}`,
    prd: input.prd,
    ...(input.maxWorkItems !== undefined ? { maxWorkItems: input.maxWorkItems } : {}),
    ...(input.contractStatus ? { contractStatus: input.contractStatus } : {})
  });
  planningState.plan = plan;
  status = "completed";

  return {
    workflowId,
    idempotencyKey: input.idempotencyKey,
    prdId: input.prd.id,
    status,
    workItems: plan.workItems,
    testCases: plan.testCases,
    interfaceContracts: plan.interfaceContracts,
    completedAt: plan.plannedAt
  };
}

export async function workItemExecutionWorkflow(
  input: WorkItemExecutionWorkflowInput
): Promise<WorkItemExecutionWorkflowResult> {
  const workflowId = workflowInfo().workflowId;
  let status: WorkItemExecutionProgress["status"] = "claiming";
  let auditEventCount = 0;
  let agentId: string | undefined = input.agentId;
  let agentRun: WorkItemExecutionProgress["agentRun"];
  let workspaceRun: WorkItemExecutionProgress["workspaceRun"];
  let testRuns: WorkItemExecutionProgress["testRuns"];
  let pullRequest: WorkItemExecutionProgress["pullRequest"];
  let reviewRecord: WorkItemExecutionProgress["reviewRecord"];
  const executionState: { evidenceChain?: WorkItemExecutionProgress["evidenceChain"] } = {};

  setHandler(workItemExecutionProgressQuery, () => ({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    prdId: input.prd.id,
    workItemId: input.workItem.id,
    status,
    auditEventCount,
    ...(agentId ? { agentId } : {}),
    ...(agentRun ? { agentRun } : {}),
    ...(workspaceRun ? { workspaceRun } : {}),
    ...(testRuns ? { testRuns } : {}),
    ...(pullRequest ? { pullRequest } : {}),
    ...(reviewRecord ? { reviewRecord } : {}),
    ...(executionState.evidenceChain ? { evidenceChain: executionState.evidenceChain } : {})
  }));

  const claim = await workItemExecutionActivities.claimWorkItemExecutionActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:claim:${input.workItem.id}`,
    workItem: input.workItem,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.leaseDurationMs !== undefined ? { leaseDurationMs: input.leaseDurationMs } : {})
  });
  agentId = claim.agentId;
  auditEventCount += claim.auditEvents.length;
  status = "preparing_workspace";

  const prepared = await workItemExecutionActivities.prepareWorkItemWorkspaceActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:workspace:${input.workItem.id}`,
    prd: input.prd,
    workItem: claim.workItem,
    agentId: claim.agentId,
    claimToken: claim.claimToken,
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {})
  });
  agentRun = prepared.agentRun;
  workspaceRun = prepared.workspaceRun;
  auditEventCount += prepared.auditEvents.length;
  status = "running_codex";

  const codex = await workItemExecutionActivities.runWorkItemCodexActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:codex:${input.workItem.id}`,
    prd: input.prd,
    workItem: prepared.workItem,
    agentRun: prepared.agentRun,
    workspaceRun: prepared.workspaceRun,
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    ...(input.previewUrl ? { previewUrl: input.previewUrl } : {})
  });
  agentRun = codex.agentRun;
  auditEventCount += codex.auditEvents.length;
  status = "running_tests";

  const tested = await workItemExecutionActivities.runWorkItemTestsActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:tests:${input.workItem.id}`,
    prd: input.prd,
    workItem: prepared.workItem,
    agentRun: codex.agentRun,
    workspaceRun: prepared.workspaceRun,
    codex: codex.codex,
    ...(input.testCases ? { testCases: input.testCases } : {}),
    ...(input.testCommand ? { testCommand: input.testCommand } : {})
  });
  agentRun = tested.agentRun;
  testRuns = tested.testRuns;
  auditEventCount += tested.auditEvents.length;
  status = "creating_pull_request";

  const pr = await workItemExecutionActivities.createWorkItemPullRequestActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:pull-request:${input.workItem.id}`,
    workItem: prepared.workItem,
    agentRun: tested.agentRun,
    codex: codex.codex,
    testRuns: tested.testRuns
  });
  pullRequest = pr.pullRequest;
  auditEventCount += pr.auditEvents.length;
  status = "reviewing";

  const review = await workItemExecutionActivities.reviewWorkItemExecutionActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:review:${input.workItem.id}`,
    workItem: prepared.workItem,
    agentRun: tested.agentRun,
    codex: codex.codex,
    testRuns: tested.testRuns,
    pullRequest: pr.pullRequest
  });
  reviewRecord = review.reviewRecord;
  auditEventCount += review.auditEvents.length;
  status = "archiving";

  const archived = await workItemExecutionActivities.archiveWorkItemWorkspaceActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:archive:${input.workItem.id}`,
    workspaceRun: prepared.workspaceRun,
    agentRun: tested.agentRun
  });
  workspaceRun = archived.workspaceRun;
  auditEventCount += archived.auditEvents.length;
  status = "recording_terminal_state";

  const completed = await workItemExecutionActivities.completeWorkItemExecutionActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:terminal:${input.workItem.id}`,
    workItem: prepared.workItem,
    agentRun: tested.agentRun,
    workspaceRun: archived.workspaceRun,
    codex: codex.codex,
    testRuns: tested.testRuns,
    testCases: tested.testCases,
    artifacts: tested.artifacts,
    pullRequest: pr.pullRequest,
    reviewRecord: review.reviewRecord
  });
  agentRun = completed.agentRun;
  workspaceRun = completed.workspaceRun;
  testRuns = completed.testRuns;
  pullRequest = completed.pullRequest;
  reviewRecord = completed.reviewRecord;
  executionState.evidenceChain = completed.evidenceChain;
  auditEventCount = completed.auditEvents.length;
  status = "completed";

  return {
    workflowId,
    idempotencyKey: input.idempotencyKey,
    prdId: input.prd.id,
    workItemId: input.workItem.id,
    status,
    agentId: claim.agentId,
    workItem: completed.workItem,
    agentRun: completed.agentRun,
    workspaceRun: completed.workspaceRun,
    testRuns: completed.testRuns,
    testCases: completed.testCases,
    pullRequest: completed.pullRequest,
    reviewRecord: completed.reviewRecord,
    artifacts: completed.artifacts,
    auditEvents: completed.auditEvents,
    evidenceChain: completed.evidenceChain,
    auditEventCount,
    completedAt: completed.completedAt
  };
}

export async function defectReproductionWorkflow(
  input: DefectReproductionWorkflowInput
): Promise<DefectReproductionWorkflowResult> {
  const workflowId = workflowInfo().workflowId;
  let status: DefectReproductionProgress["status"] = "claiming";
  let auditEventCount = 0;
  let bug: DefectReproductionProgress["bug"] = input.bug;
  let reproductionWorkItem: DefectReproductionProgress["reproductionWorkItem"] = input.reproductionWorkItem;
  let agentRun: DefectReproductionProgress["agentRun"];
  let workspaceRun: DefectReproductionProgress["workspaceRun"];
  let testRun: DefectReproductionProgress["testRun"];
  let reproductionEvidence: DefectReproductionProgress["reproductionEvidence"];
  const defectState: {
    fixWorkItem?: DefectReproductionProgress["fixWorkItem"];
    evidenceChain?: DefectReproductionProgress["evidenceChain"];
  } = {};

  setHandler(defectReproductionProgressQuery, () => ({
    workflowId,
    idempotencyKey: input.idempotencyKey,
    bugId: input.bug.id,
    reproductionWorkItemId: input.reproductionWorkItem.id,
    status,
    auditEventCount,
    ...(bug ? { bug } : {}),
    ...(reproductionWorkItem ? { reproductionWorkItem } : {}),
    ...(agentRun ? { agentRun } : {}),
    ...(workspaceRun ? { workspaceRun } : {}),
    ...(testRun ? { testRun } : {}),
    ...(reproductionEvidence ? { reproductionEvidence } : {}),
    ...(defectState.fixWorkItem ? { fixWorkItem: defectState.fixWorkItem } : {}),
    ...(defectState.evidenceChain ? { evidenceChain: defectState.evidenceChain } : {})
  }));

  const claim = await defectReproductionActivities.claimDefectReproductionActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:claim:${input.bug.id}:${input.reproductionWorkItem.id}`,
    bug: input.bug,
    workItem: input.reproductionWorkItem,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    ...(input.leaseDurationMs !== undefined ? { leaseDurationMs: input.leaseDurationMs } : {})
  });
  bug = claim.bug;
  reproductionWorkItem = claim.workItem;
  auditEventCount += claim.auditEvents.length;
  status = "running_diagnose";

  const diagnosed = await defectReproductionActivities.runDefectDiagnoseActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:diagnose:${input.bug.id}:${input.reproductionWorkItem.id}`,
    bug: claim.bug,
    workItem: claim.workItem,
    agentId: claim.agentId,
    claimToken: claim.claimToken,
    ...(input.reproductionTestCase ? { reproductionTestCase: input.reproductionTestCase } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
    ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
    ...(input.diagnoseCommand ? { diagnoseCommand: input.diagnoseCommand } : {}),
    ...(input.reproductionExpected !== undefined ? { reproductionExpected: input.reproductionExpected } : {})
  });
  agentRun = diagnosed.agentRun;
  workspaceRun = diagnosed.workspaceRun;
  testRun = diagnosed.testRun;
  reproductionEvidence = diagnosed.reproductionEvidence;
  auditEventCount += diagnosed.auditEvents.length;
  status = "recording_reproduction";

  const recorded = await defectReproductionActivities.recordDefectReproductionActivity({
    workflowId,
    idempotencyKey: `${input.idempotencyKey}:record:${input.bug.id}:${input.reproductionWorkItem.id}`,
    bug: claim.bug,
    workItem: claim.workItem,
    agentRun: diagnosed.agentRun,
    workspaceRun: diagnosed.workspaceRun,
    testRun: diagnosed.testRun,
    reproductionTestCase: diagnosed.reproductionTestCase,
    reproductionEvidence: diagnosed.reproductionEvidence,
    artifacts: diagnosed.artifacts
  });
  bug = recorded.bug;
  reproductionWorkItem = recorded.reproductionWorkItem;
  agentRun = recorded.agentRun;
  workspaceRun = recorded.workspaceRun;
  testRun = recorded.testRun;
  reproductionEvidence = recorded.reproductionEvidence;
  defectState.fixWorkItem = recorded.fixWorkItem;
  defectState.evidenceChain = recorded.evidenceChain;
  auditEventCount = recorded.auditEvents.length;
  status = "completed";

  return {
    workflowId,
    idempotencyKey: input.idempotencyKey,
    bugId: input.bug.id,
    reproductionWorkItemId: input.reproductionWorkItem.id,
    status,
    bug: recorded.bug,
    reproductionWorkItem: recorded.reproductionWorkItem,
    agentRun: recorded.agentRun,
    workspaceRun: recorded.workspaceRun,
    testRun: recorded.testRun,
    reproductionTestCase: recorded.reproductionTestCase,
    ...(recorded.regressionTestCase ? { regressionTestCase: recorded.regressionTestCase } : {}),
    ...(recorded.fixWorkItem ? { fixWorkItem: recorded.fixWorkItem } : {}),
    reproductionEvidence: recorded.reproductionEvidence,
    artifacts: recorded.artifacts,
    auditEvents: recorded.auditEvents,
    evidenceChain: recorded.evidenceChain,
    auditEventCount,
    completedAt: recorded.completedAt
  };
}
