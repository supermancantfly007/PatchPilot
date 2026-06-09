import { pathToFileURL } from "node:url";
import type { PatchPilotSnapshot } from "@patchpilot/domain";
import { planDispatch, type DispatchAssignment } from "./dispatch";

interface WorkerConfig {
  apiBaseUrl: string;
  intervalMs: number;
  once: boolean;
}

interface WorkerEnv {
  PATCHPILOT_API_BASE_URL?: string;
  PATCHPILOT_WORKER_INTERVAL_MS?: string;
  PATCHPILOT_WORKER_ONCE?: string;
}

const defaultApiBaseUrl = "http://localhost:4000";
const defaultIntervalMs = 5000;

export { planDispatch };
export type { DispatchAssignment };

export function readWorkerConfig(env: WorkerEnv = process.env): WorkerConfig {
  const intervalMs = Number(env.PATCHPILOT_WORKER_INTERVAL_MS ?? defaultIntervalMs);

  return {
    apiBaseUrl: trimTrailingSlash(env.PATCHPILOT_API_BASE_URL ?? defaultApiBaseUrl),
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : defaultIntervalMs,
    once: isTruthy(env.PATCHPILOT_WORKER_ONCE)
  };
}

export async function runWorker(config = readWorkerConfig()): Promise<void> {
  log(`listening ${config.apiBaseUrl} every ${config.intervalMs}ms`);

  if (config.once) {
    await runWorkerTick(config);
    return;
  }

  for (;;) {
    await runWorkerTick(config);
    await sleep(config.intervalMs);
  }
}

export async function runWorkerTick(config = readWorkerConfig()): Promise<void> {
  try {
    const snapshot = await getSnapshot(config.apiBaseUrl);
    const plan = planDispatch(snapshot);

    if (plan.length === 0) {
      log("idle");
      return;
    }

    for (const assignment of plan) {
      await dispatchAssignment(config.apiBaseUrl, assignment);
    }
  } catch (error) {
    log(`error ${formatError(error)}`);
  }
}

async function getSnapshot(apiBaseUrl: string): Promise<PatchPilotSnapshot> {
  return requestJson<PatchPilotSnapshot>(`${apiBaseUrl}/api/snapshot`, {
    method: "GET"
  });
}

async function dispatchAssignment(apiBaseUrl: string, assignment: DispatchAssignment) {
  try {
    log(`dispatch ${assignment.workItemId} -> ${assignment.agentId}`);
    await requestJson(`${apiBaseUrl}/api/work-items/${encodeURIComponent(assignment.workItemId)}/claim`, {
      method: "POST",
      body: JSON.stringify({ agentId: assignment.agentId })
    });
    await requestJson(`${apiBaseUrl}/api/work-items/${encodeURIComponent(assignment.workItemId)}/start`, {
      method: "POST",
      body: JSON.stringify({})
    });
    log(`started ${assignment.workItemId}`);
  } catch (error) {
    log(`skip ${assignment.workItemId}: ${formatError(error)}`);
  }
}

async function requestJson<T = unknown>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers
    }
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function isTruthy(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message: string) {
  console.log(`[worker] ${message}`);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runWorker().catch((error: unknown) => {
    log(`fatal ${formatError(error)}`);
    process.exitCode = 1;
  });
}
