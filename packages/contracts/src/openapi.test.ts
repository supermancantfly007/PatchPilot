import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, httpApiContract } from "./index";

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

  it("matches the committed generated artifact", async () => {
    const generated = `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`;
    const committed = await readFile(new URL("../openapi/patchpilot.openapi.json", import.meta.url), "utf8");

    expect(committed).toBe(generated);
  });
});
