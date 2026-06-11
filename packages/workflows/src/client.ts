import { createHash } from "node:crypto";
import {
  Client,
  Connection,
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdConflictPolicy,
  WorkflowIdReusePolicy,
  type WorkflowHandle,
  type WorkflowStartOptions
} from "@temporalio/client";
import {
  approvalProgressQuery,
  approvalWorkflow,
  approveApprovalSignal,
  approveTemporalCanarySignal,
  answerRequirementClarificationSignal,
  confirmRequirementPrdSignal,
  defectReproductionProgressQuery,
  defectReproductionWorkflow,
  denyApprovalSignal,
  expireApprovalSignal,
  requirementIntakeProgressQuery,
  requirementIntakeWorkflow,
  retrospectiveProgressQuery,
  retrospectiveWorkflow,
  temporalCanaryProgressQuery,
  temporalCanaryWorkflow,
  workItemExecutionProgressQuery,
  workItemExecutionWorkflow,
  workItemPlanningProgressQuery,
  workItemPlanningWorkflow
} from "./workflows";
import {
  type ApprovalSignalInput,
  type ApprovalWorkflowInput,
  type ApprovalWorkflowProgress,
  type ApprovalWorkflowResult,
  type DefectReproductionProgress,
  type DefectReproductionWorkflowInput,
  type DefectReproductionWorkflowResult,
  type RequirementClarificationAnswerSignalInput,
  type RequirementIntakeProgress,
  type RequirementIntakeWorkflowInput,
  type RequirementIntakeWorkflowResult,
  type RequirementPrdConfirmationSignalInput,
  type RetrospectiveProgress,
  type RetrospectiveWorkflowInput,
  type RetrospectiveWorkflowResult,
  defaultTemporalAddress,
  defaultTemporalNamespace,
  defaultTemporalTaskQueue,
  type TemporalCanaryProgress,
  type TemporalCanarySignalInput,
  type TemporalCanaryWorkflowInput,
  type TemporalCanaryWorkflowResult,
  type TemporalConnectionConfig,
  type TemporalEnv,
  type WorkItemExecutionProgress,
  type WorkItemExecutionWorkflowInput,
  type WorkItemExecutionWorkflowResult,
  type WorkItemPlanningProgress,
  type WorkItemPlanningWorkflowInput,
  type WorkItemPlanningWorkflowResult
} from "./types";

export type TemporalCanaryWorkflowHandle = WorkflowHandle<typeof temporalCanaryWorkflow>;
export type ApprovalWorkflowHandle = WorkflowHandle<typeof approvalWorkflow>;
export type RequirementIntakeWorkflowHandle = WorkflowHandle<typeof requirementIntakeWorkflow>;
export type WorkItemPlanningWorkflowHandle = WorkflowHandle<typeof workItemPlanningWorkflow>;
export type WorkItemExecutionWorkflowHandle = WorkflowHandle<typeof workItemExecutionWorkflow>;
export type DefectReproductionWorkflowHandle = WorkflowHandle<typeof defectReproductionWorkflow>;
export type RetrospectiveWorkflowHandle = WorkflowHandle<typeof retrospectiveWorkflow>;

export function readTemporalConfig(env: TemporalEnv = process.env): TemporalConnectionConfig {
  return {
    address: env.PATCHPILOT_TEMPORAL_ADDRESS ?? defaultTemporalAddress,
    namespace: env.PATCHPILOT_TEMPORAL_NAMESPACE ?? defaultTemporalNamespace,
    taskQueue: env.PATCHPILOT_TEMPORAL_TASK_QUEUE ?? defaultTemporalTaskQueue
  };
}

export async function createTemporalClient(config = readTemporalConfig()): Promise<Client> {
  const connection = await Connection.connect({ address: config.address });
  return new Client({ connection, namespace: config.namespace });
}

export function temporalCanaryWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-canary", idempotencyKey);
}

export function approvalWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-approval", idempotencyKey);
}

export function requirementIntakeWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-requirement-intake", idempotencyKey);
}

export function workItemPlanningWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-work-item-planning", idempotencyKey);
}

export function workItemExecutionWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-work-item-execution", idempotencyKey);
}

export function defectReproductionWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-defect-reproduction", idempotencyKey);
}

export function retrospectiveWorkflowId(idempotencyKey: string): string {
  return temporalWorkflowId("patchpilot-retrospective", idempotencyKey);
}

export function temporalCanaryWorkflowStartOptions(
  input: TemporalCanaryWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof temporalCanaryWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: temporalCanaryWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export function approvalWorkflowStartOptions(
  input: ApprovalWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof approvalWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: approvalWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export function requirementIntakeWorkflowStartOptions(
  input: RequirementIntakeWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof requirementIntakeWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: requirementIntakeWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export function workItemPlanningWorkflowStartOptions(
  input: WorkItemPlanningWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof workItemPlanningWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: workItemPlanningWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export function workItemExecutionWorkflowStartOptions(
  input: WorkItemExecutionWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof workItemExecutionWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: workItemExecutionWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export function defectReproductionWorkflowStartOptions(
  input: DefectReproductionWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof defectReproductionWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: defectReproductionWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export function retrospectiveWorkflowStartOptions(
  input: RetrospectiveWorkflowInput,
  config = readTemporalConfig()
): WorkflowStartOptions<typeof retrospectiveWorkflow> {
  return {
    taskQueue: config.taskQueue,
    workflowId: retrospectiveWorkflowId(input.idempotencyKey),
    workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
    workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
    args: [input]
  };
}

export async function startTemporalCanaryWorkflow(
  client: Client,
  input: TemporalCanaryWorkflowInput,
  config = readTemporalConfig()
): Promise<TemporalCanaryWorkflowHandle> {
  const startOptions = temporalCanaryWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(temporalCanaryWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as TemporalCanaryWorkflowHandle;
    }
    throw error;
  }
}

export async function startApprovalWorkflow(
  client: Client,
  input: ApprovalWorkflowInput,
  config = readTemporalConfig()
): Promise<ApprovalWorkflowHandle> {
  const startOptions = approvalWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(approvalWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as ApprovalWorkflowHandle;
    }
    throw error;
  }
}

export async function startRequirementIntakeWorkflow(
  client: Client,
  input: RequirementIntakeWorkflowInput,
  config = readTemporalConfig()
): Promise<RequirementIntakeWorkflowHandle> {
  const startOptions = requirementIntakeWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(requirementIntakeWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as RequirementIntakeWorkflowHandle;
    }
    throw error;
  }
}

export async function startWorkItemPlanningWorkflow(
  client: Client,
  input: WorkItemPlanningWorkflowInput,
  config = readTemporalConfig()
): Promise<WorkItemPlanningWorkflowHandle> {
  const startOptions = workItemPlanningWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(workItemPlanningWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as WorkItemPlanningWorkflowHandle;
    }
    throw error;
  }
}

export async function startWorkItemExecutionWorkflow(
  client: Client,
  input: WorkItemExecutionWorkflowInput,
  config = readTemporalConfig()
): Promise<WorkItemExecutionWorkflowHandle> {
  const startOptions = workItemExecutionWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(workItemExecutionWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as WorkItemExecutionWorkflowHandle;
    }
    throw error;
  }
}

export async function startDefectReproductionWorkflow(
  client: Client,
  input: DefectReproductionWorkflowInput,
  config = readTemporalConfig()
): Promise<DefectReproductionWorkflowHandle> {
  const startOptions = defectReproductionWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(defectReproductionWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as DefectReproductionWorkflowHandle;
    }
    throw error;
  }
}

export async function startRetrospectiveWorkflow(
  client: Client,
  input: RetrospectiveWorkflowInput,
  config = readTemporalConfig()
): Promise<RetrospectiveWorkflowHandle> {
  const startOptions = retrospectiveWorkflowStartOptions(input, config);

  try {
    return await client.workflow.start(retrospectiveWorkflow, startOptions);
  } catch (error) {
    if (error instanceof WorkflowExecutionAlreadyStartedError) {
      return client.workflow.getHandle(startOptions.workflowId) as RetrospectiveWorkflowHandle;
    }
    throw error;
  }
}

export function queryTemporalCanaryProgress(handle: TemporalCanaryWorkflowHandle): Promise<TemporalCanaryProgress> {
  return handle.query(temporalCanaryProgressQuery);
}

export function queryApprovalProgress(handle: ApprovalWorkflowHandle): Promise<ApprovalWorkflowProgress> {
  return handle.query(approvalProgressQuery);
}

export function signalTemporalCanary(
  handle: TemporalCanaryWorkflowHandle,
  signal: TemporalCanarySignalInput
): Promise<void> {
  return handle.signal(approveTemporalCanarySignal, signal);
}

export function signalApprovalApprove(handle: ApprovalWorkflowHandle, signal: ApprovalSignalInput): Promise<void> {
  return handle.signal(approveApprovalSignal, signal);
}

export function signalApprovalDeny(handle: ApprovalWorkflowHandle, signal: ApprovalSignalInput): Promise<void> {
  return handle.signal(denyApprovalSignal, signal);
}

export function signalApprovalExpire(handle: ApprovalWorkflowHandle, signal: ApprovalSignalInput): Promise<void> {
  return handle.signal(expireApprovalSignal, signal);
}

export function queryRequirementIntakeProgress(
  handle: RequirementIntakeWorkflowHandle
): Promise<RequirementIntakeProgress> {
  return handle.query(requirementIntakeProgressQuery);
}

export function queryWorkItemPlanningProgress(
  handle: WorkItemPlanningWorkflowHandle
): Promise<WorkItemPlanningProgress> {
  return handle.query(workItemPlanningProgressQuery);
}

export function queryWorkItemExecutionProgress(
  handle: WorkItemExecutionWorkflowHandle
): Promise<WorkItemExecutionProgress> {
  return handle.query(workItemExecutionProgressQuery);
}

export function queryDefectReproductionProgress(
  handle: DefectReproductionWorkflowHandle
): Promise<DefectReproductionProgress> {
  return handle.query(defectReproductionProgressQuery);
}

export function queryRetrospectiveProgress(handle: RetrospectiveWorkflowHandle): Promise<RetrospectiveProgress> {
  return handle.query(retrospectiveProgressQuery);
}

export function signalRequirementClarificationAnswer(
  handle: RequirementIntakeWorkflowHandle,
  signal: RequirementClarificationAnswerSignalInput
): Promise<void> {
  return handle.signal(answerRequirementClarificationSignal, signal);
}

export function signalRequirementPrdConfirmation(
  handle: RequirementIntakeWorkflowHandle,
  signal: RequirementPrdConfirmationSignalInput
): Promise<void> {
  return handle.signal(confirmRequirementPrdSignal, signal);
}

export async function runTemporalCanaryWorkflow(
  client: Client,
  input: TemporalCanaryWorkflowInput,
  signal: TemporalCanarySignalInput,
  config = readTemporalConfig()
): Promise<TemporalCanaryWorkflowResult> {
  const handle = await startTemporalCanaryWorkflow(client, input, config);
  await signalTemporalCanary(handle, signal);
  return handle.result();
}

export async function runApprovalWorkflow(
  client: Client,
  input: ApprovalWorkflowInput,
  signal: ApprovalSignalInput,
  config = readTemporalConfig()
): Promise<ApprovalWorkflowResult> {
  const handle = await startApprovalWorkflow(client, input, config);
  await signalApprovalApprove(handle, signal);
  return handle.result();
}

export async function runRequirementIntakeWorkflow(
  client: Client,
  input: RequirementIntakeWorkflowInput,
  answer: RequirementClarificationAnswerSignalInput,
  confirmation: RequirementPrdConfirmationSignalInput,
  config = readTemporalConfig()
): Promise<RequirementIntakeWorkflowResult> {
  const handle = await startRequirementIntakeWorkflow(client, input, config);
  await signalRequirementClarificationAnswer(handle, answer);
  await signalRequirementPrdConfirmation(handle, confirmation);
  return handle.result();
}

export async function runWorkItemPlanningWorkflow(
  client: Client,
  input: WorkItemPlanningWorkflowInput,
  config = readTemporalConfig()
): Promise<WorkItemPlanningWorkflowResult> {
  const handle = await startWorkItemPlanningWorkflow(client, input, config);
  return handle.result();
}

export async function runWorkItemExecutionWorkflow(
  client: Client,
  input: WorkItemExecutionWorkflowInput,
  config = readTemporalConfig()
): Promise<WorkItemExecutionWorkflowResult> {
  const handle = await startWorkItemExecutionWorkflow(client, input, config);
  return handle.result();
}

export async function runDefectReproductionWorkflow(
  client: Client,
  input: DefectReproductionWorkflowInput,
  config = readTemporalConfig()
): Promise<DefectReproductionWorkflowResult> {
  const handle = await startDefectReproductionWorkflow(client, input, config);
  return handle.result();
}

export async function runRetrospectiveWorkflow(
  client: Client,
  input: RetrospectiveWorkflowInput,
  config = readTemporalConfig()
): Promise<RetrospectiveWorkflowResult> {
  const handle = await startRetrospectiveWorkflow(client, input, config);
  return handle.result();
}

function temporalWorkflowId(prefix: string, idempotencyKey: string): string {
  const normalized = idempotencyKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12);
  return `${prefix}-${normalized || "key"}-${digest}`;
}
