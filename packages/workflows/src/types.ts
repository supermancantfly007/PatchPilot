import type {
  ClarificationQuestion,
  InterfaceContract,
  InterfaceContractStatus,
  IntakeArtifactReference,
  Prd,
  Requirement,
  RequirementTemplate,
  TestCase,
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
