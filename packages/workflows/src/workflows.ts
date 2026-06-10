import { condition, defineQuery, defineSignal, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import type { TemporalCanaryActivities } from "./activities";
import type {
  TemporalCanaryProgress,
  TemporalCanarySignalInput,
  TemporalCanaryWorkflowInput,
  TemporalCanaryWorkflowResult
} from "./types";
import { temporalCanaryActivityOptions } from "./policies";

export const approveTemporalCanarySignal = defineSignal<[TemporalCanarySignalInput]>("approveTemporalCanary");
export const temporalCanaryProgressQuery = defineQuery<TemporalCanaryProgress>("temporalCanaryProgress");

const activities = proxyActivities<TemporalCanaryActivities>(temporalCanaryActivityOptions);

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
