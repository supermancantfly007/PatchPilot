import { randomUUID } from "node:crypto";
import {
  createPatchPilotTemporalWorker,
  createTemporalClient,
  queryTemporalCanaryProgress,
  readTemporalConfig,
  signalTemporalCanary,
  startTemporalCanaryWorkflow
} from "../packages/workflows/src/index.ts";

const config = readTemporalConfig();
const idempotencyKey = `td-204-${randomUUID()}`;

const worker = await createPatchPilotTemporalWorker({ config });
const client = await createTemporalClient(config);

await worker.runUntil(async () => {
  const handle = await startTemporalCanaryWorkflow(
    client,
    {
      idempotencyKey,
      label: "TD-204 Temporal SDK acceptance",
      waitForSignal: true
    },
    config
  );

  const waiting = await waitForProgress(handle, "waiting_for_signal");
  assertEqual(waiting.status, "waiting_for_signal", "workflow should wait for signal before activity completion");
  assertEqual(waiting.idempotencyKey, idempotencyKey, "query should expose the idempotency key");

  await signalTemporalCanary(handle, {
    actor: "td-204-e2e",
    note: "release canary workflow"
  });

  const result = await handle.result();
  assertEqual(result.status, "completed", "workflow should reach terminal state");
  assertEqual(result.idempotencyKey, idempotencyKey, "activity result should preserve idempotency key");
  assertEqual(result.signal?.actor, "td-204-e2e", "activity should receive signal payload");

  const firstDescription = await handle.describe();
  const duplicateHandle = await startTemporalCanaryWorkflow(
    client,
    {
      idempotencyKey,
      label: "TD-204 Temporal SDK acceptance duplicate",
      waitForSignal: false
    },
    config
  );
  const duplicateDescription = await duplicateHandle.describe();
  assertEqual(
    duplicateDescription.runId,
    firstDescription.runId,
    "duplicate idempotency key should not create a second Temporal run after completion"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: handle.workflowId,
        runId: firstDescription.runId,
        duplicateRunId: duplicateDescription.runId,
        status: result.status,
        idempotencyKey: result.idempotencyKey
      },
      null,
      2
    )
  );
});

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function waitForProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryTemporalCanaryProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`workflow did not reach query status ${expectedStatus}`);
}
