import { condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type {
  RequirementIntakeActivities,
  TemporalCanaryActivities,
  WorkItemExecutionActivities,
  WorkItemPlanningActivities
} from "./activities";
import type {
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
  requirementIntakeActivityOptions,
  temporalCanaryActivityOptions,
  workItemExecutionActivityOptions,
  workItemPlanningActivityOptions
} from "./policies";

export const approveTemporalCanarySignal = defineSignal<[TemporalCanarySignalInput]>("approveTemporalCanary");
export const temporalCanaryProgressQuery = defineQuery<TemporalCanaryProgress>("temporalCanaryProgress");
export const answerRequirementClarificationSignal = defineSignal<[RequirementClarificationAnswerSignalInput]>(
  "answerRequirementClarification"
);
export const confirmRequirementPrdSignal = defineSignal<[RequirementPrdConfirmationSignalInput]>(
  "confirmRequirementPrd"
);
export const requirementIntakeProgressQuery = defineQuery<RequirementIntakeProgress>("requirementIntakeProgress");
export const workItemPlanningProgressQuery = defineQuery<WorkItemPlanningProgress>("workItemPlanningProgress");
export const workItemExecutionProgressQuery = defineQuery<WorkItemExecutionProgress>("workItemExecutionProgress");

const activities = proxyActivities<TemporalCanaryActivities>(temporalCanaryActivityOptions);
const requirementActivities = proxyActivities<RequirementIntakeActivities>(requirementIntakeActivityOptions);
const workItemPlanningActivities = proxyActivities<WorkItemPlanningActivities>(workItemPlanningActivityOptions);
const workItemExecutionActivities = proxyActivities<WorkItemExecutionActivities>(workItemExecutionActivityOptions);

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
