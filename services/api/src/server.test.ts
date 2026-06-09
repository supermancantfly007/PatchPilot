import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

describe("PatchPilot API", () => {
  it("creates a requirement and PRD draft", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "做一个白色底的 agent 平台首页", template: "ui" }
    });
    expect(create.statusCode).toBe(201);
    const requirement = create.json();

    const answer = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-answer`,
      payload: { answers: {} }
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().prd.bodyMarkdown).toContain("## 如何验收");

    await app.close();
  });

  it("rejects blank requirement input", async () => {
    const app = await buildServer();
    const response = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "   ", template: "feature" }
    });

    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 for unknown resources", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/api/runs/missing" });

    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("prevents starting the same work item twice", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "做一个端到端可用的 agent 平台", template: "feature" }
    });
    const requirement = create.json();
    const answer = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-answer`,
      payload: { answers: {} }
    });
    const prd = answer.json().prd;
    const approval = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/approve`
    });
    const workItem = approval.json().workItems[0];

    const firstStart = await app.inject({ method: "POST", url: `/api/work-items/${workItem.id}/start` });
    const secondStart = await app.inject({ method: "POST", url: `/api/work-items/${workItem.id}/start` });

    expect(firstStart.statusCode).toBe(201);
    expect(secondStart.statusCode).toBe(409);
    await app.close();
  });
});
