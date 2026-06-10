import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { contractVersion } from "@patchpilot/contracts";
import type { AgentRun } from "@patchpilot/domain";
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
    expect(answer.json().interfaceContracts).toHaveLength(3);
    expect(answer.json().interfaceContracts.every((contract: { status: string }) => contract.status === "draft")).toBe(
      true
    );
    expect(
      answer.json().interfaceContracts.every((contract: { specMarkdown: string }) =>
        contract.specMarkdown.includes(`Contract version: \`${contractVersion}\``)
      )
    ).toBe(true);

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

  it("returns test command and preview URL overrides from .patchpilot/config.yaml", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "patchpilot-api-config-"));
    const configDir = join(fixtureRoot, ".patchpilot");
    const configPath = join(configDir, "config.yaml");
    const previousConfigPath = process.env.PATCHPILOT_CONFIG_PATH;
    const previousTestCommand = process.env.PATCHPILOT_TEST_COMMAND;
    const previousPreviewUrl = process.env.PATCHPILOT_PREVIEW_URL;
    const previousWorkspaceRoot = process.env.PATCHPILOT_WORKSPACE_ROOT;
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configPath,
      `
test:
  command: pnpm test:fixture-api
dev:
  previewUrl: http://fixture-preview.local
  workspaceRoot: .patchpilot/worktrees-from-config
`.trimStart(),
      "utf8"
    );

    const app = await buildServer();

    try {
      process.env.PATCHPILOT_CONFIG_PATH = configPath;
      delete process.env.PATCHPILOT_TEST_COMMAND;
      delete process.env.PATCHPILOT_PREVIEW_URL;
      delete process.env.PATCHPILOT_WORKSPACE_ROOT;

      const response = await app.inject({ method: "GET", url: "/api/config" });
      const config = response.json();

      expect(response.statusCode).toBe(200);
      expect(config.configSource).toBe("file");
      expect(config.configPath).toBe(configPath);
      expect(config.testCommand).toBe("pnpm test:fixture-api");
      expect(config.test.command).toBe("pnpm test:fixture-api");
      expect(config.previewUrl).toBe("http://fixture-preview.local");
      expect(config.dev.previewUrl).toBe("http://fixture-preview.local");
      expect(config.workspaceRoot).toBe(join(fixtureRoot, ".patchpilot", "worktrees-from-config"));
    } finally {
      if (previousConfigPath === undefined) delete process.env.PATCHPILOT_CONFIG_PATH;
      else process.env.PATCHPILOT_CONFIG_PATH = previousConfigPath;
      if (previousTestCommand === undefined) delete process.env.PATCHPILOT_TEST_COMMAND;
      else process.env.PATCHPILOT_TEST_COMMAND = previousTestCommand;
      if (previousPreviewUrl === undefined) delete process.env.PATCHPILOT_PREVIEW_URL;
      else process.env.PATCHPILOT_PREVIEW_URL = previousPreviewUrl;
      if (previousWorkspaceRoot === undefined) delete process.env.PATCHPILOT_WORKSPACE_ROOT;
      else process.env.PATCHPILOT_WORKSPACE_ROOT = previousWorkspaceRoot;
      await app.close();
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("streams the current run, incremental updates, and closes after a terminal status", async () => {
    const app = await buildServer();
    const previousDelayFactor = process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR;
    process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = "0.5";

    try {
      const baseUrl = await listenOnRandomPort(app);
      const run = await startSimulatedRun(app, "验证 SSE 首包、增量更新和终态关闭");

      const frames = await collectSseFrames(`${baseUrl}/api/runs/${run.id}/events`, 7000);
      const runFrames = frames.filter((frame) => frame.event === "message");
      const payloads = runFrames.map((frame) => JSON.parse(frame.data) as AgentRun);
      const firstPayload = payloads[0];
      const terminalPayload = payloads.at(-1);

      expect(firstPayload).toMatchObject({
        id: run.id,
        status: "running",
        currentStep: "understanding"
      });
      expect(firstPayload?.events).toHaveLength(1);
      expect(firstPayload?.events[0]?.type).toBe("requirement.understood");
      expect(payloads.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...payloads.map((payload) => payload.events.length))).toBeGreaterThan(1);
      expect(terminalPayload?.status).toBe("succeeded");
      expect(terminalPayload?.events.at(-1)?.type).toBe("acceptance.waiting");
    } finally {
      if (previousDelayFactor === undefined) delete process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR;
      else process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR = previousDelayFactor;
      await app.close();
    }
  });

  it("streams an SSE error envelope for a missing run and then closes", async () => {
    const app = await buildServer();

    try {
      const baseUrl = await listenOnRandomPort(app);
      const frames = await collectSseFrames(`${baseUrl}/api/runs/missing-run/events`, 2000);
      const errorFrame = frames[0];
      const payload = JSON.parse(errorFrame?.data ?? "{}") as { message?: string };

      expect(frames).toHaveLength(1);
      expect(errorFrame?.event).toBe("error");
      expect(payload.message).toContain("AgentRun not found: missing-run");
    } finally {
      await app.close();
    }
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
    expect(approval.json().interfaceContracts).toHaveLength(3);
    expect(
      approval.json().interfaceContracts.every((contract: { status: string }) => contract.status === "approved")
    ).toBe(true);
    expect(
      approval.json().interfaceContracts.every((contract: { specMarkdown: string }) =>
        contract.specMarkdown.includes(`Contract version: \`${contractVersion}\``)
      )
    ).toBe(true);

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
    expect(runningWorkItem.status).toBe("running");
    expect(runningWorkItem.assignedAgentId).toBeTruthy();

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
    expect(startTeam.json().interfaceContracts).toHaveLength(3);
    expect(
      startTeam.json().interfaceContracts.every((contract: { status: string }) => contract.status === "approved")
    ).toBe(true);
    expect(startTeam.json().workItems.map((item: { role: string }) => item.role).sort()).toEqual([
      "backend",
      "frontend",
      "ops",
      "test"
    ]);

    const completedRuns = await pollPrdRuns(app, prd.id, 4);
    expect(completedRuns.every((run: { status: string }) => run.status === "succeeded")).toBe(true);
    const evidenceSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const prdWorkspaceRuns = evidenceSnapshot
      .json()
      .workspaceRuns.filter((workspace: { prdId: string }) => workspace.prdId === prd.id);
    const prdTestRuns = evidenceSnapshot
      .json()
      .testRuns.filter((test: { prdId: string }) => test.prdId === prd.id);
    const prdTestCases = evidenceSnapshot
      .json()
      .testCases.filter((testCase: { prdId: string }) => testCase.prdId === prd.id);
    const prdPullRequests = evidenceSnapshot
      .json()
      .pullRequests.filter((pullRequest: { prdId: string }) => pullRequest.prdId === prd.id);
    const prdReviewRecords = evidenceSnapshot
      .json()
      .reviewRecords.filter((review: { prdId: string }) => review.prdId === prd.id);
    const prdAuditActions = evidenceSnapshot
      .json()
      .auditEvents.filter((event: { prdId?: string }) => event.prdId === prd.id)
      .map((event: { action: string }) => event.action);
    expect(prdWorkspaceRuns).toHaveLength(4);
    expect(prdWorkspaceRuns.every((workspace: { status: string }) => workspace.status === "archived")).toBe(true);
    expect(prdTestCases).toHaveLength(4);
    expect(prdTestCases.every((testCase: { status: string }) => testCase.status === "ready")).toBe(true);
    expect(prdTestCases.map((testCase: { workItemId: string }) => testCase.workItemId).sort()).toEqual(
      startTeam.json().workItems.map((item: { id: string }) => item.id).sort()
    );
    expect(prdTestRuns).toHaveLength(4);
    expect(prdTestRuns.every((test: { status: string }) => test.status === "passed")).toBe(true);
    expect(prdTestRuns.every((test: { testCaseId?: string }) => test.testCaseId)).toBe(true);
    expect(
      prdTestRuns.every((test: {
        runner?: string;
        environmentImage?: string;
        workspacePath?: string;
        exitCode?: number | null;
        logArtifactId?: string;
        artifactIds?: string[];
        retryCount?: number;
        flakySignal?: boolean;
      }) =>
        test.runner === "simulated-test-runner" &&
        test.environmentImage === "simulated" &&
        test.workspacePath?.startsWith("simulated://") &&
        test.exitCode === 0 &&
        Boolean(test.logArtifactId) &&
        test.artifactIds?.includes(test.logArtifactId || "") &&
        test.retryCount === 0 &&
        test.flakySignal === false
      )
    ).toBe(true);
    expect(prdPullRequests).toHaveLength(4);
    expect(
      prdPullRequests.every((pullRequest: { status: string }) => pullRequest.status === "ready_for_review")
    ).toBe(true);
    expect(prdPullRequests[0].bodyMarkdown).toContain("## 需求");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## 工作项");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## 测试结果");
    expect(prdPullRequests[0].bodyMarkdown).toContain("## Reviewer Agent 摘要");
    expect(prdReviewRecords).toHaveLength(4);
    expect(prdReviewRecords.every((review: { status: string }) => review.status === "approved")).toBe(true);
    expect(prdReviewRecords[0].summary).toContain("Reviewer agent");
    expect(prdReviewRecords[0].linkedPullRequestId).toEqual(expect.any(String));
    expect(prdReviewRecords[0].testSummary).toContain("passed");
    expect(prdAuditActions).toContain("prd.approved");
    expect(prdAuditActions).toContain("work_item.started");
    expect(prdAuditActions).toContain("test_run.passed");
    expect(prdAuditActions).toContain("review.approved");
    expect(prdAuditActions).toContain("agent_run.succeeded");
    expect(prdAuditActions).toContain("pull_request.ready_for_review");

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

  it("turns rejected team acceptance into ready rework and starts new runs", async () => {
    const app = await buildServer();
    const create = await app.inject({
      method: "POST",
      url: "/api/requirements",
      payload: { rawInput: "验证验收拒绝后 agent team 会自动返工", template: "feature" }
    });
    const requirement = create.json();
    const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
    const prd = prdResponse.json().prd;

    const firstStart = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(firstStart.statusCode).toBe(201);
    const firstRuns = await pollPrdRuns(app, prd.id, 4);
    const firstRunIds = firstRuns.map((run: { id: string }) => run.id).sort();

    const rejection = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/acceptance`,
      payload: { status: "rejected", reason: "前端状态摘要还不够清楚，需要返工。" }
    });
    expect(rejection.statusCode).toBe(200);
    expect(rejection.json().decisions).toHaveLength(4);

    const rejectedSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const reworkItems = rejectedSnapshot.json().workItems.filter((item: { prdId: string }) => item.prdId === prd.id);
    expect(reworkItems).toHaveLength(4);
    expect(reworkItems.every((item: { status: string }) => item.status === "ready")).toBe(true);
    expect(reworkItems.every((item: { assignedAgentId?: string }) => !item.assignedAgentId)).toBe(true);
    expect(reworkItems.every((item: { reworkCount?: number }) => item.reworkCount === 1)).toBe(true);

    const staleAcceptance = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/acceptance`,
      payload: { status: "accepted", reason: "误点了旧交付结果" }
    });
    expect(staleAcceptance.statusCode).toBe(409);

    const backendReworkItem = reworkItems.find((item: { role: string }) => item.role === "backend");
    if (!backendReworkItem) throw new Error("Backend rework item was not generated");
    const claim = await app.inject({
      method: "POST",
      url: `/api/work-items/${backendReworkItem.id}/claim`,
      payload: { agentId: "agent_backend" }
    });
    expect(claim.statusCode).toBe(200);
    const claimedStart = await app.inject({
      method: "POST",
      url: `/api/work-items/${backendReworkItem.id}/start`,
      payload: { runner: "simulated" }
    });
    expect(claimedStart.statusCode).toBe(201);
    expect(firstRunIds).not.toContain(claimedStart.json().id);

    const reworkStart = await app.inject({
      method: "POST",
      url: `/api/prds/${prd.id}/start-team`,
      payload: { runner: "simulated" }
    });
    expect(reworkStart.statusCode).toBe(201);
    expect(reworkStart.json().runs).toHaveLength(4);
    expect(reworkStart.json().runs.map((run: { id: string }) => run.id).sort()).not.toEqual(firstRunIds);
    await Promise.all(reworkStart.json().runs.map((run: { id: string }) => pollRun(app, run.id)));

    const reworkSnapshot = await app.inject({ method: "GET", url: "/api/snapshot" });
    const allRuns = reworkSnapshot.json().agentRuns.filter((run: { prdId: string }) => run.prdId === prd.id);
    const reworkAuditActions = reworkSnapshot
      .json()
      .auditEvents.filter((event: { prdId?: string }) => event.prdId === prd.id)
      .map((event: { action: string }) => event.action);
    expect(allRuns).toHaveLength(8);
    expect(reworkAuditActions).toContain("work_item.rework_requested");

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
    const bugTestRuns = snapshotAfterFix
      .json()
      .testRuns.filter((test: { prdId: string }) => test.prdId === bug.prdId);
    const bugAuditActions = snapshotAfterFix
      .json()
      .auditEvents.filter((event: { prdId?: string }) => event.prdId === bug.prdId)
      .map((event: { action: string }) => event.action);
    expect(fixedBug.status).toBe("fixed");
    expect(bugTestRuns).toHaveLength(2);
    expect(bugTestRuns.every((test: { status: string }) => test.status === "passed")).toBe(true);
    expect(bugAuditActions).toContain("bug.reproduced");
    expect(bugAuditActions).toContain("bug.fixed");

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
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

async function listenOnRandomPort(app: Awaited<ReturnType<typeof buildServer>>) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as AddressInfo | string | null;
  if (!address || typeof address === "string") throw new Error("Fastify did not bind to a TCP port");
  return `http://127.0.0.1:${address.port}`;
}

async function startSimulatedRun(app: Awaited<ReturnType<typeof buildServer>>, rawInput: string) {
  const create = await app.inject({
    method: "POST",
    url: "/api/requirements",
    payload: { rawInput, template: "feature" }
  });
  expect(create.statusCode).toBe(201);
  const requirement = create.json() as { id: string };

  const prdResponse = await app.inject({ method: "POST", url: `/api/requirements/${requirement.id}/prd` });
  expect(prdResponse.statusCode).toBe(200);
  const prd = prdResponse.json().prd as { id: string };

  const approval = await app.inject({ method: "POST", url: `/api/prds/${prd.id}/approve` });
  expect(approval.statusCode).toBe(200);
  const workItem = (approval.json().workItems as Array<{ id: string }>)[0];
  if (!workItem) throw new Error("Expected approved PRD to create at least one work item");

  const start = await app.inject({
    method: "POST",
    url: `/api/work-items/${workItem.id}/start`,
    payload: { runner: "simulated" }
  });
  expect(start.statusCode).toBe(201);
  return start.json() as AgentRun;
}

interface SseFrame {
  event: string;
  data: string;
  raw: string;
}

async function collectSseFrames(url: string, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (!response.body) throw new Error("SSE response did not expose a readable body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const frames: SseFrame[] = [];
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let frameEnd = buffer.indexOf("\n\n");
      while (frameEnd >= 0) {
        const raw = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd + 2);
        if (raw.trim()) frames.push(parseSseFrame(raw));
        frameEnd = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim()) frames.push(parseSseFrame(buffer));
    return frames;
  } catch (error) {
    if (timedOut) throw new Error(`Timed out waiting for SSE stream to close: ${url}`, { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseSseFrame(raw: string): SseFrame {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }

  return { event, data: dataLines.join("\n"), raw };
}
