import { pathToFileURL } from "node:url";
import {
  createPatchPilotTemporalWorker,
  readTemporalWorkerConfig,
  runPatchPilotTemporalWorker,
  type CreatePatchPilotTemporalWorkerOptions,
  type TemporalWorkerConfig
} from "@patchpilot/workflows";

export {
  createPatchPilotTemporalWorker,
  readTemporalWorkerConfig,
  runPatchPilotTemporalWorker,
  type CreatePatchPilotTemporalWorkerOptions,
  type TemporalWorkerConfig
};

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  runPatchPilotTemporalWorker().catch((error: unknown) => {
    console.error(`[temporal-worker] fatal ${formatError(error)}`);
    process.exitCode = 1;
  });
}
