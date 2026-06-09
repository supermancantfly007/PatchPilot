import { describe, expect, it } from "vitest";
import { buildServer } from "./server";

process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0";
delete process.env.PATCHPILOT_RUNNER;

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

  it("returns runtime configuration for the workbench", async () => {
    const app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/api/config" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      configuredRunner: "auto",
      activeRunner: "simulated",
      testCommand: expect.any(String),
      workspaceRoot: expect.any(String)
    });
    expect(typeof response.json().codexAvailable).toBe("boolean");
    expect(typeof response.json().gitWorkspaceAvailable).toBe("boolean");
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

  it("runs the full requirement to acceptance lifecycle", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "开发一个端到端可用的 agent 平台", template: "feature" }
    });
    const requirement = create.json();

    const answer = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-answer`,
      payload: {
        answers: {
          goal: "用户可以提交需求、确认 PRD、启动 agent、查看测试证据并验收",
          scope: "先不自动合并或发布",
          acceptance: "API 生命周期完整通过"
        }
      }
    });
    const prd = answer.json().prd;

    const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
    expect(approval.statusCode).toBe(200);
    const workItem = approval.json().workItems[0];

    const start = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(start.statusCode).toBe(201);
    const run = start.json();
    expect(run.runner).toBe("simulated");

    const completedRun = await pollRun(app, run.id);
    expect(completedRun.status).toBe("succeeded");
    expect(completedRun.result.runner).toBe("simulated");
    expect(completedRun.result.tests[0].status).toBe("passed");

    const acceptance = await app.inject({
      method: "POST",
      url: `/api/acceptance/${run.id}`,
      payload: { status: "accepted" }
    });
    expect(acceptance.statusCode).toBe(200);
    expect(acceptance.json().status).toBe("accepted");

    await app.close();
  });

  it("supports grill-me style clarification turns before PRD creation", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "做一个可以分配 agent 任务的平台", template: "feature" }
    });
    const requirement = create.json();
    expect(requirement.clarificationTurns).toHaveLength(1);
    expect(requirement.clarificationTurns[0].speaker).toBe("agent");
    expect(requirement.clarificationTurns[0].recommendedAnswer).toEqual(expect.any(String));

    const turn = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirement.id}/clarification-turn`,
      payload: { message: "主要用户是项目负责人，第一版要能看任务状态和 agent 归属。" }
    });
    expect(turn.statusCode).toBe(200);
    expect(turn.json().requirement.clarificationTurns).toHaveLength(3);
    expect(turn.json().nextQuestion.recommendedAnswer).toEqual(expect.any(String));

    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    expect(prdResponse.statusCode).toBe(200);
    expect(prdResponse.json().prd.bodyMarkdown).toContain("## 澄清记录");
    expect(prdResponse.json().prd.bodyMarkdown).toContain("主要用户是项目负责人");
    await app.close();
  });

  it("creates bug work and lets the test agent claim it", async () => {
    const app = await buildServer();
    const bugResponse = await app.inject({
      method: "POST",
      url: "/api/bugs",
      payload: {
        title: "开始执行按钮没有反应",
        description: "确认 PRD 后点击开始执行没有跳转。",
        reproductionSteps: "提交需求，生成 PRD，点击开始执行。",
        expectedBehavior: "页面跳转到执行进度页。",
        actualBehavior: "停留在确认页。",
        severity: "high"
      }
    });
    expect(bugResponse.statusCode).toBe(201);
    const { bug, workItem } = bugResponse.json();
    expect(bug.status).toBe("reported");
    expect(workItem.role).toBe("test");
    expect(workItem.sourceBugId).toBe(bug.id);

    const claim = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/claim`,
      payload: { agentId: "agent_test" }
    });
    expect(claim.statusCode).toBe(200);
    expect(claim.json().workItem.status).toBe("claimed");
    expect(claim.json().agent.status).toBe("busy");
    expect(claim.json().bug.status).toBe("confirmed");

    await app.close();
  });
});

async function pollRun(app: Awaited<ReturnType<typeof buildServer>>, runId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: "GET", url: `/api/runs/${runId}` });
    const run = response.json();
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Run did not finish: ${runId}`);
}
