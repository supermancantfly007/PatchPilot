import { randomUUID } from "node:crypto";
import {
  createPatchPilotTemporalWorker,
  createTemporalClient,
  queryRequirementIntakeProgress,
  queryTemporalCanaryProgress,
  readTemporalConfig,
  signalRequirementClarificationAnswer,
  signalRequirementPrdConfirmation,
  signalTemporalCanary,
  startRequirementIntakeWorkflow,
  startTemporalCanaryWorkflow
} from "../packages/workflows/src/index.ts";

const config = readTemporalConfig();
const canaryIdempotencyKey = `td-204-${randomUUID()}`;
const intakeIdempotencyKey = `td-205-${randomUUID()}`;

const worker = await createPatchPilotTemporalWorker({ config });
const client = await createTemporalClient(config);

await worker.runUntil(async () => {
  const handle = await startTemporalCanaryWorkflow(
    client,
    {
      idempotencyKey: canaryIdempotencyKey,
      label: "TD-204 Temporal SDK acceptance",
      waitForSignal: true
    },
    config
  );

  const waiting = await waitForProgress(handle, "waiting_for_signal");
  assertEqual(waiting.status, "waiting_for_signal", "workflow should wait for signal before activity completion");
  assertEqual(waiting.idempotencyKey, canaryIdempotencyKey, "query should expose the idempotency key");

  await signalTemporalCanary(handle, {
    actor: "td-204-e2e",
    note: "release canary workflow"
  });

  const result = await handle.result();
  assertEqual(result.status, "completed", "workflow should reach terminal state");
  assertEqual(result.idempotencyKey, canaryIdempotencyKey, "activity result should preserve idempotency key");
  assertEqual(result.signal?.actor, "td-204-e2e", "activity should receive signal payload");

  const firstDescription = await handle.describe();
  const duplicateHandle = await startTemporalCanaryWorkflow(
    client,
    {
      idempotencyKey: canaryIdempotencyKey,
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

  const intakeHandle = await startRequirementIntakeWorkflow(
    client,
    {
      idempotencyKey: intakeIdempotencyKey,
      rawInput: "Implement requirement intake over Temporal with clarification signals and PRD draft generation.",
      template: "feature"
    },
    config
  );
  const clarifying = await waitForRequirementProgress(intakeHandle, "clarifying");
  assertEqual(clarifying.status, "clarifying", "requirement intake should wait for a clarification answer");
  assertEqual(clarifying.idempotencyKey, intakeIdempotencyKey, "requirement query should expose idempotency key");
  if (!clarifying.currentQuestion) throw new Error("requirement intake query did not expose a current question");

  await signalRequirementClarificationAnswer(intakeHandle, {
    actor: "td-205-e2e",
    answer: "A user can answer the current clarification question and immediately receive a PRD draft."
  });

  const awaitingConfirmation = await waitForRequirementProgress(intakeHandle, "awaiting_confirmation");
  assertEqual(
    awaitingConfirmation.status,
    "awaiting_confirmation",
    "requirement intake should generate a PRD and wait for confirmation"
  );
  if (!awaitingConfirmation.prd) throw new Error("requirement intake did not generate a PRD");
  if (!awaitingConfirmation.prd.bodyMarkdown.includes("immediately receive a PRD draft")) {
    throw new Error("generated PRD did not include the signaled clarification answer");
  }

  await signalRequirementPrdConfirmation(intakeHandle, {
    actor: "td-205-e2e",
    accepted: true,
    note: "PRD draft is ready for the next workflow"
  });
  const intakeResult = await intakeHandle.result();
  assertEqual(intakeResult.status, "completed", "requirement intake should complete after PRD confirmation");
  assertEqual(intakeResult.prd.id, awaitingConfirmation.prd.id, "completed result should keep the generated PRD");

  console.log(
    JSON.stringify(
      {
        workflowId: intakeHandle.workflowId,
        status: intakeResult.status,
        idempotencyKey: intakeResult.idempotencyKey,
        requirementId: intakeResult.requirement.id,
        prdId: intakeResult.prd.id,
        clarificationAnswerCount: intakeResult.clarificationAnswerCount
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

async function waitForRequirementProgress(handle, expectedStatus) {
  const deadline = Date.now() + 10_000;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const progress = await queryRequirementIntakeProgress(handle);
      if (progress.status === expectedStatus) return progress;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw lastError ?? new Error(`requirement intake workflow did not reach query status ${expectedStatus}`);
}
