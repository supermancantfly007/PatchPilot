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
  startTemporalCanaryWorkflow,
  startWorkItemPlanningWorkflow
} from "../packages/workflows/src/index.ts";

const config = readTemporalConfig();
const canaryIdempotencyKey = `td-204-${randomUUID()}`;
const intakeIdempotencyKey = `td-205-${randomUUID()}`;
const planningIdempotencyKey = `td-206-${randomUUID()}`;

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

  const planningHandle = await startWorkItemPlanningWorkflow(
    client,
    {
      idempotencyKey: planningIdempotencyKey,
      prd: intakeResult.prd,
      maxWorkItems: 4
    },
    config
  );
  const planningResult = await planningHandle.result();
  assertEqual(planningResult.status, "completed", "work item planning result should complete");
  assertEqual(planningResult.prdId, intakeResult.prd.id, "work item planning should expose the source PRD");
  assertBetween(planningResult.workItems.length, 1, 4, "work item planning should create 1-4 work items");
  assertEqual(
    planningResult.testCases.length,
    planningResult.workItems.length,
    "work item planning should create one TestCase per WorkItem"
  );
  assertEqual(planningResult.interfaceContracts.length, 3, "work item planning should create the contract baseline");
  assertEqual(
    new Set(planningResult.workItems.map((item) => item.id)).size,
    planningResult.workItems.length,
    "work item planning should not duplicate WorkItem ids"
  );
  if (!planningResult.workItems.every((item) => item.scope.includes("垂直切片") && item.testSuggestions.length > 0)) {
    throw new Error("planned WorkItems did not include vertical scope and test suggestions");
  }
  if (!planningResult.interfaceContracts.every((contract) => contract.status === "approved")) {
    throw new Error("planned InterfaceContracts were not approved baselines");
  }

  const planningDescription = await planningHandle.describe();
  const duplicatePlanningHandle = await startWorkItemPlanningWorkflow(
    client,
    {
      idempotencyKey: planningIdempotencyKey,
      prd: intakeResult.prd,
      maxWorkItems: 1
    },
    config
  );
  const duplicatePlanningDescription = await duplicatePlanningHandle.describe();
  assertEqual(
    duplicatePlanningDescription.runId,
    planningDescription.runId,
    "duplicate planning idempotency key should not create a second Temporal run"
  );
  const duplicatePlanningResult = await duplicatePlanningHandle.result();
  assertEqual(
    duplicatePlanningResult.workItems.length,
    planningResult.workItems.length,
    "duplicate planning start should not create a different WorkItem plan"
  );

  console.log(
    JSON.stringify(
      {
        workflowId: planningHandle.workflowId,
        runId: planningDescription.runId,
        duplicateRunId: duplicatePlanningDescription.runId,
        status: planningResult.status,
        idempotencyKey: planningResult.idempotencyKey,
        prdId: planningResult.prdId,
        workItemIds: planningResult.workItems.map((item) => item.id),
        testCaseIds: planningResult.testCases.map((testCase) => testCase.id),
        interfaceContractIds: planningResult.interfaceContracts.map((contract) => contract.id)
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

function assertBetween(actual, minimum, maximum, message) {
  if (actual < minimum || actual > maximum) {
    throw new Error(`${message}: expected ${actual} to be between ${minimum} and ${maximum}`);
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
