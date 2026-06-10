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
