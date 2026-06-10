import { pathToFileURL } from "node:url";
import { apiPath } from "@patchpilot/contracts";
import type { AgentRunnerKind, PatchPilotSnapshot } from "@patchpilot/domain";
import { planDispatch, type DispatchAssignment } from "./dispatch";

interface WorkerConfig {
  apiBaseUrl: string;
  intervalMs: number;
  once: boolean;
  runner?: AgentRunnerKind;
  silent?: boolean;
}

export interface WorkerTickResult {
  planned: number;
  dispatched: number;
  failed: number;
  errors: string[];
}

interface WorkerTickOptions {
  throwOnError?: boolean;
}

interface WorkerEnv {
  PATCHPILOT_API_BASE_URL?: string;
  PATCHPILOT_WORKER_INTERVAL_MS?: string;
  PATCHPILOT_WORKER_ONCE?: string;
  PATCHPILOT_WORKER_RUNNER?: string;
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
    once: isTruthy(env.PATCHPILOT_WORKER_ONCE),
    runner: parseRunner(env.PATCHPILOT_WORKER_RUNNER)
  };
}

export async function runWorker(config = readWorkerConfig()): Promise<void> {
  log(config, `listening ${config.apiBaseUrl} every ${config.intervalMs}ms`);

  if (config.once) {
    await runWorkerTick(config);
    return;
  }

  for (;;) {
    await runWorkerTick(config);
    await sleep(config.intervalMs);
  }
}

export async function runWorkerTick(
  config = readWorkerConfig(),
  options: WorkerTickOptions = {}
): Promise<WorkerTickResult> {
  try {
    const snapshot = await getSnapshot(config.apiBaseUrl);
    const plan = planDispatch(snapshot);

    if (plan.length === 0) {
      log(config, "idle");
      return { planned: 0, dispatched: 0, failed: 0, errors: [] };
    }

    const result: WorkerTickResult = {
      planned: plan.length,
      dispatched: 0,
      failed: 0,
      errors: []
    };

    for (const assignment of plan) {
      const dispatched = await dispatchAssignment(config, assignment);
      if (dispatched.ok) {
        result.dispatched += 1;
      } else {
        result.failed += 1;
        result.errors.push(dispatched.error);
      }
    }

    if (options.throwOnError && result.failed > 0) {
      throw new Error(`Worker tick failed for ${result.failed}/${result.planned} assignment(s): ${result.errors.join("; ")}`);
    }

    return result;
  } catch (error) {
    const message = formatError(error);
    log(config, `error ${message}`);
    if (options.throwOnError) throw error;
    return { planned: 0, dispatched: 0, failed: 1, errors: [message] };
  }
}

async function getSnapshot(apiBaseUrl: string): Promise<PatchPilotSnapshot> {
  return requestJson<PatchPilotSnapshot>(`${apiBaseUrl}${apiPath("snapshot")}`, {
    method: "GET"
  });
}

async function dispatchAssignment(
  config: WorkerConfig,
  assignment: DispatchAssignment
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    log(config, `dispatch ${assignment.workItemId} -> ${assignment.agentId}`);
    const claim = await requestJson<{ claimToken?: string }>(
      `${config.apiBaseUrl}${apiPath("claimWorkItem", { id: assignment.workItemId })}`,
      {
        method: "POST",
        body: JSON.stringify({ agentId: assignment.agentId })
      }
    );
    await requestJson(`${config.apiBaseUrl}${apiPath("startWorkItem", { id: assignment.workItemId })}`, {
      method: "POST",
      body: JSON.stringify({
        ...(config.runner ? { runner: config.runner } : {}),
        ...(claim.claimToken ? { claimToken: claim.claimToken } : {})
      })
    });
    log(config, `started ${assignment.workItemId}`);
    return { ok: true };
  } catch (error) {
    const message = `skip ${assignment.workItemId}: ${formatError(error)}`;
    log(config, message);
    return { ok: false, error: message };
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

function parseRunner(value: string | undefined): AgentRunnerKind | undefined {
  return value === "simulated" || value === "codex" ? value : undefined;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(config: Pick<WorkerConfig, "silent">, message: string) {
  if (config.silent) return;
  console.log(`[worker] ${message}`);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runWorker().catch((error: unknown) => {
    log({ silent: false }, `fatal ${formatError(error)}`);
    process.exitCode = 1;
  });
}
