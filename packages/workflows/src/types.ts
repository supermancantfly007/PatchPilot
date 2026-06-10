import type {
  AgentRun,
  AgentRunnerKind,
  ApprovalKind,
  ApprovalRecord,
  ApprovalRiskLevel,
  ApprovalStatus,
  ApprovalTargetType,
  ArtifactRecord,
  AuditEvent,
  ClarificationQuestion,
  InterfaceContract,
  InterfaceContractStatus,
  IntakeArtifactReference,
  Prd,
  PullRequestRecord,
  Requirement,
  RequirementTemplate,
  ReviewRecord,
  TestCase,
  TestRun,
  WorkspaceRun,
  WorkItem
} from "@patchpilot/domain";

export const defaultTemporalAddress = "localhost:7233";
export const defaultTemporalNamespace = "default";
export const defaultTemporalTaskQueue = "patchpilot-td-204";

export type TemporalCanaryStatus = "waiting_for_signal" | "signaled" | "completed";

export interface TemporalConnectionConfig {
  address: string;
  namespace: string;
  taskQueue: string;
}

export interface TemporalCanaryWorkflowInput {
  idempotencyKey: string;
  label: string;
  waitForSignal?: boolean;
}

export interface TemporalCanarySignalInput {
  actor: string;
  note?: string;
}

export interface TemporalCanaryProgress {
  workflowId: string;
  idempotencyKey: string;
  label: string;
  status: TemporalCanaryStatus;
  signal?: TemporalCanarySignalInput;
}

export interface TemporalCanaryActivityInput {
  workflowId: string;
  idempotencyKey: string;
  label: string;
  signal?: TemporalCanarySignalInput;
}

export interface TemporalCanaryActivityResult {
  workflowId: string;
  idempotencyKey: string;
  label: string;
  signal?: TemporalCanarySignalInput;
  completedAt: string;
}

export interface TemporalCanaryWorkflowResult extends TemporalCanaryActivityResult {
  status: "completed";
}

export type ApprovalDecisionStatus = Extract<ApprovalStatus, "approved" | "denied" | "expired">;
export type ApprovalWorkflowStatus =
  | "requesting"
  | "waiting_for_decision"
  | "recording_decision"
  | ApprovalDecisionStatus;

export interface ApprovalWorkflowInput {
  idempotencyKey: string;
  kind: ApprovalKind;
  targetType: ApprovalTargetType;
  targetId: string;
  requestedBy: string;
  requestedReason: string;
  riskLevel: ApprovalRiskLevel;
  expiresAt: string;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  pausedRun?: AgentRun;
}

export interface ApprovalSignalInput {
  decidedBy: string;
  decisionReason: string;
}

export interface ApprovalWorkflowDecision extends ApprovalSignalInput {
  status: ApprovalDecisionStatus;
}

export interface ApprovalWorkflowProgress {
  workflowId: string;
  idempotencyKey: string;
  status: ApprovalWorkflowStatus;
  approval?: ApprovalRecord;
  run?: AgentRun;
  decision?: ApprovalWorkflowDecision;
  auditEventCount: number;
}

export interface ApprovalWorkflowResult extends ApprovalWorkflowProgress {
  status: ApprovalDecisionStatus;
  approval: ApprovalRecord;
  auditEvents: AuditEvent[];
  completedAt: string;
}

export interface RequestApprovalActivityInput extends ApprovalWorkflowInput {
  workflowId: string;
}

export interface RequestApprovalActivityResult {
  approval: ApprovalRecord;
  run?: AgentRun;
  auditEvents: AuditEvent[];
}

export interface RecordApprovalDecisionActivityInput {
  workflowId: string;
  idempotencyKey: string;
  approval: ApprovalRecord;
  decision: ApprovalWorkflowDecision;
  pausedRun?: AgentRun;
}

export interface RecordApprovalDecisionActivityResult {
  approval: ApprovalRecord;
  run?: AgentRun;
  auditEvents: AuditEvent[];
  completedAt: string;
}

export interface TemporalEnv {
  PATCHPILOT_TEMPORAL_ADDRESS?: string;
  PATCHPILOT_TEMPORAL_NAMESPACE?: string;
  PATCHPILOT_TEMPORAL_TASK_QUEUE?: string;
}

export type RequirementIntakeWorkflowStatus =
  | "intaking"
  | "clarifying"
  | "recording_clarification"
  | "drafting_prd"
  | "awaiting_confirmation"
  | "recording_confirmation"
  | "completed";

export type RequirementIntakeArtifactReferenceInput = Omit<IntakeArtifactReference, "id" | "createdAt"> &
  Partial<Pick<IntakeArtifactReference, "id" | "createdAt">>;

export interface RequirementIntakeWorkflowInput {
  idempotencyKey: string;
  rawInput: string;
  template: RequirementTemplate;
  artifactReferences?: RequirementIntakeArtifactReferenceInput[];
  maxClarificationTurns?: number;
  requirementId?: string;
}

export interface RequirementClarificationAnswerSignalInput {
  actor: string;
  answer: string;
  continueClarification?: boolean;
  note?: string;
}

export interface RequirementPrdConfirmationSignalInput {
  actor: string;
  accepted: boolean;
  note?: string;
}

export interface RequirementIntakeProgress {
  workflowId: string;
  idempotencyKey: string;
  status: RequirementIntakeWorkflowStatus;
  clarificationAnswerCount: number;
  requirement?: Requirement;
  currentQuestion?: ClarificationQuestion;
  prd?: Prd;
  confirmation?: RequirementPrdConfirmationSignalInput;
}

export interface RequirementIntakeWorkflowResult extends RequirementIntakeProgress {
  status: "completed";
  requirement: Requirement;
  prd: Prd;
  confirmation: RequirementPrdConfirmationSignalInput;
  completedAt: string;
}

export interface StartRequirementIntakeActivityInput {
  workflowId: string;
  idempotencyKey: string;
  rawInput: string;
  template: RequirementTemplate;
  artifactReferences?: RequirementIntakeArtifactReferenceInput[];
  requirementId?: string;
}

export interface StartRequirementIntakeActivityResult {
  requirement: Requirement;
  currentQuestion?: ClarificationQuestion;
}

export interface RecordRequirementClarificationAnswerActivityInput {
  workflowId: string;
  idempotencyKey: string;
  requirementId: string;
  questionId?: string;
  answer: RequirementClarificationAnswerSignalInput;
  shouldDraftPrd: boolean;
}

export interface RecordRequirementClarificationAnswerActivityResult {
  requirement: Requirement;
  nextQuestion?: ClarificationQuestion;
  readyForPrd: boolean;
  clarificationAnswerCount: number;
}

export interface DraftRequirementPrdActivityInput {
  workflowId: string;
  idempotencyKey: string;
  requirementId: string;
}

export interface DraftRequirementPrdActivityResult {
  requirement: Requirement;
  prd: Prd;
}

export interface RecordRequirementPrdConfirmationActivityInput {
  workflowId: string;
  idempotencyKey: string;
  requirementId: string;
  prdId: string;
  confirmation: RequirementPrdConfirmationSignalInput;
}

export interface RecordRequirementPrdConfirmationActivityResult {
  requirementId: string;
  prdId: string;
  confirmation: RequirementPrdConfirmationSignalInput;
  confirmedAt: string;
}

export type WorkItemPlanningWorkflowStatus = "planning" | "completed";

export interface WorkItemPlanningWorkflowInput {
  idempotencyKey: string;
  prd: Prd;
  maxWorkItems?: number;
  contractStatus?: InterfaceContractStatus;
}

export interface WorkItemPlanningProgress {
  workflowId: string;
  idempotencyKey: string;
  prdId: string;
  status: WorkItemPlanningWorkflowStatus;
  workItems?: WorkItem[];
  testCases?: TestCase[];
  interfaceContracts?: InterfaceContract[];
}

export interface WorkItemPlanningWorkflowResult extends WorkItemPlanningProgress {
  status: "completed";
  workItems: WorkItem[];
  testCases: TestCase[];
  interfaceContracts: InterfaceContract[];
  completedAt: string;
}

export interface PlanWorkItemsActivityInput {
  workflowId: string;
  idempotencyKey: string;
  prd: Prd;
  maxWorkItems?: number;
  contractStatus?: InterfaceContractStatus;
}

export interface PlanWorkItemsActivityResult {
  prdId: string;
  workItems: WorkItem[];
  testCases: TestCase[];
  interfaceContracts: InterfaceContract[];
  plannedAt: string;
}

export type WorkItemExecutionWorkflowStatus =
  | "claiming"
  | "preparing_workspace"
  | "running_codex"
  | "running_tests"
  | "creating_pull_request"
  | "reviewing"
  | "archiving"
  | "recording_terminal_state"
  | "completed";

export interface WorkItemExecutionWorkflowInput {
  idempotencyKey: string;
  prd: Prd;
  workItem: WorkItem;
  testCases?: TestCase[];
  agentId?: string;
  runner?: AgentRunnerKind;
  baseBranch?: string;
  baseCommit?: string;
  workspaceRoot?: string;
  previewUrl?: string;
  testCommand?: string;
  leaseDurationMs?: number;
}

export interface WorkItemExecutionEvidenceChain {
  workflowId: string;
  workItemId: string;
  agentRunId: string;
  workspaceRunId: string;
  testRunIds: string[];
  pullRequestId: string;
  reviewRecordId: string;
  artifactIds: string[];
  auditEventIds: string[];
  archivedAt: string;
  completedAt: string;
}

export interface WorkItemExecutionProgress {
  workflowId: string;
  idempotencyKey: string;
  prdId: string;
  workItemId: string;
  status: WorkItemExecutionWorkflowStatus;
  agentId?: string;
  agentRun?: AgentRun;
  workspaceRun?: WorkspaceRun;
  testRuns?: TestRun[];
  pullRequest?: PullRequestRecord;
  reviewRecord?: ReviewRecord;
  evidenceChain?: WorkItemExecutionEvidenceChain;
  auditEventCount: number;
}

export interface WorkItemExecutionWorkflowResult extends WorkItemExecutionProgress {
  status: "completed";
  workItem: WorkItem;
  agentRun: AgentRun;
  workspaceRun: WorkspaceRun;
  testRuns: TestRun[];
  testCases: TestCase[];
  pullRequest: PullRequestRecord;
  reviewRecord: ReviewRecord;
  artifacts: ArtifactRecord[];
  auditEvents: AuditEvent[];
  evidenceChain: WorkItemExecutionEvidenceChain;
  completedAt: string;
}

export interface WorkItemExecutionCodexEvidence {
  summary: string;
  previewUrl: string;
  riskLevel: "low" | "medium" | "high";
  changedFiles: string[];
  reviewerSummary: string;
  runner: AgentRunnerKind;
  agentMessages: string[];
  reasoningSummaries: string[];
  branchName: string;
  baseBranch: string;
  baseCommit: string;
  headCommit: string;
  workspacePath: string;
  codexSessionId?: string;
}

export interface ClaimWorkItemExecutionActivityInput {
  workflowId: string;
  idempotencyKey: string;
  workItem: WorkItem;
  agentId?: string;
  leaseDurationMs?: number;
}

export interface ClaimWorkItemExecutionActivityResult {
  workItem: WorkItem;
  agentId: string;
  claimToken: string;
  leaseExpiresAt: string;
  auditEvents: AuditEvent[];
}

export interface PrepareWorkItemWorkspaceActivityInput {
  workflowId: string;
  idempotencyKey: string;
  prd: Prd;
  workItem: WorkItem;
  agentId: string;
  claimToken: string;
  runner?: AgentRunnerKind;
  workspaceRoot?: string;
}

export interface PrepareWorkItemWorkspaceActivityResult {
  workItem: WorkItem;
  agentRun: AgentRun;
  workspaceRun: WorkspaceRun;
  auditEvents: AuditEvent[];
}

export interface RunWorkItemCodexActivityInput {
  workflowId: string;
  idempotencyKey: string;
  prd: Prd;
  workItem: WorkItem;
  agentRun: AgentRun;
  workspaceRun: WorkspaceRun;
  baseBranch?: string;
  baseCommit?: string;
  previewUrl?: string;
}

export interface RunWorkItemCodexActivityResult {
  agentRun: AgentRun;
  codex: WorkItemExecutionCodexEvidence;
  auditEvents: AuditEvent[];
}

export interface RunWorkItemTestsActivityInput {
  workflowId: string;
  idempotencyKey: string;
  prd: Prd;
  workItem: WorkItem;
  agentRun: AgentRun;
  workspaceRun: WorkspaceRun;
  codex: WorkItemExecutionCodexEvidence;
  testCases?: TestCase[];
  testCommand?: string;
}

export interface RunWorkItemTestsActivityResult {
  agentRun: AgentRun;
  testRuns: TestRun[];
  testCases: TestCase[];
  artifacts: ArtifactRecord[];
  auditEvents: AuditEvent[];
}

export interface CreateWorkItemPullRequestActivityInput {
  workflowId: string;
  idempotencyKey: string;
  workItem: WorkItem;
  agentRun: AgentRun;
  codex: WorkItemExecutionCodexEvidence;
  testRuns: TestRun[];
}

export interface CreateWorkItemPullRequestActivityResult {
  pullRequest: PullRequestRecord;
  auditEvents: AuditEvent[];
}

export interface ReviewWorkItemExecutionActivityInput {
  workflowId: string;
  idempotencyKey: string;
  workItem: WorkItem;
  agentRun: AgentRun;
  codex: WorkItemExecutionCodexEvidence;
  testRuns: TestRun[];
  pullRequest: PullRequestRecord;
}

export interface ReviewWorkItemExecutionActivityResult {
  reviewRecord: ReviewRecord;
  auditEvents: AuditEvent[];
}

export interface ArchiveWorkItemWorkspaceActivityInput {
  workflowId: string;
  idempotencyKey: string;
  workspaceRun: WorkspaceRun;
  agentRun: AgentRun;
}

export interface ArchiveWorkItemWorkspaceActivityResult {
  workspaceRun: WorkspaceRun;
  auditEvents: AuditEvent[];
}

export interface CompleteWorkItemExecutionActivityInput {
  workflowId: string;
  idempotencyKey: string;
  workItem: WorkItem;
  agentRun: AgentRun;
  workspaceRun: WorkspaceRun;
  codex: WorkItemExecutionCodexEvidence;
  testRuns: TestRun[];
  testCases: TestCase[];
  artifacts: ArtifactRecord[];
  pullRequest: PullRequestRecord;
  reviewRecord: ReviewRecord;
}

export interface CompleteWorkItemExecutionActivityResult {
  workItem: WorkItem;
  agentRun: AgentRun;
  workspaceRun: WorkspaceRun;
  testRuns: TestRun[];
  testCases: TestCase[];
  pullRequest: PullRequestRecord;
  reviewRecord: ReviewRecord;
  artifacts: ArtifactRecord[];
  auditEvents: AuditEvent[];
  evidenceChain: WorkItemExecutionEvidenceChain;
  completedAt: string;
}
