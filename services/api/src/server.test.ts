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

  it("makes starting the same work item idempotent", async () => {
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
    expect(secondStart.statusCode).toBe(201);
    expect(secondStart.json().id).toBe(firstStart.json().id);
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runsForWorkItem = snapshot.json().agentRuns.filter((run: { workItemId: string }) => run.workItemId === workItem.id);
    expect(runsForWorkItem).toHaveLength(1);
    await pollRun(app, firstStart.json().id);
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
    const snapshotWhileRunning = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runningWorkItem = snapshotWhileRunning.json().workItems.find((item: { id: string }) => item.id === workItem.id);
    expect(runningWorkItem.assignedAgentId).toBe("agent_backend");

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
    const snapshotAfterAcceptance = await app.inject({ method: "GET", url: "/api/snapshot" });
    const doneWorkItem = snapshotAfterAcceptance.json().workItems.find((item: { id: string }) => item.id === workItem.id);
    expect(doneWorkItem.status).toBe("done");

    await app.close();
  });

  it("starts the whole agent team for a PRD", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "让前端后端测试运维 agent 一起交付一个功能", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;

    const startTeam = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(startTeam.statusCode).toBe(201);
    expect(startTeam.json().runs).toHaveLength(4);
    expect(startTeam.json().workItems.map((item: { role: string }) => item.role).sort()).toEqual([
      "backend",
      "frontend",
      "ops",
      "test"
    ]);

    const completedRuns = await pollPrdRuns(app, prd.id, 4);
    expect(completedRuns.every((run: { status: string }) => run.status === "succeeded")).toBe(true);

    const restartTeam = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(restartTeam.statusCode).toBe(201);
    expect(restartTeam.json().runs.map((run: { id: string }) => run.id).sort()).toEqual(
      completedRuns.map((run: { id: string }) => run.id).sort()
    );

    const teamAcceptance = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/acceptance`,
      payload: { status: "accepted" }
    });
    expect(teamAcceptance.statusCode).toBe(200);
    expect(teamAcceptance.json().decisions).toHaveLength(4);
    expect(teamAcceptance.json().workItems.every((item: { status: string }) => item.status === "done")).toBe(true);

    await app.close();
  });

  it("does not duplicate a run when start-team sees an already running claimed work item", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "验证 claimed 任务重复 start-team 不产生重复 run", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;
    const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
    const workItem = approval.json().workItems[0];
    await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/claim`,
      payload: { agentId: "agent_backend" }
    });
    const firstStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated" }
    });

    const teamStart = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });

    expect(teamStart.statusCode).toBe(201);
    const snapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runsForWorkItem = snapshot.json().agentRuns.filter((run: { workItemId: string }) => run.workItemId === workItem.id);
    expect(runsForWorkItem).toHaveLength(1);
    expect(runsForWorkItem[0].id).toBe(firstStart.json().id);
    await pollPrdRuns(app, prd.id, 4);
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

  it("turns a confirmed bug reproduction into a developer fix task", async () => {
    const app = await buildServer();
    const bugResponse = await app.inject({
      method: "POST",
      url: "/api/bugs",
      payload: {
        title: "保存按钮没有反馈",
        description: "点击保存后页面没有任何反馈。",
        reproductionSteps: "打开设置页，修改标题，点击保存。",
        expectedBehavior: "展示保存成功提示。",
        actualBehavior: "页面没有变化。",
        severity: "medium"
      }
    });
    const { bug, workItem } = bugResponse.json();

    const reproStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${workItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(reproStart.statusCode).toBe(201);
    const reproRun = await pollRun(app, reproStart.json().id);
    expect(reproRun.status).toBe("succeeded");

    const snapshotAfterRepro = await app.inject({ method: "GET", url: "/api/snapshot" });
    const confirmedBug = snapshotAfterRepro.json().bugs.find((item: { id: string }) => item.id === bug.id);
    const fixWorkItem = snapshotAfterRepro
      .json()
      .workItems.find((item: { sourceBugId?: string; role: string }) => item.sourceBugId === bug.id && item.role === "backend");

    expect(confirmedBug.status).toBe("confirmed");
    expect(fixWorkItem.status).toBe("ready");
    expect(fixWorkItem.title).toContain("修复 bug");

    const fixStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${fixWorkItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(fixStart.statusCode).toBe(201);
    const fixRun = await pollRun(app, fixStart.json().id);
    expect(fixRun.status).toBe("succeeded");
    expect(fixRun.result.summary).toContain("完成模拟修复");

    const snapshotAfterFix = await app.inject({ method: "GET", url: "/api/snapshot" });
    const fixedBug = snapshotAfterFix.json().bugs.find((item: { id: string }) => item.id === bug.id);
    expect(fixedBug.status).toBe("fixed");

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

async function pollPrdRuns(app: Awaited<ReturnType<typeof buildServer>>, prdId: string, expectedCount: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({ method: "GET", url: "/api/snapshot" });
    const runs = response
      .json()
      .agentRuns.filter((run: { prdId: string }) => run.prdId === prdId);
    if (
      runs.length === expectedCount &&
      runs.every((run: { status: string }) => run.status === "succeeded" || run.status === "failed")
    ) {
      return runs;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Runs did not finish for PRD: ${prdId}`);
}
