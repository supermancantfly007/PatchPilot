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
  approveTemporalCanarySignal,
  temporalCanaryProgressQuery,
  temporalCanaryWorkflow
} from "./workflows";
import {
  defaultTemporalAddress,
  defaultTemporalNamespace,
  defaultTemporalTaskQueue,
  type TemporalCanaryProgress,
  type TemporalCanarySignalInput,
  type TemporalCanaryWorkflowInput,
  type TemporalCanaryWorkflowResult,
  type TemporalConnectionConfig,
  type TemporalEnv
} from "./types";

export type TemporalCanaryWorkflowHandle = WorkflowHandle<typeof temporalCanaryWorkflow>;

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
  const normalized = idempotencyKey
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  const digest = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 12);
  return `patchpilot-canary-${normalized || "key"}-${digest}`;
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

export function queryTemporalCanaryProgress(handle: TemporalCanaryWorkflowHandle): Promise<TemporalCanaryProgress> {
  return handle.query(temporalCanaryProgressQuery);
}

export function signalTemporalCanary(
  handle: TemporalCanaryWorkflowHandle,
  signal: TemporalCanarySignalInput
): Promise<void> {
  return handle.signal(approveTemporalCanarySignal, signal);
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
