import { condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { RequirementIntakeActivities, TemporalCanaryActivities } from "./activities";
import type {
  DraftRequirementPrdActivityResult,
  RequirementClarificationAnswerSignalInput,
  RequirementIntakeProgress,
  RequirementIntakeWorkflowInput,
  RequirementIntakeWorkflowResult,
  RequirementPrdConfirmationSignalInput,
  RecordRequirementClarificationAnswerActivityResult,
  TemporalCanaryProgress,
  TemporalCanarySignalInput,
  TemporalCanaryWorkflowInput,
  TemporalCanaryWorkflowResult
} from "./types";
import { requirementIntakeActivityOptions, temporalCanaryActivityOptions } from "./policies";

export const approveTemporalCanarySignal = defineSignal<[TemporalCanarySignalInput]>("approveTemporalCanary");
export const temporalCanaryProgressQuery = defineQuery<TemporalCanaryProgress>("temporalCanaryProgress");
export const answerRequirementClarificationSignal = defineSignal<[RequirementClarificationAnswerSignalInput]>(
  "answerRequirementClarification"
);
export const confirmRequirementPrdSignal = defineSignal<[RequirementPrdConfirmationSignalInput]>(
  "confirmRequirementPrd"
);
export const requirementIntakeProgressQuery = defineQuery<RequirementIntakeProgress>("requirementIntakeProgress");

const activities = proxyActivities<TemporalCanaryActivities>(temporalCanaryActivityOptions);
const requirementActivities = proxyActivities<RequirementIntakeActivities>(requirementIntakeActivityOptions);

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
