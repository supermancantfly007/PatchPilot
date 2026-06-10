import { fileURLToPath } from "node:url";
import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import { createTemporalCanaryActivities, type TemporalCanaryActivityStore } from "./activities";
import {
  defaultTemporalAddress,
  defaultTemporalNamespace,
  defaultTemporalTaskQueue,
  type TemporalConnectionConfig,
  type TemporalEnv
} from "./types";

export interface TemporalWorkerConfig extends TemporalConnectionConfig {
  reuseV8Context?: boolean;
}

export interface CreatePatchPilotTemporalWorkerOptions {
  config?: TemporalWorkerConfig;
  activityStore?: TemporalCanaryActivityStore;
  workerOptions?: Partial<WorkerOptions>;
}

export function readTemporalWorkerConfig(env: TemporalEnv = process.env): TemporalWorkerConfig {
  return {
    address: env.PATCHPILOT_TEMPORAL_ADDRESS ?? defaultTemporalAddress,
    namespace: env.PATCHPILOT_TEMPORAL_NAMESPACE ?? defaultTemporalNamespace,
    taskQueue: env.PATCHPILOT_TEMPORAL_TASK_QUEUE ?? defaultTemporalTaskQueue
  };
}

export async function createPatchPilotTemporalWorker(
  options: CreatePatchPilotTemporalWorkerOptions = {}
): Promise<Worker> {
  const config = options.config ?? readTemporalWorkerConfig();
  const connection = await NativeConnection.connect({ address: config.address });

  return Worker.create({
    connection,
    namespace: config.namespace,
    taskQueue: config.taskQueue,
    workflowsPath: fileURLToPath(new URL("./workflows.ts", import.meta.url)),
    activities: createTemporalCanaryActivities(options.activityStore),
    reuseV8Context: config.reuseV8Context ?? true,
    ...options.workerOptions
  });
}

export async function runPatchPilotTemporalWorker(config = readTemporalWorkerConfig()): Promise<void> {
  const worker = await createPatchPilotTemporalWorker({ config });
  await worker.run();
}
