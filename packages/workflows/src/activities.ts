import { createHash } from "node:crypto";
import { createInterfaceContracts } from "@patchpilot/contracts";
import {
  advanceTimeline,
  completeTimeline,
  createTimeline,
  createGrillMeQuestion,
  createPrd,
  createTestCasesForWorkItems,
  makeSimpleSummary,
  testCaseStatusFromTestRunStatus,
  type AgentRun,
  type AgentRunResult,
  type AgentRole,
  type ArtifactKind,
  type ArtifactRecord,
  type AuditEvent,
  type ClarificationQuestion,
  type IntakeArtifactReference,
  type Prd,
  type PullRequestRecord,
  type Requirement,
  type ReviewRecord,
  type TestCase,
  type TestRun,
  type WorkspaceRun,
  type WorkItem
} from "@patchpilot/domain";
import type {
  ApprovalWorkflowDecision,
  ArchiveWorkItemWorkspaceActivityInput,
  ArchiveWorkItemWorkspaceActivityResult,
  ClaimWorkItemExecutionActivityInput,
  ClaimWorkItemExecutionActivityResult,
  CompleteWorkItemExecutionActivityInput,
  CompleteWorkItemExecutionActivityResult,
  CreateWorkItemPullRequestActivityInput,
  CreateWorkItemPullRequestActivityResult,
  DraftRequirementPrdActivityInput,
  DraftRequirementPrdActivityResult,
  PlanWorkItemsActivityInput,
  PlanWorkItemsActivityResult,
  PrepareWorkItemWorkspaceActivityInput,
  PrepareWorkItemWorkspaceActivityResult,
  RecordApprovalDecisionActivityInput,
  RecordApprovalDecisionActivityResult,
  RecordRequirementClarificationAnswerActivityInput,
  RecordRequirementClarificationAnswerActivityResult,
  RecordRequirementPrdConfirmationActivityInput,
  RecordRequirementPrdConfirmationActivityResult,
  RequestApprovalActivityInput,
  RequestApprovalActivityResult,
  RequirementIntakeArtifactReferenceInput,
  ReviewWorkItemExecutionActivityInput,
  ReviewWorkItemExecutionActivityResult,
  RunWorkItemCodexActivityInput,
  RunWorkItemCodexActivityResult,
  RunWorkItemTestsActivityInput,
  RunWorkItemTestsActivityResult,
  StartRequirementIntakeActivityInput,
  StartRequirementIntakeActivityResult,
  TemporalCanaryActivityInput,
  TemporalCanaryActivityResult,
  WorkItemExecutionCodexEvidence
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

export interface WorkItemExecutionActivityStore {
  claimWorkItem(input: ClaimWorkItemExecutionActivityInput): Promise<ClaimWorkItemExecutionActivityResult>;
  prepareWorkspace(input: PrepareWorkItemWorkspaceActivityInput): Promise<PrepareWorkItemWorkspaceActivityResult>;
  runCodex(input: RunWorkItemCodexActivityInput): Promise<RunWorkItemCodexActivityResult>;
  runTests(input: RunWorkItemTestsActivityInput): Promise<RunWorkItemTestsActivityResult>;
  createPullRequest(
    input: CreateWorkItemPullRequestActivityInput
  ): Promise<CreateWorkItemPullRequestActivityResult>;
  reviewExecution(input: ReviewWorkItemExecutionActivityInput): Promise<ReviewWorkItemExecutionActivityResult>;
  archiveWorkspace(input: ArchiveWorkItemWorkspaceActivityInput): Promise<ArchiveWorkItemWorkspaceActivityResult>;
  completeExecution(input: CompleteWorkItemExecutionActivityInput): Promise<CompleteWorkItemExecutionActivityResult>;
}

type WorkItemExecutionActivityName =
  | "claim"
  | "prepareWorkspace"
  | "runCodex"
  | "runTests"
  | "createPullRequest"
  | "reviewExecution"
  | "archiveWorkspace"
  | "completeExecution";

interface AuditEventInput {
  workflowId: string;
  actor: string;
  action: string;
  targetType: AuditEvent["targetType"];
  targetId: string;
  message: string;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  beforeJson?: AuditEvent["beforeJson"];
  afterJson?: AuditEvent["afterJson"];
  metadataJson?: AuditEvent["metadataJson"];
  createdAt?: string;
}

export interface ApprovalActivityStore {
  requestApproval(input: RequestApprovalActivityInput): Promise<RequestApprovalActivityResult>;
  recordDecision(input: RecordApprovalDecisionActivityInput): Promise<RecordApprovalDecisionActivityResult>;
}

export class InMemoryApprovalActivityStore implements ApprovalActivityStore {
  readonly requested = new Map<string, RequestApprovalActivityResult>();
  readonly decisions = new Map<string, RecordApprovalDecisionActivityResult>();
  readonly approvalsById = new Map<string, RequestApprovalActivityResult["approval"]>();
  readonly runsById = new Map<string, AgentRun>();
  readonly auditEventsByWorkflowId = new Map<string, AuditEvent[]>();

  async requestApproval(input: RequestApprovalActivityInput): Promise<RequestApprovalActivityResult> {
    const existing = this.requested.get(input.idempotencyKey);
    if (existing) return clone(existing);

    if (input.pausedRun && input.pausedRun.status !== "needs_approval") {
      throw new Error(`AgentRun ${input.pausedRun.id} is not paused for approval`);
    }

    const now = new Date().toISOString();
    const isExpired = this.isExpired(input.expiresAt, now);
    const runId = input.runId ?? input.pausedRun?.id;
    const approval: RequestApprovalActivityResult["approval"] = {
      id: stableId("approval", `${input.workflowId}:${input.kind}:${input.targetType}:${input.targetId}`),
      kind: input.kind,
      status: isExpired ? "expired" : "pending",
      targetType: input.targetType,
      targetId: input.targetId,
      requestedBy: input.requestedBy,
      requestedReason: input.requestedReason,
      riskLevel: input.riskLevel,
      expiresAt: input.expiresAt,
      ...(isExpired
        ? {
            decisionReason: "Approval expired before a decision was recorded.",
            decidedAt: now
          }
        : {}),
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
      ...(input.prdId ? { prdId: input.prdId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(runId ? { runId } : {}),
      createdAt: now,
      updatedAt: now
    };
    const run = input.pausedRun
      ? this.attachApprovalToPausedRun(input.pausedRun, approval.id)
      : undefined;

    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: input.requestedBy,
        action: "approval.requested",
        targetType: "approval",
        targetId: approval.id,
        message: `Approval requested for ${approval.kind}: ${approval.requestedReason}`,
        requirementId: approval.requirementId,
        prdId: approval.prdId,
        workItemId: approval.workItemId,
        runId: approval.runId,
        beforeJson: null,
        afterJson: {
          approval: auditApprovalStateForWorkflow(approval),
          run: run ? { id: run.id, status: run.status, budgetApprovalId: run.budgetApprovalId ?? null } : null
        }
      })
    ];

    if (isExpired) {
      auditEvents.push(
        this.addAuditEvent({
          workflowId: input.workflowId,
          actor: "workflow",
          action: "approval.expired",
          targetType: "approval",
          targetId: approval.id,
          message: "Approval expired before the workflow received an approve or deny signal.",
          requirementId: approval.requirementId,
          prdId: approval.prdId,
          workItemId: approval.workItemId,
          runId: approval.runId,
          beforeJson: { approval: { id: approval.id, status: "pending" } },
          afterJson: { approval: auditApprovalStateForWorkflow(approval) }
        })
      );
    }

    const result: RequestApprovalActivityResult = {
      approval,
      ...(run ? { run } : {}),
      auditEvents
    };
    this.approvalsById.set(approval.id, clone(approval));
    if (run) this.runsById.set(run.id, clone(run));
    this.requested.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async recordDecision(input: RecordApprovalDecisionActivityInput): Promise<RecordApprovalDecisionActivityResult> {
    const existing = this.decisions.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const currentApproval = this.approvalsById.get(input.approval.id) ?? input.approval;
    if (currentApproval.status !== "pending") {
      throw new Error(`Approval ${currentApproval.id} is already ${currentApproval.status}`);
    }

    const now = new Date().toISOString();
    const approval: RequestApprovalActivityResult["approval"] = {
      ...clone(currentApproval),
      status: input.decision.status,
      decisionReason: input.decision.decisionReason,
      decidedAt: now,
      updatedAt: now,
      ...(input.decision.status === "approved" ? { approvedBy: input.decision.decidedBy } : {}),
      ...(input.decision.status === "denied" ? { deniedBy: input.decision.decidedBy } : {})
    };
    const previousRun =
      input.pausedRun ??
      (approval.runId ? this.runsById.get(approval.runId) : undefined) ??
      (approval.targetType === "agent_run" ? this.runsById.get(approval.targetId) : undefined);
    const run = previousRun ? this.applyDecisionToRun(previousRun, approval, input.decision, now) : undefined;
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: input.decision.decidedBy,
        action: approvalAction(input.decision.status),
        targetType: "approval",
        targetId: approval.id,
        message: approvalDecisionMessage(input.decision.status),
        requirementId: approval.requirementId,
        prdId: approval.prdId,
        workItemId: approval.workItemId,
        runId: approval.runId,
        beforeJson: { approval: { id: approval.id, status: "pending" } },
        afterJson: {
          approval: auditApprovalStateForWorkflow(approval),
          run: run ? { id: run.id, status: run.status } : null
        }
      })
    ];

    if (input.decision.status === "approved" && previousRun?.status === "needs_approval" && run) {
      auditEvents.push(
        this.addAuditEvent({
          workflowId: input.workflowId,
          actor: input.decision.decidedBy,
          action: "agent_run.resumed",
          targetType: "agent_run",
          targetId: run.id,
          message: "Approval signal resumed the paused AgentRun.",
          requirementId: run.requirementId,
          prdId: run.prdId,
          workItemId: run.workItemId,
          runId: run.id,
          beforeJson: {
            run: { id: previousRun.id, status: previousRun.status },
            approval: auditApprovalStateForWorkflow(currentApproval)
          },
          afterJson: {
            run: { id: run.id, status: run.status },
            approval: auditApprovalStateForWorkflow(approval)
          }
        })
      );
    }

    const result: RecordApprovalDecisionActivityResult = {
      approval,
      ...(run ? { run } : {}),
      auditEvents,
      completedAt: now
    };
    this.approvalsById.set(approval.id, clone(approval));
    if (run) this.runsById.set(run.id, clone(run));
    this.decisions.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  private attachApprovalToPausedRun(run: AgentRun, approvalId: string): AgentRun {
    const eventIndex = run.events.length;
    return {
      ...clone(run),
      status: "needs_approval",
      budgetApprovalId: run.budgetApprovalId ?? approvalId,
      events: [
        ...run.events,
        makeRunEvent(run.id, eventIndex, "agent.progress", `Approval ${approvalId} requested; run is paused.`)
      ]
    };
  }

  private applyDecisionToRun(
    run: AgentRun,
    approval: RequestApprovalActivityResult["approval"],
    decision: ApprovalWorkflowDecision,
    now: string
  ): AgentRun {
    const eventIndex = run.events.length;
    if (decision.status === "approved" && run.status === "needs_approval") {
      return {
        ...clone(run),
        status: "running",
        events: [
          ...run.events,
          makeRunEvent(run.id, eventIndex, "agent.progress", `Approval ${approval.id} approved; run resumed.`)
        ]
      };
    }

    if ((decision.status === "denied" || decision.status === "expired") && run.status === "needs_approval") {
      const pausedRun: AgentRun = {
        ...clone(run),
        events: [
          ...run.events,
          makeRunEvent(
            run.id,
            eventIndex,
            "agent.progress",
            decision.status === "denied"
              ? `Approval ${approval.id} denied; run remains paused.`
              : `Approval ${approval.id} expired; run remains paused.`
          )
        ]
      };
      return decision.status === "expired" && !pausedRun.endedAt ? { ...pausedRun, endedAt: now } : pausedRun;
    }

    return clone(run);
  }

  private isExpired(expiresAt: string, now: string) {
    return Date.parse(expiresAt) <= Date.parse(now);
  }

  private addAuditEvent(input: AuditEventInput): AuditEvent {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const chain = this.auditEventsByWorkflowId.get(input.workflowId) ?? [];
    const previousHash = chain.at(-1)?.hash ?? null;
    const eventWithoutHash: Omit<AuditEvent, "hash"> = {
      id: stableId("audit", `${input.workflowId}:${chain.length}:${input.action}:${input.targetId}`),
      traceId: input.workflowId,
      actorType: auditActorType(input.actor),
      actorId: input.actor,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      message: input.message,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
      metadataJson: input.metadataJson ?? {},
      previousHash,
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
      ...(input.prdId ? { prdId: input.prdId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt
    };
    const auditEvent: AuditEvent = {
      ...eventWithoutHash,
      hash: stableId("hash", JSON.stringify(eventWithoutHash))
    };
    chain.push(auditEvent);
    this.auditEventsByWorkflowId.set(input.workflowId, chain);
    return clone(auditEvent);
  }
}

export function createApprovalActivities(store: ApprovalActivityStore = new InMemoryApprovalActivityStore()) {
  return {
    requestApprovalActivity(input: RequestApprovalActivityInput) {
      return store.requestApproval(input);
    },
    recordApprovalDecisionActivity(input: RecordApprovalDecisionActivityInput) {
      return store.recordDecision(input);
    }
  };
}

export type ApprovalActivities = ReturnType<typeof createApprovalActivities>;

const defaultExecutionLeaseMs = 5 * 60 * 1000;

export class InMemoryWorkItemExecutionActivityStore implements WorkItemExecutionActivityStore {
  readonly claims = new Map<string, ClaimWorkItemExecutionActivityResult>();
  readonly preparedWorkspaces = new Map<string, PrepareWorkItemWorkspaceActivityResult>();
  readonly codexRuns = new Map<string, RunWorkItemCodexActivityResult>();
  readonly testRuns = new Map<string, RunWorkItemTestsActivityResult>();
  readonly pullRequests = new Map<string, CreateWorkItemPullRequestActivityResult>();
  readonly reviews = new Map<string, ReviewWorkItemExecutionActivityResult>();
  readonly archivedWorkspaces = new Map<string, ArchiveWorkItemWorkspaceActivityResult>();
  readonly completedExecutions = new Map<string, CompleteWorkItemExecutionActivityResult>();
  readonly auditEventsByWorkflowId = new Map<string, AuditEvent[]>();
  private readonly transientFailures = new Map<WorkItemExecutionActivityName, number>();
  private readonly attempts = new Map<WorkItemExecutionActivityName, number>();

  failNext(activityName: WorkItemExecutionActivityName, times = 1) {
    this.transientFailures.set(activityName, (this.transientFailures.get(activityName) ?? 0) + Math.max(1, times));
  }

  getAttemptCount(activityName: WorkItemExecutionActivityName) {
    return this.attempts.get(activityName) ?? 0;
  }

  async claimWorkItem(input: ClaimWorkItemExecutionActivityInput): Promise<ClaimWorkItemExecutionActivityResult> {
    this.beforeActivity("claim");
    const existing = this.claims.get(input.idempotencyKey);
    if (existing) return clone(existing);

    if (!["ready", "claimed"].includes(input.workItem.status)) {
      throw new Error(`WorkItem ${input.workItem.id} is not claimable from status ${input.workItem.status}`);
    }

    const now = new Date().toISOString();
    const agentId = input.agentId ?? agentIdForRole(input.workItem.role);
    const claimToken = stableId("claim", `${input.workflowId}:${input.workItem.id}:${input.idempotencyKey}`);
    const leaseExpiresAt = new Date(Date.parse(now) + (input.leaseDurationMs ?? defaultExecutionLeaseMs)).toISOString();
    const workItem: WorkItem = {
      ...clone(input.workItem),
      status: "claimed",
      assignedAgentId: agentId,
      claimedAt: now,
      claimToken,
      leaseExpiresAt,
      heartbeatAt: now,
      version: (input.workItem.version ?? 0) + 1,
      updatedAt: now
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: agentId,
        action: "work_item.claimed",
        targetType: "work_item",
        targetId: workItem.id,
        message: `WorkItem ${workItem.id} was claimed for Temporal execution.`,
        prdId: workItem.prdId,
        workItemId: workItem.id,
        beforeJson: { workItem: { id: input.workItem.id, status: input.workItem.status } },
        afterJson: {
          workItem: {
            id: workItem.id,
            status: workItem.status,
            assignedAgentId: workItem.assignedAgentId,
            leaseExpiresAt: workItem.leaseExpiresAt,
            version: workItem.version
          }
        }
      })
    ];
    const result: ClaimWorkItemExecutionActivityResult = {
      workItem,
      agentId,
      claimToken,
      leaseExpiresAt,
      auditEvents
    };
    this.claims.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async prepareWorkspace(
    input: PrepareWorkItemWorkspaceActivityInput
  ): Promise<PrepareWorkItemWorkspaceActivityResult> {
    this.beforeActivity("prepareWorkspace");
    const existing = this.preparedWorkspaces.get(input.idempotencyKey);
    if (existing) return clone(existing);

    if (input.workItem.claimToken !== input.claimToken) {
      throw new Error(`WorkItem ${input.workItem.id} claim token does not match`);
    }

    const now = new Date().toISOString();
    const runner = input.runner ?? "codex";
    const runId = stableId("run", `${input.workflowId}:${input.workItem.id}:agent-run`);
    const workspacePath =
      runner === "codex"
        ? `${input.workspaceRoot ?? ".patchpilot/workspaces"}/${runId}`
        : `simulated://${runId}`;
    const runningWorkItem: WorkItem = {
      ...clone(input.workItem),
      status: "running",
      heartbeatAt: now,
      leaseExpiresAt: new Date(Date.parse(now) + defaultExecutionLeaseMs).toISOString(),
      version: (input.workItem.version ?? 0) + 1,
      updatedAt: now
    };
    const agentRun: AgentRun = {
      id: runId,
      requirementId: input.prd.requirementId,
      prdId: input.prd.id,
      workItemId: input.workItem.id,
      runner,
      status: "running",
      currentStep: "developing",
      timeline: advanceTimeline(createTimeline(), "developing"),
      events: [
        makeRunEvent(runId, 0, "requirement.understood", "Requirement and WorkItem context loaded."),
        makeRunEvent(runId, 1, "plan.created", "Execution plan created from the WorkItem scope."),
        makeRunEvent(runId, 2, "workspace.created", `Workspace prepared at ${workspacePath}.`)
      ],
      costEstimateUsd: 0.38,
      startedAt: now
    };
    const workspaceRun: WorkspaceRun = {
      id: `ws_${runId}`,
      runId,
      requirementId: input.prd.requirementId,
      prdId: input.prd.id,
      workItemId: input.workItem.id,
      runner,
      status: "active",
      isolation: runner === "codex" ? "git_worktree" : "simulated",
      path: workspacePath,
      createdAt: now,
      updatedAt: now
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: input.agentId,
        action: "work_item.started",
        targetType: "work_item",
        targetId: runningWorkItem.id,
        message: `WorkItem ${runningWorkItem.id} started AgentRun ${agentRun.id}.`,
        requirementId: agentRun.requirementId,
        prdId: agentRun.prdId,
        workItemId: runningWorkItem.id,
        runId: agentRun.id,
        beforeJson: { workItem: { id: input.workItem.id, status: input.workItem.status } },
        afterJson: {
          workItem: { id: runningWorkItem.id, status: runningWorkItem.status },
          run: { id: agentRun.id, status: agentRun.status, runner: agentRun.runner }
        }
      }),
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: "workspace_manager",
        action: "workspace_run.created",
        targetType: "workspace_run",
        targetId: workspaceRun.id,
        message: "WorkspaceRun was created for WorkItem execution.",
        requirementId: agentRun.requirementId,
        prdId: agentRun.prdId,
        workItemId: runningWorkItem.id,
        runId: agentRun.id,
        beforeJson: null,
        afterJson: {
          workspaceRun: {
            id: workspaceRun.id,
            status: workspaceRun.status,
            isolation: workspaceRun.isolation,
            path: workspaceRun.path
          }
        }
      })
    ];
    const result: PrepareWorkItemWorkspaceActivityResult = {
      workItem: runningWorkItem,
      agentRun,
      workspaceRun,
      auditEvents
    };
    this.preparedWorkspaces.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async runCodex(input: RunWorkItemCodexActivityInput): Promise<RunWorkItemCodexActivityResult> {
    this.beforeActivity("runCodex");
    const existing = this.codexRuns.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const runIndex = input.agentRun.events.length;
    const changedFiles = changedFilesForWorkItem(input.workItem);
    const baseBranch = input.baseBranch ?? "main";
    const baseCommit = input.baseCommit ?? stableId("base", input.prd.id).replace(/^base_/, "base-");
    const headCommit = stableId("head", `${input.agentRun.id}:${changedFiles.join("|")}`).replace(/^head_/, "head-");
    const branchName = `patchpilot/${slugSegment(input.workItem.id)}-${slugSegment(input.workItem.title)}`;
    const codex: WorkItemExecutionCodexEvidence = {
      summary: `Implemented ${input.workItem.title} with Temporal WorkItemExecutionWorkflow evidence.`,
      previewUrl: input.previewUrl ?? "http://localhost:3000",
      riskLevel: changedFiles.length > 8 ? "medium" : "low",
      changedFiles,
      reviewerSummary: "Reviewer agent should verify the generated PR record, tests, and audit chain.",
      runner: input.agentRun.runner,
      agentMessages: [`Codex completed ${input.workItem.id} in ${input.workspaceRun.path}.`],
      reasoningSummaries: ["The run followed claim, workspace, Codex execution, test, PR, review, and archive steps."],
      branchName,
      baseBranch,
      baseCommit,
      headCommit,
      workspacePath: input.workspaceRun.path,
      codexSessionId: stableId("codex", `${input.workflowId}:${input.agentRun.id}`)
    };
    const agentRun: AgentRun = {
      ...clone(input.agentRun),
      currentStep: "developing",
      timeline: advanceTimeline(input.agentRun.timeline, "developing"),
      events: [
        ...input.agentRun.events,
        makeRunEvent(input.agentRun.id, runIndex, "codex.started", "CodexRunner activity started."),
        makeRunEvent(input.agentRun.id, runIndex + 1, "codex.output", codex.agentMessages[0] ?? "Codex completed."),
        makeRunEvent(
          input.agentRun.id,
          runIndex + 2,
          "agent.progress",
          "CodexRunner returned implementation evidence."
        ),
        makeRunEvent(
          input.agentRun.id,
          runIndex + 3,
          "git.diff.created",
          `${changedFiles.length} changed files recorded for review.`
        )
      ]
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: "codex_runner",
        action: "codex_run.completed",
        targetType: "agent_run",
        targetId: agentRun.id,
        message: "CodexRunner activity completed and returned diff evidence.",
        requirementId: agentRun.requirementId,
        prdId: agentRun.prdId,
        workItemId: agentRun.workItemId,
        runId: agentRun.id,
        beforeJson: { run: { id: input.agentRun.id, status: input.agentRun.status } },
        afterJson: {
          codex: {
            sessionId: codex.codexSessionId ?? null,
            branchName: codex.branchName,
            baseCommit: codex.baseCommit,
            headCommit: codex.headCommit,
            changedFiles: codex.changedFiles
          }
        }
      })
    ];
    const result: RunWorkItemCodexActivityResult = { agentRun, codex, auditEvents };
    this.codexRuns.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async runTests(input: RunWorkItemTestsActivityInput): Promise<RunWorkItemTestsActivityResult> {
    this.beforeActivity("runTests");
    const existing = this.testRuns.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const now = new Date().toISOString();
    const durationMs = 740;
    const testCase = executionTestCases(input.prd, input.workItem, input.testCases, now)[0];
    if (!testCase) throw new Error(`No TestCase could be created for WorkItem ${input.workItem.id}`);

    const testRun: TestRun = {
      id: stableId("test", `${input.agentRun.id}:${testCase.id}`),
      testCaseId: testCase.id,
      runId: input.agentRun.id,
      prdId: input.prd.id,
      workItemId: input.workItem.id,
      status: "passed",
      command: input.testCommand ?? "pnpm test -- --runInBand",
      summary: `Target tests passed for ${input.workItem.title}.`,
      durationMs,
      startedAt: new Date(Date.parse(now) - durationMs).toISOString(),
      endedAt: now,
      commit: input.codex.headCommit,
      branch: input.codex.branchName,
      workspacePath: input.workspaceRun.path,
      runner: input.agentRun.runner === "codex" ? "patchpilot-test-runner" : "simulated-test-runner",
      environmentImage: input.agentRun.runner === "codex" ? "local" : "simulated",
      exitCode: 0,
      retryCount: 0,
      attempt: 1,
      maxAttempts: 1,
      flakySignal: false,
      logArtifactId: stableId("artifact", `${input.agentRun.id}:${testCase.id}:log`)
    };
    const reportArtifactId = stableId("artifact", `${input.agentRun.id}:${testCase.id}:report`);
    const artifacts = [
      makeArtifact({
        id: testRun.logArtifactId ?? stableId("artifact", `${testRun.id}:log`),
        kind: "log",
        uri: `file://${input.workspaceRun.path}/.patchpilot/${testRun.id}.log`,
        contentType: "text/plain",
        body: testRun.summary,
        prdId: input.prd.id,
        workItemId: input.workItem.id,
        runId: input.agentRun.id,
        testRunId: testRun.id,
        createdAt: now
      }),
      makeArtifact({
        id: reportArtifactId,
        kind: "test_report",
        uri: `file://${input.workspaceRun.path}/.patchpilot/${testRun.id}.json`,
        contentType: "application/json",
        body: JSON.stringify(testRun),
        prdId: input.prd.id,
        workItemId: input.workItem.id,
        runId: input.agentRun.id,
        testRunId: testRun.id,
        createdAt: now
      })
    ];
    const normalizedTestRun: TestRun = {
      ...testRun,
      artifactIds: artifacts.map((artifact) => artifact.id)
    };
    const updatedTestCase: TestCase = {
      ...testCase,
      status: testCaseStatusFromTestRunStatus(normalizedTestRun.status),
      lastRunId: input.agentRun.id,
      lastTestRunId: normalizedTestRun.id,
      flaky: false,
      updatedAt: now
    };
    const runIndex = input.agentRun.events.length;
    const agentRun: AgentRun = {
      ...clone(input.agentRun),
      currentStep: "testing",
      timeline: advanceTimeline(input.agentRun.timeline, "testing"),
      events: [
        ...input.agentRun.events,
        makeRunEvent(input.agentRun.id, runIndex, "test.started", "Target test activity started."),
        makeRunEvent(input.agentRun.id, runIndex + 1, "test.passed", normalizedTestRun.summary)
      ]
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: "test_runner",
        action: "test_run.passed",
        targetType: "test_run",
        targetId: normalizedTestRun.id,
        message: "TestRun evidence was recorded for WorkItem execution.",
        requirementId: agentRun.requirementId,
        prdId: agentRun.prdId,
        workItemId: agentRun.workItemId,
        runId: agentRun.id,
        beforeJson: null,
        afterJson: {
          testRun: {
            id: normalizedTestRun.id,
            status: normalizedTestRun.status,
            command: normalizedTestRun.command,
            artifactIds: normalizedTestRun.artifactIds ?? []
          },
          testCase: {
            id: updatedTestCase.id,
            status: updatedTestCase.status,
            lastRunId: updatedTestCase.lastRunId,
            lastTestRunId: updatedTestCase.lastTestRunId
          }
        }
      })
    ];
    const result: RunWorkItemTestsActivityResult = {
      agentRun,
      testRuns: [normalizedTestRun],
      testCases: [updatedTestCase],
      artifacts,
      auditEvents
    };
    this.testRuns.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async createPullRequest(
    input: CreateWorkItemPullRequestActivityInput
  ): Promise<CreateWorkItemPullRequestActivityResult> {
    this.beforeActivity("createPullRequest");
    const existing = this.pullRequests.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const now = new Date().toISOString();
    const pullRequest: PullRequestRecord = {
      id: `pr_${input.agentRun.id}`,
      provider: "local",
      status: "ready_for_review",
      title: `[PatchPilot] ${input.workItem.title}`,
      requirementId: input.agentRun.requirementId,
      prdId: input.agentRun.prdId,
      workItemId: input.workItem.id,
      runId: input.agentRun.id,
      branchName: input.codex.branchName,
      baseBranch: input.codex.baseBranch,
      baseCommit: input.codex.baseCommit,
      headCommit: input.codex.headCommit,
      url: `local://pull-requests/${input.agentRun.id}`,
      bodyMarkdown: buildExecutionPullRequestBody(input.workItem, input.agentRun, input.codex, input.testRuns),
      reviewerSummary: input.codex.reviewerSummary,
      testSummary: summarizeTestRuns(input.testRuns),
      createdAt: now,
      updatedAt: now
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: "pr_adapter",
        action: "pull_request.ready_for_review",
        targetType: "pull_request",
        targetId: pullRequest.id,
        message: "PullRequestRecord was created for WorkItem execution.",
        requirementId: pullRequest.requirementId,
        prdId: pullRequest.prdId,
        workItemId: pullRequest.workItemId,
        runId: pullRequest.runId,
        beforeJson: null,
        afterJson: {
          pullRequest: {
            id: pullRequest.id,
            status: pullRequest.status,
            branchName: pullRequest.branchName,
            url: pullRequest.url
          }
        }
      })
    ];
    const result: CreateWorkItemPullRequestActivityResult = { pullRequest, auditEvents };
    this.pullRequests.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async reviewExecution(
    input: ReviewWorkItemExecutionActivityInput
  ): Promise<ReviewWorkItemExecutionActivityResult> {
    this.beforeActivity("reviewExecution");
    const existing = this.reviews.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const now = new Date().toISOString();
    const reviewRecord: ReviewRecord = {
      id: `review_${input.agentRun.id}`,
      status: input.testRuns.every((testRun) => testRun.status === "passed") ? "approved" : "changes_requested",
      requirementId: input.agentRun.requirementId,
      prdId: input.agentRun.prdId,
      workItemId: input.workItem.id,
      runId: input.agentRun.id,
      linkedPullRequestId: input.pullRequest.id,
      reviewerAgentId: "agent_reviewer",
      summary: `Reviewer agent 摘要：${input.codex.reviewerSummary}`,
      testSummary: summarizeTestRuns(input.testRuns),
      riskLevel: input.codex.riskLevel,
      findings: [
        "Execution workflow produced a PR record",
        "Target tests passed",
        "Audit evidence chain is ready for acceptance"
      ],
      createdAt: now,
      updatedAt: now
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: "reviewer_agent",
        action: "review.approved",
        targetType: "review_record",
        targetId: reviewRecord.id,
        message: "ReviewRecord was created from PR and TestRun evidence.",
        requirementId: reviewRecord.requirementId,
        prdId: reviewRecord.prdId,
        workItemId: reviewRecord.workItemId,
        runId: reviewRecord.runId,
        beforeJson: null,
        afterJson: {
          reviewRecord: {
            id: reviewRecord.id,
            status: reviewRecord.status,
            linkedPullRequestId: reviewRecord.linkedPullRequestId,
            riskLevel: reviewRecord.riskLevel
          }
        }
      })
    ];
    const result: ReviewWorkItemExecutionActivityResult = { reviewRecord, auditEvents };
    this.reviews.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async archiveWorkspace(
    input: ArchiveWorkItemWorkspaceActivityInput
  ): Promise<ArchiveWorkItemWorkspaceActivityResult> {
    this.beforeActivity("archiveWorkspace");
    const existing = this.archivedWorkspaces.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const now = new Date().toISOString();
    const workspaceRun: WorkspaceRun = {
      ...clone(input.workspaceRun),
      status: "archived",
      archivedAt: now,
      updatedAt: now
    };
    const auditEvents = [
      this.addAuditEvent({
        workflowId: input.workflowId,
        actor: "workspace_manager",
        action: "workspace_run.archived",
        targetType: "workspace_run",
        targetId: workspaceRun.id,
        message: "WorkspaceRun was archived after evidence collection.",
        requirementId: workspaceRun.requirementId,
        prdId: workspaceRun.prdId,
        workItemId: workspaceRun.workItemId,
        runId: workspaceRun.runId,
        beforeJson: { workspaceRun: { id: input.workspaceRun.id, status: input.workspaceRun.status } },
        afterJson: { workspaceRun: { id: workspaceRun.id, status: workspaceRun.status, archivedAt: workspaceRun.archivedAt } }
      })
    ];
    const result: ArchiveWorkItemWorkspaceActivityResult = { workspaceRun, auditEvents };
    this.archivedWorkspaces.set(input.idempotencyKey, clone(result));
    return clone(result);
  }

  async completeExecution(
    input: CompleteWorkItemExecutionActivityInput
  ): Promise<CompleteWorkItemExecutionActivityResult> {
    this.beforeActivity("completeExecution");
    const existing = this.completedExecutions.get(input.idempotencyKey);
    if (existing) return clone(existing);

    const now = new Date().toISOString();
    const traceArtifact = makeArtifact({
      id: stableId("artifact", `${input.agentRun.id}:trace`),
      kind: "trace",
      uri: `file://${input.workspaceRun.path}/.patchpilot/${input.agentRun.id}-trace.json`,
      contentType: "application/json",
      body: JSON.stringify({ runId: input.agentRun.id, events: input.agentRun.events }),
      prdId: input.agentRun.prdId,
      workItemId: input.agentRun.workItemId,
      runId: input.agentRun.id,
      createdAt: now
    });
    const diffArtifact = makeArtifact({
      id: stableId("artifact", `${input.agentRun.id}:diff`),
      kind: "diff",
      uri: `file://${input.workspaceRun.path}/.patchpilot/${input.agentRun.id}.diff`,
      contentType: "text/plain",
      body: input.codex.changedFiles.join("\n"),
      prdId: input.agentRun.prdId,
      workItemId: input.agentRun.workItemId,
      runId: input.agentRun.id,
      createdAt: now
    });
    const previewArtifact = makeArtifact({
      id: stableId("artifact", `${input.agentRun.id}:preview`),
      kind: "preview_metadata",
      uri: `file://${input.workspaceRun.path}/.patchpilot/${input.agentRun.id}-preview.json`,
      contentType: "application/json",
      body: JSON.stringify({ previewUrl: input.codex.previewUrl }),
      prdId: input.agentRun.prdId,
      workItemId: input.agentRun.workItemId,
      runId: input.agentRun.id,
      createdAt: now
    });
    const artifacts = [...input.artifacts, traceArtifact, diffArtifact, previewArtifact];
    const artifactIds = artifacts.map((artifact) => artifact.id);
    const testRuns = input.testRuns.map((testRun) => ({
      ...testRun,
      pullRequestId: input.pullRequest.id
    }));
    const result: AgentRunResult = {
      summary: input.codex.summary,
      previewUrl: input.codex.previewUrl,
      riskLevel: input.codex.riskLevel,
      changedFiles: input.codex.changedFiles,
      tests: testRuns,
      reviewerSummary: input.codex.reviewerSummary,
      runner: input.codex.runner,
      agentMessages: input.codex.agentMessages,
      reasoningSummaries: input.codex.reasoningSummaries,
      diffSummary: {
        changedFileCount: input.codex.changedFiles.length,
        changedFiles: input.codex.changedFiles,
        hasChanges: input.codex.changedFiles.length > 0,
        branchName: input.codex.branchName,
        baseBranch: input.codex.baseBranch,
        baseCommit: input.codex.baseCommit,
        headCommit: input.codex.headCommit
      },
      testOutputSummary: summarizeTestRuns(testRuns),
      workspacePath: input.workspaceRun.path,
      branchName: input.codex.branchName,
      baseBranch: input.codex.baseBranch,
      baseCommit: input.codex.baseCommit,
      headCommit: input.codex.headCommit,
      codexSessionId: input.codex.codexSessionId,
      artifactIds
    };
    const agentRun: AgentRun = {
      ...clone(input.agentRun),
      status: "succeeded",
      currentStep: "confirming",
      timeline: completeTimeline(input.agentRun.timeline),
      events: [
        ...input.agentRun.events,
        makeRunEvent(input.agentRun.id, input.agentRun.events.length, "review.completed", "Reviewer evidence recorded."),
        makeRunEvent(
          input.agentRun.id,
          input.agentRun.events.length + 1,
          "acceptance.waiting",
          "Execution completed and is waiting for acceptance."
        )
      ],
      result,
      costActualUsd: 0.38,
      artifactIds,
      endedAt: now
    };
    const workItem = clearExecutionClaim({
      ...clone(input.workItem),
      status: "review",
      version: (input.workItem.version ?? 0) + 1,
      updatedAt: now
    });
    const successAudit = this.addAuditEvent({
      workflowId: input.workflowId,
      actor: "workflow",
      action: "agent_run.succeeded",
      targetType: "agent_run",
      targetId: agentRun.id,
      message: "WorkItemExecutionWorkflow reached terminal success and recorded its evidence chain.",
      requirementId: agentRun.requirementId,
      prdId: agentRun.prdId,
      workItemId: agentRun.workItemId,
      runId: agentRun.id,
      beforeJson: {
        run: { id: input.agentRun.id, status: input.agentRun.status },
        workItem: { id: input.workItem.id, status: input.workItem.status }
      },
      afterJson: {
        run: { id: agentRun.id, status: agentRun.status, artifactIds },
        workItem: { id: workItem.id, status: workItem.status },
        evidence: {
          workspaceRunId: input.workspaceRun.id,
          testRunIds: testRuns.map((testRun) => testRun.id),
          pullRequestId: input.pullRequest.id,
          reviewRecordId: input.reviewRecord.id,
          artifactIds
        }
      }
    });
    const auditEvents = this.auditEventsByWorkflowId.get(input.workflowId) ?? [successAudit];
    const evidenceChain = {
      workflowId: input.workflowId,
      workItemId: workItem.id,
      agentRunId: agentRun.id,
      workspaceRunId: input.workspaceRun.id,
      testRunIds: testRuns.map((testRun) => testRun.id),
      pullRequestId: input.pullRequest.id,
      reviewRecordId: input.reviewRecord.id,
      artifactIds,
      auditEventIds: auditEvents.map((event) => event.id),
      archivedAt: input.workspaceRun.archivedAt ?? input.workspaceRun.updatedAt,
      completedAt: now
    };
    const completed: CompleteWorkItemExecutionActivityResult = {
      workItem,
      agentRun,
      workspaceRun: input.workspaceRun,
      testRuns,
      testCases: input.testCases,
      pullRequest: input.pullRequest,
      reviewRecord: input.reviewRecord,
      artifacts,
      auditEvents: clone(auditEvents),
      evidenceChain,
      completedAt: now
    };
    this.completedExecutions.set(input.idempotencyKey, clone(completed));
    return clone(completed);
  }

  private beforeActivity(activityName: WorkItemExecutionActivityName) {
    this.attempts.set(activityName, (this.attempts.get(activityName) ?? 0) + 1);
    const remainingFailures = this.transientFailures.get(activityName) ?? 0;
    if (remainingFailures <= 0) return;
    this.transientFailures.set(activityName, remainingFailures - 1);
    throw new Error(`Injected transient ${activityName} activity failure`);
  }

  private addAuditEvent(input: AuditEventInput): AuditEvent {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const chain = this.auditEventsByWorkflowId.get(input.workflowId) ?? [];
    const previousHash = chain.at(-1)?.hash ?? null;
    const eventWithoutHash: Omit<AuditEvent, "hash"> = {
      id: stableId("audit", `${input.workflowId}:${chain.length}:${input.action}:${input.targetId}`),
      traceId: input.workflowId,
      actorType: auditActorType(input.actor),
      actorId: input.actor,
      actor: input.actor,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      message: input.message,
      beforeJson: input.beforeJson ?? null,
      afterJson: input.afterJson ?? null,
      metadataJson: input.metadataJson ?? {},
      previousHash,
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
      ...(input.prdId ? { prdId: input.prdId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt
    };
    const auditEvent: AuditEvent = {
      ...eventWithoutHash,
      hash: stableId("hash", JSON.stringify(eventWithoutHash))
    };
    chain.push(auditEvent);
    this.auditEventsByWorkflowId.set(input.workflowId, chain);
    return clone(auditEvent);
  }
}

export function createWorkItemExecutionActivities(
  store: WorkItemExecutionActivityStore = new InMemoryWorkItemExecutionActivityStore()
) {
  return {
    claimWorkItemExecutionActivity(input: ClaimWorkItemExecutionActivityInput) {
      return store.claimWorkItem(input);
    },
    prepareWorkItemWorkspaceActivity(input: PrepareWorkItemWorkspaceActivityInput) {
      return store.prepareWorkspace(input);
    },
    runWorkItemCodexActivity(input: RunWorkItemCodexActivityInput) {
      return store.runCodex(input);
    },
    runWorkItemTestsActivity(input: RunWorkItemTestsActivityInput) {
      return store.runTests(input);
    },
    createWorkItemPullRequestActivity(input: CreateWorkItemPullRequestActivityInput) {
      return store.createPullRequest(input);
    },
    reviewWorkItemExecutionActivity(input: ReviewWorkItemExecutionActivityInput) {
      return store.reviewExecution(input);
    },
    archiveWorkItemWorkspaceActivity(input: ArchiveWorkItemWorkspaceActivityInput) {
      return store.archiveWorkspace(input);
    },
    completeWorkItemExecutionActivity(input: CompleteWorkItemExecutionActivityInput) {
      return store.completeExecution(input);
    }
  };
}

export type WorkItemExecutionActivities = ReturnType<typeof createWorkItemExecutionActivities>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function agentIdForRole(role: AgentRole): string {
  if (role === "reviewer") return "agent_reviewer";
  if (role === "product") return "agent_product";
  return `agent_${role}`;
}

function auditActorType(actor: string): string {
  if (actor.endsWith("_agent") || actor.startsWith("agent_")) return "agent";
  if (actor === "workflow") return "workflow";
  return "system";
}

function approvalAction(status: ApprovalWorkflowDecision["status"]) {
  if (status === "approved") return "approval.approved";
  if (status === "denied") return "approval.denied";
  return "approval.expired";
}

function approvalDecisionMessage(status: ApprovalWorkflowDecision["status"]) {
  if (status === "approved") return "Approval signal approved the pending gate.";
  if (status === "denied") return "Approval signal denied the pending gate.";
  return "Approval signal expired the pending gate.";
}

function auditApprovalStateForWorkflow(approval: RequestApprovalActivityResult["approval"]) {
  return {
    id: approval.id,
    kind: approval.kind,
    status: approval.status,
    targetType: approval.targetType,
    targetId: approval.targetId,
    riskLevel: approval.riskLevel,
    expiresAt: approval.expiresAt,
    approvedBy: approval.approvedBy ?? null,
    deniedBy: approval.deniedBy ?? null,
    decisionReason: approval.decisionReason ?? null,
    decidedAt: approval.decidedAt ?? null,
    runId: approval.runId ?? null
  };
}

function makeRunEvent(
  runId: string,
  index: number,
  type: AgentRun["events"][number]["type"],
  message: string
): AgentRun["events"][number] {
  return {
    id: stableId("event", `${runId}:${index}:${type}:${message}`),
    at: new Date().toISOString(),
    type,
    message
  };
}

function changedFilesForWorkItem(workItem: WorkItem): string[] {
  const roleFiles: Record<AgentRole, string[]> = {
    backend: ["services/api/src/store.ts", "packages/workflows/src/workflows.ts"],
    frontend: ["apps/web/src/app/page.tsx", "apps/web/src/app/page.css"],
    test: ["packages/workflows/src/activities.test.ts", "scripts/e2e-temporal.mjs"],
    ops: ["README.md", "infra/docker-compose.yml"],
    product: ["CONTEXT.md"],
    reviewer: ["docs/reviews/work-item-review.md"]
  };
  return roleFiles[workItem.role] ?? ["PATCHPILOT_TASK.md"];
}

function slugSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || "work-item";
}

function executionTestCases(
  prd: Prd,
  workItem: WorkItem,
  testCases: TestCase[] | undefined,
  now: string
): TestCase[] {
  const matching = (testCases ?? []).filter((testCase) => testCase.workItemId === workItem.id);
  if (matching.length > 0) return matching.map(clone);
  return createTestCasesForWorkItems(prd, [workItem], now);
}

function makeArtifact(input: {
  id: string;
  kind: ArtifactKind;
  uri: string;
  contentType: string;
  body: string;
  prdId: string;
  workItemId: string;
  runId: string;
  testRunId?: string;
  createdAt: string;
}): ArtifactRecord {
  return {
    id: input.id,
    kind: input.kind,
    storage: "local_fs",
    uri: input.uri,
    contentType: input.contentType,
    sizeBytes: Buffer.byteLength(input.body, "utf8"),
    checksumSha256: createHash("sha256").update(input.body).digest("hex"),
    prdId: input.prdId,
    workItemId: input.workItemId,
    runId: input.runId,
    ...(input.testRunId ? { testRunId: input.testRunId } : {}),
    createdAt: input.createdAt
  };
}

function buildExecutionPullRequestBody(
  workItem: WorkItem,
  run: AgentRun,
  codex: WorkItemExecutionCodexEvidence,
  testRuns: TestRun[]
) {
  return [
    "## Requirement",
    `Requirement: ${run.requirementId}`,
    `PRD: ${run.prdId}`,
    "",
    "## WorkItem",
    `WorkItem: ${workItem.id}`,
    `Role: ${workItem.role}`,
    `Scope: ${workItem.scope}`,
    "",
    "## Git",
    `Branch: ${codex.branchName}`,
    `Base: ${codex.baseBranch} (${codex.baseCommit})`,
    `Commit: ${codex.headCommit}`,
    "",
    "## Change Summary",
    codex.summary,
    "",
    "## Diff Summary",
    `${codex.changedFiles.length} changed files: ${codex.changedFiles.join(", ") || "none"}`,
    "",
    "## Test Results",
    summarizeTestRuns(testRuns),
    "",
    "## Risk",
    codex.riskLevel,
    "",
    "## Reviewer Agent Summary",
    codex.reviewerSummary
  ].join("\n");
}

function summarizeTestRuns(testRuns: TestRun[]) {
  if (testRuns.length === 0) return "No test evidence recorded.";
  return testRuns.map((testRun) => `${testRun.status}: ${testRun.command} (${testRun.durationMs}ms)`).join("\n");
}

function clearExecutionClaim(workItem: WorkItem): WorkItem {
  const cleared = { ...workItem };
  delete cleared.assignedAgentId;
  delete cleared.claimedAt;
  delete cleared.claimToken;
  delete cleared.leaseExpiresAt;
  delete cleared.heartbeatAt;
  return cleared;
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
