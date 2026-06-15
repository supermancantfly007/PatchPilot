import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, httpApiContract } from "./index";

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

describe("OpenAPI document", () => {
  it("covers every HTTP contract operation", () => {
    const document = buildOpenApiDocument();

    for (const [operationId, operation] of Object.entries(httpApiContract.operations)) {
      const path = document.paths[operation.path];
      expect(path, `${operation.path} should exist`).toBeDefined();
      const method = path?.[operation.method.toLowerCase()] as { operationId?: string } | undefined;
      expect(method?.operationId).toBe(operationId);
    }
  });

  it("renders array response shorthands as arrays instead of invalid component refs", () => {
    const document = buildOpenApiDocument();
    const agentsResponse = document.paths["/api/agents"]?.get as {
      responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
    } | undefined;

    expect(agentsResponse?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/AgentProfile" }
    });
  });

  it("documents Pi runner overrides separately from auto runtime configuration", () => {
    const document = buildOpenApiDocument();
    const schemas = document.components.schemas as Record<string, {
      properties?: Record<string, { enum?: string[]; type?: string; items?: { $ref?: string }; additionalProperties?: boolean }>;
      required?: string[];
    }>;

    expect(schemas.StartRunRequest?.properties?.runner?.enum).toEqual(["codex", "pi"]);
    expect(schemas.RuntimeConfig?.properties?.configuredRunner?.enum).toEqual(["auto", "codex", "pi"]);
    expect(schemas.RuntimeConfig?.properties?.activeRunner?.enum).toEqual(["codex", "pi"]);
    expect(schemas.RuntimeConfig?.properties?.runnerAvailability).toEqual({
      type: "array",
      items: { $ref: "#/components/schemas/AgentRunnerAvailability" }
    });
    expect(schemas.AgentRunnerAvailability?.required).toEqual([
      "runner",
      "status",
      "available",
      "runnerAvailable",
      "gitWorkspaceAvailable"
    ]);
    expect(schemas.AgentRunnerAvailability?.properties?.runner?.enum).toEqual(["codex", "pi"]);
    expect(schemas.AgentRunnerAvailability?.properties?.status?.enum).toEqual(["available", "degraded", "unavailable"]);
    expect(schemas.AgentRunnerAvailability?.properties?.mode?.enum).toEqual([
      "production_enforceable",
      "local_unsafe",
      "fake",
      "preview"
    ]);
    expect(schemas.AgentRunnerAvailability?.properties?.details).toEqual({
      type: "object",
      additionalProperties: true
    });
  });

  it("documents provider-neutral AgentRun event types without dropping Codex compatibility", () => {
    const document = buildOpenApiDocument();
    const schemas = document.components.schemas as Record<string, { properties?: Record<string, { enum?: string[] }> }>;

    expect(schemas.AgentRunEvent?.properties?.type?.enum).toEqual(expectedAgentRunEventTypes);
  });

  it("matches the committed generated artifact", async () => {
    const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    const committed = await readFile(new URL("../openapi/patchpilot.openapi.json", import.meta.url), "utf8");

    expect(committed).toBe(generated);
  });
});
