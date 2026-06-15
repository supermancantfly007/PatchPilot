import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildRunEventSchemaDocument, runEventStreamContract } from "./index";

const expectedAgentRunEventTypes = [
  "requirement.understood",
  "plan.created",
  "workspace.created",
  "codex.started",
  "codex.output",
  "agent.started",
  "agent.output",
  "agent.tool.started",
  "agent.tool.completed",
  "agent.tool.failed",
  "agent.progress",
  "git.diff.created",
  "test.started",
  "test.passed",
  "test.failed",
  "review.completed",
  "acceptance.waiting",
  "run.failed"
];

describe("run event schema document", () => {
  it("describes the SSE channel, envelopes, terminal statuses, and compatibility rules", () => {
    const document = buildRunEventSchemaDocument();

    expect(document).toMatchObject({
      kind: "patchpilot.sse.v1",
      id: "run-events",
      channel: "/api/runs/:id/events",
      mediaType: "text/event-stream",
      envelope: {
        message: {
          event: "message",
          frame: "data: <AgentRun JSON>\\n\\n",
          payloadSchema: "AgentRun",
          requiredFields: [
            "id",
            "requirementId",
            "prdId",
            "workItemId",
            "runner",
            "status",
            "currentStep",
            "timeline",
            "events",
            "costEstimateUsd",
            "startedAt"
          ],
          optionalFields: [
            "result",
            "failureType",
            "failureSummary",
            "budgetUsd",
            "budgetSoftThresholdUsd",
            "budgetApprovalId",
            "costActualUsd",
            "endedAt"
          ]
        },
        error: {
          event: "error",
          frame: "event: error\\ndata: <RunEventError JSON>\\n\\n",
          payloadSchema: "RunEventError"
        }
      },
      terminalStatuses: ["succeeded", "failed", "cancelled"]
    });
    expect(document.compatibilityRules).toEqual([...runEventStreamContract.stream.compatibilityRules]);
    expect(document.components.schemas.AgentRun).toMatchObject({
      type: "object",
      required: [...runEventStreamContract.stream.requiredFields]
    });
    for (const field of runEventStreamContract.stream.optionalFields) {
      expect(document.components.schemas.AgentRun.required).not.toContain(field);
    }
    expect(document.components.schemas.RunEventError).toMatchObject({
      type: "object",
      required: ["message"],
      properties: {
        message: { type: "string" }
      }
    });
    expect(document.components.schemas.AgentRunResult).toMatchObject({
      required: ["summary", "previewUrl", "riskLevel", "changedFiles", "tests", "reviewerSummary", "runner"]
    });
    expect(document.components.schemas.TestRun).toMatchObject({
      required: ["id", "status", "command", "summary", "durationMs"]
    });
    expect(document.components.schemas.AgentRunEvent).toMatchObject({
      additionalProperties: false,
      required: ["id", "at", "type", "message"],
      properties: {
        type: {
          enum: expectedAgentRunEventTypes
        }
      }
    });
    expect(document.components.schemas.AgentRunEvent.properties).not.toHaveProperty("raw");
    expect(document.components.schemas.AgentRunEvent.properties).not.toHaveProperty("payload");
  });

  it("matches the committed generated artifact", async () => {
    const generated = `${JSON.stringify(buildRunEventSchemaDocument(), null, 2)}\n`;
    const committed = await readFile(new URL("../events/run-events.schema.json", import.meta.url), "utf8");

    expect(committed).toBe(generated);
  });
});
