import { createHash } from "node:crypto";
import {
  createGrillMeQuestion,
  createPrd,
  makeSimpleSummary,
  type ClarificationQuestion,
  type IntakeArtifactReference,
  type Prd,
  type Requirement
} from "@patchpilot/domain";
import type {
  DraftRequirementPrdActivityInput,
  DraftRequirementPrdActivityResult,
  RecordRequirementClarificationAnswerActivityInput,
  RecordRequirementClarificationAnswerActivityResult,
  RecordRequirementPrdConfirmationActivityInput,
  RecordRequirementPrdConfirmationActivityResult,
  RequirementIntakeArtifactReferenceInput,
  StartRequirementIntakeActivityInput,
  StartRequirementIntakeActivityResult,
  TemporalCanaryActivityInput,
  TemporalCanaryActivityResult
} from "./types";

export interface TemporalCanaryActivityStore {
  complete(input: TemporalCanaryActivityInput): Promise<TemporalCanaryActivityResult>;
}

export class InMemoryTemporalCanaryActivityStore implements TemporalCanaryActivityStore {
  readonly completed = new Map<string, TemporalCanaryActivityResult>();

  async complete(input: TemporalCanaryActivityInput): Promise<TemporalCanaryActivityResult> {
    const existing = this.completed.get(input.idempotencyKey);
    if (existing) return existing;

    const result: TemporalCanaryActivityResult = {
      workflowId: input.workflowId,
      idempotencyKey: input.idempotencyKey,
      label: input.label,
      ...(input.signal ? { signal: input.signal } : {}),
      completedAt: new Date().toISOString()
    };
    this.completed.set(input.idempotencyKey, result);
    return result;
  }
}

export function createTemporalCanaryActivities(store: TemporalCanaryActivityStore = new InMemoryTemporalCanaryActivityStore()) {
  return {
    completeCanaryActivity(input: TemporalCanaryActivityInput) {
      return store.complete(input);
    }
  };
}

export type TemporalCanaryActivities = ReturnType<typeof createTemporalCanaryActivities>;

export interface RequirementIntakeActivityStore {
  startIntake(input: StartRequirementIntakeActivityInput): Promise<StartRequirementIntakeActivityResult>;
  recordClarificationAnswer(
    input: RecordRequirementClarificationAnswerActivityInput
  ): Promise<RecordRequirementClarificationAnswerActivityResult>;
  draftPrd(input: DraftRequirementPrdActivityInput): Promise<DraftRequirementPrdActivityResult>;
  recordPrdConfirmation(
    input: RecordRequirementPrdConfirmationActivityInput
  ): Promise<RecordRequirementPrdConfirmationActivityResult>;
}

interface RequirementIntakeState {
  requirement: Requirement;
  prd?: Prd;
}

export class InMemoryRequirementIntakeActivityStore implements RequirementIntakeActivityStore {
  readonly requirements = new Map<string, RequirementIntakeState>();
  readonly started = new Map<string, StartRequirementIntakeActivityResult>();
  readonly clarificationAnswers = new Map<string, RecordRequirementClarificationAnswerActivityResult>();
  readonly prdDrafts = new Map<string, DraftRequirementPrdActivityResult>();
  readonly confirmations = new Map<string, RecordRequirementPrdConfirmationActivityResult>();

  async startIntake(input: StartRequirementIntakeActivityInput): Promise<StartRequirementIntakeActivityResult> {
    const existing = this.started.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const now = new Date().toISOString();
    const requirementId = input.requirementId ?? stableId("req", input.idempotencyKey);
    const initialQuestion = createGrillMeQuestion(input.rawInput, input.template, []);
    const requirement: Requirement = {
      id: requirementId,
      title: makeSimpleSummary(input.rawInput, input.template),
      rawInput: input.rawInput,
      template: input.template,
      status: "clarifying",
      simpleSummary: makeSimpleSummary(input.rawInput, input.template),
      artifactReferences: prepareArtifactReferences(input.artifactReferences ?? [], requirementId, now),
      clarificationQuestions: [initialQuestion],
      clarificationTurns: [
        {
          id: stableId("turn", `${input.idempotencyKey}:agent:0`),
          speaker: "agent",
          message: initialQuestion.question,
          recommendedAnswer: initialQuestion.recommendedAnswer,
          createdAt: now
        }
      ],
      createdAt: now,
      updatedAt: now
    };
    const result: StartRequirementIntakeActivityResult = {
      requirement,
      ...(requirement.clarificationQuestions[0] ? { currentQuestion: requirement.clarificationQuestions[0] } : {})
    };

    this.requirements.set(requirementId, { requirement });
    this.started.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async recordClarificationAnswer(
    input: RecordRequirementClarificationAnswerActivityInput
  ): Promise<RecordRequirementClarificationAnswerActivityResult> {
    const existing = this.clarificationAnswers.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const state = this.findState(input.requirementId);
    const now = new Date().toISOString();
    const answer = input.answer.answer.trim() || "未补充更多细节";
    const answeredQuestion = this.answerQuestion(state.requirement, input.questionId, answer);
    if (!answeredQuestion) {
      throw new Error(input.questionId ? `Clarification question not found: ${input.questionId}` : "No unanswered clarification question found");
    }
    state.requirement.clarificationTurns.push({
      id: stableId("turn", `${input.idempotencyKey}:user`),
      speaker: "user",
      message: answer,
      createdAt: now
    });

    let nextQuestion: ClarificationQuestion | undefined;
    if (input.shouldDraftPrd) {
      state.requirement.status = "prd_draft";
    } else {
      nextQuestion = createGrillMeQuestion(
        state.requirement.rawInput,
        state.requirement.template,
        state.requirement.clarificationTurns
      );
      state.requirement.clarificationTurns.push({
        id: stableId("turn", `${input.idempotencyKey}:agent`),
        speaker: "agent",
        message: nextQuestion.question,
        recommendedAnswer: nextQuestion.recommendedAnswer,
        createdAt: now
      });
      state.requirement.clarificationQuestions.push(nextQuestion);
      state.requirement.status = "clarifying";
    }

    state.requirement.updatedAt = now;
    const result: RecordRequirementClarificationAnswerActivityResult = {
      requirement: clone(state.requirement),
      ...(nextQuestion ? { nextQuestion } : {}),
      readyForPrd: input.shouldDraftPrd,
      clarificationAnswerCount: countAnsweredQuestions(state.requirement)
    };

    this.clarificationAnswers.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async draftPrd(input: DraftRequirementPrdActivityInput): Promise<DraftRequirementPrdActivityResult> {
    const existing = this.prdDrafts.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const state = this.findState(input.requirementId);
    const now = new Date().toISOString();
    state.requirement.status = "prd_draft";
    state.requirement.updatedAt = now;
    const prd = createPrd(state.requirement);
    state.prd = prd;
    const result: DraftRequirementPrdActivityResult = {
      requirement: clone(state.requirement),
      prd: clone(prd)
    };
    this.prdDrafts.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async recordPrdConfirmation(
    input: RecordRequirementPrdConfirmationActivityInput
  ): Promise<RecordRequirementPrdConfirmationActivityResult> {
    const existing = this.confirmations.get(input.idempotencyKey);
    if (existing) return clone(existing);

    this.findState(input.requirementId);
    const result: RecordRequirementPrdConfirmationActivityResult = {
      requirementId: input.requirementId,
      prdId: input.prdId,
      confirmation: input.confirmation,
      confirmedAt: new Date().toISOString()
    };
    this.confirmations.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  private findState(requirementId: string): RequirementIntakeState {
    const state = this.requirements.get(requirementId);
    if (!state) throw new Error(`Requirement intake state not found: ${requirementId}`);
    return state;
  }

  private answerQuestion(requirement: Requirement, questionId: string | undefined, answer: string): boolean {
    let answered = false;
    requirement.clarificationQuestions = requirement.clarificationQuestions.map((question) => {
      if (answered) return question;
      if (questionId ? question.id !== questionId : question.answer !== undefined) return question;
      answered = true;
      return { ...question, answer };
    });
    return answered;
  }
}

export function createRequirementIntakeActivities(
  store: RequirementIntakeActivityStore = new InMemoryRequirementIntakeActivityStore()
) {
  return {
    startRequirementIntakeActivity(input: StartRequirementIntakeActivityInput) {
      return store.startIntake(input);
    },
    recordRequirementClarificationAnswerActivity(input: RecordRequirementClarificationAnswerActivityInput) {
      return store.recordClarificationAnswer(input);
    },
    draftRequirementPrdActivity(input: DraftRequirementPrdActivityInput) {
      return store.draftPrd(input);
    },
    recordRequirementPrdConfirmationActivity(input: RecordRequirementPrdConfirmationActivityInput) {
      return store.recordPrdConfirmation(input);
    }
  };
}

export type RequirementIntakeActivities = ReturnType<typeof createRequirementIntakeActivities>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function prepareArtifactReferences(
  references: RequirementIntakeArtifactReferenceInput[],
  requirementId: string,
  now: string
): IntakeArtifactReference[] {
  return references.map((reference, index) => ({
    ...reference,
    id: reference.id ?? stableId("artifact_ref", `${requirementId}:${index}:${reference.label}`),
    createdAt: reference.createdAt ?? now
  }));
}

function countAnsweredQuestions(requirement: Requirement): number {
  return requirement.clarificationQuestions.filter((question) => question.answer !== undefined).length;
}
