import { createHash } from "node:crypto";
import { createInterfaceContracts } from "@patchpilot/contracts";
import {
  createGrillMeQuestion,
  createPrd,
  createTestCasesForWorkItems,
  makeSimpleSummary,
  type AgentRole,
  type ClarificationQuestion,
  type IntakeArtifactReference,
  type Prd,
  type Requirement,
  type WorkItem
} from "@patchpilot/domain";
import type {
  DraftRequirementPrdActivityInput,
  DraftRequirementPrdActivityResult,
  PlanWorkItemsActivityInput,
  PlanWorkItemsActivityResult,
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

export interface WorkItemPlanningActivityStore {
  planWorkItems(input: PlanWorkItemsActivityInput): Promise<PlanWorkItemsActivityResult>;
}

export class InMemoryWorkItemPlanningActivityStore implements WorkItemPlanningActivityStore {
  readonly planned = new Map<string, PlanWorkItemsActivityResult>();
  readonly plansByPrdId = new Map<string, PlanWorkItemsActivityResult>();

  async planWorkItems(input: PlanWorkItemsActivityInput): Promise<PlanWorkItemsActivityResult> {
    const existing = this.planned.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const existingForPrd = this.plansByPrdId.get(input.prd.id);
    if (existingForPrd) {
      this.planned.set(input.idempotencyKey, clone(existingForPrd));
      return clone(existingForPrd);
    }

    const now = new Date().toISOString();
    const workItems = createVerticalWorkItems(input.prd, input.maxWorkItems, now);
    const result: PlanWorkItemsActivityResult = {
      prdId: input.prd.id,
      workItems,
      testCases: createTestCasesForWorkItems(input.prd, workItems, now),
      interfaceContracts: createInterfaceContracts(input.prd, input.contractStatus ?? "approved", now),
      plannedAt: now
    };

    this.planned.set(input.idempotencyKey, clone(result));
    this.plansByPrdId.set(input.prd.id, clone(result));
    return clone(result);
  }
}

export function createWorkItemPlanningActivities(
  store: WorkItemPlanningActivityStore = new InMemoryWorkItemPlanningActivityStore()
) {
  return {
    planWorkItemsActivity(input: PlanWorkItemsActivityInput) {
      return store.planWorkItems(input);
    }
  };
}

export type WorkItemPlanningActivities = ReturnType<typeof createWorkItemPlanningActivities>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

const verticalPlanningRoles: AgentRole[] = ["backend", "frontend", "test", "ops"];

function createVerticalWorkItems(prd: Prd, maxWorkItems: number | undefined, now: string): WorkItem[] {
  const criteria = normalizeAcceptanceCriteria(prd);
  const workItemCount = resolveWorkItemCount(maxWorkItems, criteria.length);
  const criteriaBuckets = bucketCriteria(criteria, workItemCount);

  return criteriaBuckets.map((acceptanceCriteria, index) => {
    const role = verticalPlanningRoles[index] ?? "backend";
    const primaryCriterion = acceptanceCriteria[0] ?? "PRD scope is implemented and verifiable.";

    return {
      id: stableId("wi", `${prd.id}:vertical:${index}:${acceptanceCriteria.join("|")}`),
      prdId: prd.id,
      title: `垂直切片 ${index + 1}: ${summarizeCriterion(primaryCriterion)}`,
      status: "ready",
      role,
      scope: [
        `交付一个可独立验收的垂直切片，覆盖：${acceptanceCriteria.join("；")}。`,
        "范围包含必要的产品状态、接口使用、用户可见行为、测试证据和交付说明。"
      ].join(" "),
      nonGoals: ["不拆成只改前端或后端的横向任务", "不自动合并到主分支", "不绕过接口契约或测试质量门"],
      acceptanceCriteria,
      testSuggestions: testSuggestionsForVerticalSlice(role, acceptanceCriteria),
      requiredCapabilities: ["repo:read", "repo:write", "test:run", "contract:read"],
      version: 1,
      createdAt: now,
      updatedAt: now
    };
  });
}

function normalizeAcceptanceCriteria(prd: Prd): string[] {
  const criteria = prd.acceptanceCriteria.map((criterion) => criterion.trim()).filter(Boolean);
  if (criteria.length > 0) return criteria;
  return [`${prd.title} 的主要用户可见行为已实现，并留下可审查验证证据。`];
}

function resolveWorkItemCount(maxWorkItems: number | undefined, criteriaCount: number): number {
  const requested = Number.isFinite(maxWorkItems) ? Math.trunc(maxWorkItems as number) : 4;
  const boundedRequest = Math.min(4, Math.max(1, requested));
  return Math.min(boundedRequest, Math.max(1, criteriaCount));
}

function bucketCriteria(criteria: string[], workItemCount: number): string[][] {
  const buckets = Array.from({ length: workItemCount }, () => [] as string[]);
  criteria.forEach((criterion, index) => {
    buckets[index % workItemCount]?.push(criterion);
  });
  return buckets.map((bucket) => (bucket.length > 0 ? bucket : ["PRD scope is implemented and verifiable."]));
}

function summarizeCriterion(criterion: string): string {
  const normalized = criterion.replace(/^[-*\d.\s]+/, "").replace(/\s+/g, " ").trim();
  if (normalized.length <= 48) return normalized;
  return `${normalized.slice(0, 47)}...`;
}

function testSuggestionsForVerticalSlice(role: AgentRole, acceptanceCriteria: string[]): string[] {
  const criterionSummary = summarizeCriterion(acceptanceCriteria[0] ?? "PRD scope is implemented and verifiable.");
  const roleSuggestion: Partial<Record<AgentRole, string>> = {
    backend: "运行相关 domain/API/worker 测试，确认状态写入、幂等性和错误路径。",
    frontend: "运行相关 Web 组件或浏览器 smoke，确认桌面和移动端关键动作可用。",
    test: "新增或更新可复用 TestCase，并证明失败路径会留下可处理证据。",
    ops: "验证本地运行、配置、端口或脚本说明，确保交付路径可重复。"
  };

  return [
    `为验收标准补齐目标测试：${criterionSummary}`,
    roleSuggestion[role] ?? "运行相关目标测试，确认垂直切片可独立验收。",
    "记录测试命令、结果和风险，并将证据追溯到该 WorkItem。"
  ];
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
