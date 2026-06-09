import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AcceptanceDecision,
  type AgentProfile,
  type AgentRun,
  type AgentRunEvent,
  type AuditEvent,
  type BugReport,
  type BugSeverity,
  type PatchPilotSnapshot,
  type Requirement,
  type TestRun,
  type WorkspaceRun,
  type WorkItem,
  advanceTimeline,
  completeTimeline,
  createBugFixWorkItem,
  createBugPrd,
  createBugRequirement,
  createGrillMeQuestion,
  createInitialClarificationTurn,
  createBugWorkItem,
  createDefaultAgents,
  createInterfaceContracts,
  createPrd,
  createTimeline,
  createWorkItems,
  emptySnapshot,
  generateClarificationQuestions,
  makeSimpleSummary,
  type RuntimeConfig
} from "@patchpilot/domain";
import { isCodexAvailable, isGitWorkspaceAvailable, runCodexAgent, type RunnerEvent } from "./codexRunner";

const dataFile = join(process.env.PATCHPILOT_DATA_DIR || join(process.cwd(), "data"), "patchpilot-store.json");

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const simulationDelay = (ms: number) =>
  Math.max(0, Math.round(ms * Number(process.env.PATCHPILOT_SIMULATION_DELAY_FACTOR ?? 1)));

export class PatchPilotStore {
  private snapshot: PatchPilotSnapshot = emptySnapshot();
  private loaded = false;

  async load() {
    if (this.loaded) return;
    try {
      const raw = await readFile(dataFile, "utf8");
      this.snapshot = JSON.parse(raw) as PatchPilotSnapshot;
      this.normalizeSnapshot();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DomainError("STORE_CORRUPT", "Store file could not be read or parsed");
      }
      this.snapshot = emptySnapshot();
      await this.save();
    }
    this.loaded = true;
  }

  async getSnapshot() {
    await this.load();
    return structuredClone(this.snapshot);
  }

  async getAgents() {
    await this.load();
    return structuredClone(this.snapshot.agents);
  }

  async createRequirement(input: {
    rawInput: string;
    template: Requirement["template"];
  }) {
    await this.load();
    const now = new Date().toISOString();
    const id = `req_${randomUUID()}`;
    const requirement: Requirement = {
      id,
      title: makeSimpleSummary(input.rawInput, input.template),
      rawInput: input.rawInput,
      template: input.template,
      status: "clarifying",
      simpleSummary: makeSimpleSummary(input.rawInput, input.template),
      clarificationQuestions: generateClarificationQuestions(input.rawInput, input.template),
      clarificationTurns: [createInitialClarificationTurn(input.rawInput, input.template, now)],
      createdAt: now,
      updatedAt: now
    };

    this.snapshot.requirements.unshift(requirement);
    await this.save();
    return requirement;
  }

  async answerClarification(requirementId: string, answers: Record<string, string>) {
    await this.load();
    const requirement = this.findRequirement(requirementId);
    if (!["clarifying", "prd_draft"].includes(requirement.status)) {
      throw new DomainError("INVALID_STATE", "Requirement is not waiting for clarification");
    }
    requirement.clarificationQuestions = requirement.clarificationQuestions.map((question) => ({
      ...question,
      answer: answers[question.id] || question.recommendedAnswer
    }));
    requirement.status = "prd_draft";
    requirement.updatedAt = new Date().toISOString();

    const prd = createPrd(requirement);
    this.snapshot.prds = this.snapshot.prds.filter((item) => item.requirementId !== requirementId);
    this.snapshot.prds.unshift(prd);
    this.snapshot.interfaceContracts = [
      ...createInterfaceContracts(prd, "draft"),
      ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prd.id)
    ];
    await this.save();
    return { requirement, prd, interfaceContracts: this.snapshot.interfaceContracts.filter((item) => item.prdId === prd.id) };
  }

  async addClarificationTurn(requirementId: string, message: string) {
    await this.load();
    const requirement = this.findRequirement(requirementId);
    if (!["clarifying", "prd_draft"].includes(requirement.status)) {
      throw new DomainError("INVALID_STATE", "Requirement is not waiting for clarification");
    }
    const now = new Date().toISOString();
    requirement.clarificationTurns.push({
      id: `turn_${randomUUID()}`,
      speaker: "user",
      message,
      createdAt: now
    });

    const nextQuestion = createGrillMeQuestion(
      requirement.rawInput,
      requirement.template,
      requirement.clarificationTurns
    );
    requirement.clarificationTurns.push({
      id: `turn_${randomUUID()}`,
      speaker: "agent",
      message: nextQuestion.question,
      recommendedAnswer: nextQuestion.recommendedAnswer,
      createdAt: now
    });
    requirement.clarificationQuestions = [
      ...requirement.clarificationQuestions,
      nextQuestion
    ];
    requirement.status = "clarifying";
    requirement.updatedAt = now;
    await this.save();
    return { requirement, nextQuestion };
  }

  async createPrdFromClarification(requirementId: string) {
    await this.load();
    const requirement = this.findRequirement(requirementId);
    if (!["clarifying", "prd_draft"].includes(requirement.status)) {
      throw new DomainError("INVALID_STATE", "Requirement cannot create a PRD from its current state");
    }
    const now = new Date().toISOString();
    requirement.status = "prd_draft";
    requirement.updatedAt = now;
    const prd = createPrd(requirement);
    this.snapshot.prds = this.snapshot.prds.filter((item) => item.requirementId !== requirementId);
    this.snapshot.prds.unshift(prd);
    this.snapshot.interfaceContracts = [
      ...createInterfaceContracts(prd, "draft"),
      ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prd.id)
    ];
    await this.save();
    return { requirement, prd, interfaceContracts: this.snapshot.interfaceContracts.filter((item) => item.prdId === prd.id) };
  }

  async approvePrd(prdId: string) {
    await this.load();
    const prd = this.findPrd(prdId);
    if (prd.status === "approved") {
      const existingWorkItems = this.snapshot.workItems.filter((item) => item.prdId === prdId);
      let existingInterfaceContracts = this.snapshot.interfaceContracts.filter((item) => item.prdId === prdId);
      if (existingInterfaceContracts.length === 0) {
        existingInterfaceContracts = createInterfaceContracts(prd);
        this.snapshot.interfaceContracts = [
          ...existingInterfaceContracts,
          ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
        ];
        await this.save();
      }
      return { prd, workItems: existingWorkItems, interfaceContracts: existingInterfaceContracts };
    }
    prd.status = "approved";
    prd.approvedAt = new Date().toISOString();

    const requirement = this.findRequirement(prd.requirementId);
    requirement.status = "approved";
    requirement.updatedAt = new Date().toISOString();

    const workItems = createWorkItems(prd);
    const interfaceContracts = createInterfaceContracts(prd);
    this.snapshot.workItems = [
      ...workItems,
      ...this.snapshot.workItems.filter((item) => item.prdId !== prdId)
    ];
    this.snapshot.interfaceContracts = [
      ...interfaceContracts,
      ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
    ];
    this.addAuditEvent({
      actor: "product_agent",
      action: "prd.approved",
      targetType: "prd",
      targetId: prd.id,
      message: "PRD 已批准，工作项和接口契约已生成。",
      requirementId: prd.requirementId,
      prdId: prd.id
    });
    await this.save();
    return { prd, workItems, interfaceContracts };
  }

  async startTeam(prdId: string, runnerOverride?: AgentRun["runner"]) {
    await this.load();
    const { prd, interfaceContracts } = await this.approvePrd(prdId);
    const workItems = this.snapshot.workItems.filter((item) => item.prdId === prd.id);
    const runs: AgentRun[] = [];
    const skippedWorkItems: typeof workItems = [];

    for (const workItem of workItems) {
      if (this.canStartOrReuseRun(workItem.id, workItem.status)) {
        runs.push(await this.startRun(workItem.id, runnerOverride));
      } else {
        skippedWorkItems.push(workItem);
      }
    }

    await this.load();
    return {
      prd,
      workItems: this.snapshot.workItems.filter((item) => item.prdId === prd.id),
      interfaceContracts,
      runs,
      skippedWorkItems
    };
  }

  async createBug(input: {
    title: string;
    description: string;
    reproductionSteps: string;
    expectedBehavior: string;
    actualBehavior: string;
    severity: BugSeverity;
    reporter?: string;
  }) {
    await this.load();
    const now = new Date().toISOString();
    const bugId = `bug_${randomUUID()}`;
    const requirementId = `req_${bugId}`;
    const requirement = createBugRequirement({
      id: requirementId,
      title: input.title,
      description: input.description,
      reproductionSteps: input.reproductionSteps,
      expectedBehavior: input.expectedBehavior,
      actualBehavior: input.actualBehavior,
      now
    });
    const prd = createBugPrd(requirement, now);
    const workItem = createBugWorkItem({
      bugId,
      requirementId,
      prdId: prd.id,
      title: input.title,
      now
    });
    const bug: BugReport = {
      id: bugId,
      title: input.title,
      description: input.description,
      reproductionSteps: input.reproductionSteps,
      expectedBehavior: input.expectedBehavior,
      actualBehavior: input.actualBehavior,
      severity: input.severity,
      status: "reported",
      reporter: input.reporter?.trim() || "human",
      requirementId,
      prdId: prd.id,
      workItemId: workItem.id,
      createdAt: now,
      updatedAt: now
    };

    this.snapshot.requirements.unshift(requirement);
    this.snapshot.prds.unshift(prd);
    this.snapshot.workItems.unshift(workItem);
    this.snapshot.interfaceContracts.unshift(...createInterfaceContracts(prd));
    this.snapshot.bugs.unshift(bug);
    this.addAuditEvent({
      actor: bug.reporter,
      action: "bug.reported",
      targetType: "bug",
      targetId: bug.id,
      message: "用户提交 bug，平台已创建测试 agent 复现任务。",
      requirementId,
      prdId: prd.id,
      workItemId: workItem.id
    });
    await this.save();
    return { bug, requirement, prd, workItem };
  }

  async claimWorkItem(workItemId: string, agentId: string) {
    await this.load();
    const workItem = this.findWorkItem(workItemId);
    const agent = this.findAgent(agentId);
    if (!["ready", "blocked"].includes(workItem.status)) {
      throw new DomainError("INVALID_STATE", "Work item is not available to claim");
    }
    if (!this.agentCanClaim(agent, workItem.role)) {
      throw new DomainError("INVALID_STATE", `Agent ${agent.name} cannot claim ${workItem.role} work`);
    }

    const now = new Date().toISOString();
    workItem.status = "claimed";
    workItem.assignedAgentId = agent.id;
    workItem.claimedAt = now;
    workItem.updatedAt = now;
    agent.status = "busy";
    agent.currentWorkItemId = workItem.id;
    agent.lastSeenAt = now;

    const bug = workItem.sourceBugId
      ? this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId)
      : undefined;
    if (bug && bug.status === "reported") {
      bug.status = "confirmed";
      bug.updatedAt = now;
    }

    await this.save();
    return { workItem, agent, bug };
  }

  async releaseWorkItem(workItemId: string) {
    await this.load();
    const workItem = this.findWorkItem(workItemId);
    if (workItem.status !== "claimed") {
      throw new DomainError("INVALID_STATE", "Only claimed work items can be released");
    }

    const agent = workItem.assignedAgentId
      ? this.snapshot.agents.find((item) => item.id === workItem.assignedAgentId)
      : undefined;
    const now = new Date().toISOString();
    workItem.status = "ready";
    workItem.assignedAgentId = undefined;
    workItem.claimedAt = undefined;
    workItem.updatedAt = now;
    if (agent) {
      agent.status = "idle";
      agent.currentWorkItemId = undefined;
      agent.lastSeenAt = now;
    }
    await this.save();
    return { workItem, agent };
  }

  async getRuntimeConfig(): Promise<RuntimeConfig> {
    const codexAvailable = await isCodexAvailable();
    const gitWorkspaceAvailable = await isGitWorkspaceAvailable();
    const configuredRunner =
      process.env.PATCHPILOT_RUNNER === "codex" || process.env.PATCHPILOT_RUNNER === "simulated"
        ? process.env.PATCHPILOT_RUNNER
        : "auto";
    return {
      configuredRunner,
      activeRunner: await this.resolveRunner(undefined, { codexAvailable, gitWorkspaceAvailable }),
      codexAvailable,
      gitWorkspaceAvailable,
      testCommand: process.env.PATCHPILOT_TEST_COMMAND || "pnpm -r --if-present test",
      workspaceRoot: process.env.PATCHPILOT_WORKSPACE_ROOT || join(process.cwd(), ".patchpilot", "worktrees")
    };
  }

  async startRun(workItemId: string, runnerOverride?: AgentRun["runner"]) {
    await this.load();
    const workItem = this.findWorkItem(workItemId);
    const existingRun = this.snapshot.agentRuns.find(
      (item) => item.workItemId === workItemId && !["failed", "cancelled"].includes(item.status)
    );
    if (existingRun) {
      return existingRun;
    }
    if (!["ready", "claimed"].includes(workItem.status)) {
      throw new DomainError("INVALID_STATE", "Work item is not ready to start");
    }
    const prd = this.findPrd(workItem.prdId);
    const runner = await this.resolveRunner(runnerOverride);
    const now = new Date().toISOString();
    if (!workItem.assignedAgentId) {
      const agent = this.findAvailableAgentForRole(workItem.role);
      if (agent) {
        workItem.assignedAgentId = agent.id;
        workItem.claimedAt = now;
        agent.status = "busy";
        agent.currentWorkItemId = workItem.id;
        agent.lastSeenAt = now;
      }
    }
    workItem.status = "running";
    workItem.updatedAt = now;
    if (workItem.sourceBugId) {
      const bug = this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId);
      if (bug) {
        bug.status = workItem.role === "test" ? "confirmed" : "fixing";
        bug.updatedAt = now;
      }
    }

    const run: AgentRun = {
      id: `run_${randomUUID()}`,
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId,
      runner,
      status: "running",
      currentStep: "understanding",
      timeline: createTimeline(),
      events: [],
      costEstimateUsd: 0.42,
      startedAt: now
    };
    run.events.push(this.makeEvent("requirement.understood", "已读取需求说明，正在生成执行计划"));
    this.snapshot.agentRuns.unshift(run);
    const workspaceRun = this.createWorkspaceRun(run, workItem, now);
    this.snapshot.workspaceRuns.unshift(workspaceRun);
    this.addAuditEvent({
      actor: workItem.assignedAgentId || "scheduler",
      action: "work_item.started",
      targetType: "work_item",
      targetId: workItem.id,
      message: `${workItem.title} 已启动 agent run。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id
    });
    this.addAuditEvent({
      actor: "workspace_manager",
      action: "workspace_run.created",
      targetType: "workspace_run",
      targetId: workspaceRun.id,
      message: `已创建 ${workspaceRun.isolation === "git_worktree" ? "git worktree" : "模拟"}工作区。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id
    });
    await this.save();

    void this.executeRun(run.id);
    return run;
  }

  async acceptRun(runId: string, status: AcceptanceDecision["status"], reason?: string) {
    await this.load();
    const run = this.findRun(runId);
    if (run.status !== "succeeded") {
      throw new DomainError("INVALID_STATE", "Run is not ready for acceptance");
    }
    const workItem = this.findWorkItem(run.workItemId);
    const now = new Date().toISOString();
    const existing = this.snapshot.acceptances.find((item) => item.runId === runId);
    const decision: AcceptanceDecision = {
      runId,
      status,
      reason,
      decidedAt: now
    };
    if (existing) Object.assign(existing, decision);
    else this.snapshot.acceptances.unshift(decision);
    workItem.status = status === "accepted" ? "done" : "blocked";
    workItem.updatedAt = now;
    this.addAuditEvent({
      actor: "human",
      action: status === "accepted" ? "acceptance.accepted" : "acceptance.rejected",
      targetType: "acceptance",
      targetId: runId,
      message: status === "accepted" ? "用户接受了 agent run 结果。" : "用户要求修改 agent run 结果。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId
    });
    await this.save();
    return decision;
  }

  async acceptPrdRuns(prdId: string, status: AcceptanceDecision["status"], reason?: string) {
    await this.load();
    this.findPrd(prdId);
    const workItems = this.snapshot.workItems.filter((item) => item.prdId === prdId);
    const runsByWorkItem = new Map<string, AgentRun>();
    for (const run of this.snapshot.agentRuns.filter((item) => item.prdId === prdId)) {
      const current = runsByWorkItem.get(run.workItemId);
      if (!current || run.startedAt > current.startedAt) runsByWorkItem.set(run.workItemId, run);
    }

    if (workItems.length === 0 || runsByWorkItem.size === 0) {
      throw new DomainError("INVALID_STATE", "PRD has no runs to accept");
    }

    const notReady = workItems.filter((item) => {
      const run = runsByWorkItem.get(item.id);
      return item.status !== "done" && run?.status !== "succeeded";
    });
    if (notReady.length > 0) {
      throw new DomainError("INVALID_STATE", "Not all team runs are ready for acceptance");
    }

    const now = new Date().toISOString();
    const decisions: AcceptanceDecision[] = [];
    for (const [workItemId, run] of runsByWorkItem) {
      if (run.status !== "succeeded") continue;
      const workItem = this.findWorkItem(workItemId);
      const decision: AcceptanceDecision = {
        runId: run.id,
        status,
        reason,
        decidedAt: now
      };
      const existing = this.snapshot.acceptances.find((item) => item.runId === run.id);
      if (existing) Object.assign(existing, decision);
      else this.snapshot.acceptances.unshift(decision);
      workItem.status = status === "accepted" ? "done" : "blocked";
      workItem.updatedAt = now;
      this.addAuditEvent({
        actor: "human",
        action: status === "accepted" ? "acceptance.accepted" : "acceptance.rejected",
        targetType: "acceptance",
        targetId: run.id,
        message: status === "accepted" ? "用户接受了团队交付结果。" : "用户要求团队交付返工。",
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId,
        runId: run.id
      });
      decisions.push(decision);
    }

    await this.save();
    return {
      decisions,
      workItems: this.snapshot.workItems.filter((item) => item.prdId === prdId),
      runs: this.snapshot.agentRuns.filter((item) => item.prdId === prdId)
    };
  }

  async getRun(runId: string) {
    await this.load();
    return this.findRun(runId);
  }

  async getRequirementBundle(requirementId: string) {
    await this.load();
    const requirement = this.findRequirement(requirementId);
    const prd = this.snapshot.prds.find((item) => item.requirementId === requirementId);
    const workItems = prd ? this.snapshot.workItems.filter((item) => item.prdId === prd.id) : [];
    const interfaceContracts = prd
      ? this.snapshot.interfaceContracts.filter((item) => item.prdId === prd.id)
      : [];
    return { requirement, prd, workItems, interfaceContracts };
  }

  private async executeRun(runId: string) {
    try {
      await this.load();
      const run = this.findRun(runId);
      if (run.runner === "codex") {
        await this.executeCodexRun(runId);
        return;
      }
      await this.simulateRun(runId);
    } catch (error) {
      await this.markRunFailed(runId, error);
    }
  }

  private async executeCodexRun(runId: string) {
    await this.load();
    const run = this.findRun(runId);
    const requirement = this.findRequirement(run.requirementId);
    const prd = this.findPrd(run.prdId);
    const workItem = this.findWorkItem(run.workItemId);

    await this.appendRunEvent(runId, {
      step: "planning",
      type: "plan.created",
      message: "已确认任务上下文，准备为本地 Codex agent 创建隔离工作区"
    });

    const result = await runCodexAgent(
      { runId, requirement, prd, workItem },
      (event) => this.appendRunEvent(runId, event)
    );

    await this.load();
    const completedRun = this.findRun(runId);
    const completedWorkItem = this.findWorkItem(completedRun.workItemId);
    completedRun.status = "succeeded";
    completedRun.timeline = completeTimeline(completedRun.timeline);
    completedRun.currentStep = "confirming";
    completedRun.events.push(this.makeEvent("review.completed", "Reviewer agent 已整理执行证据，等待你确认"));
    completedRun.events.push(this.makeEvent("acceptance.waiting", "执行完成，请查看证据摘要并确认"));
    completedRun.result = result;
    completedRun.costActualUsd = 0;
    completedRun.endedAt = new Date().toISOString();
    completedWorkItem.status = "review";
    completedWorkItem.updatedAt = completedRun.endedAt;
    this.recordCompletedRunEvidence(completedRun, completedWorkItem, result.tests, completedRun.endedAt);
    this.completeAgentAssignment(completedWorkItem.id, completedRun.endedAt);
    this.completeBugIfNeeded(completedWorkItem, completedRun.endedAt);
    await this.save();
  }

  private async simulateRun(runId: string) {
    const steps: Array<{
      step: AgentRun["currentStep"];
      type: AgentRunEvent["type"];
      message: string;
      wait: number;
    }> = [
      { step: "planning", type: "plan.created", message: "已生成垂直任务计划和验收清单", wait: 900 },
      { step: "developing", type: "workspace.created", message: "已创建隔离 worktree，并开始模拟代码变更", wait: 1100 },
      { step: "developing", type: "agent.progress", message: "Agent 已完成主要实现并整理变更摘要", wait: 1100 },
      { step: "testing", type: "test.started", message: "正在运行目标测试和质量门检查", wait: 1000 },
      { step: "testing", type: "test.passed", message: "目标测试通过，未发现高风险问题", wait: 900 },
      { step: "confirming", type: "review.completed", message: "Reviewer agent 已完成审查摘要，等待你确认", wait: 800 }
    ];

    try {
      for (const item of steps) {
        await delay(simulationDelay(item.wait));
        await this.load();
        const run = this.snapshot.agentRuns.find((candidate) => candidate.id === runId);
        if (!run || run.status !== "running") return;
        run.currentStep = item.step;
        run.timeline = advanceTimeline(run.timeline, item.step);
        run.events.push(this.makeEvent(item.type, item.message));
        await this.save();
      }

      await this.load();
      const run = this.findRun(runId);
      const workItem = this.findWorkItem(run.workItemId);
      const tests: TestRun[] = [this.makeSimulatedTestRun(workItem)];
      run.status = "succeeded";
      run.timeline = completeTimeline(run.timeline);
      run.currentStep = "confirming";
      run.events.push(this.makeEvent("acceptance.waiting", "执行完成，请查看证据摘要并确认"));
      run.result = {
        summary: this.makeSimulatedSummary(workItem),
        previewUrl: "http://localhost:3000",
        riskLevel: "low",
        changedFiles: ["apps/web", "services/api", "packages/domain"],
        tests,
        reviewerSummary: this.makeSimulatedReviewerSummary(workItem),
        runner: "simulated"
      };
      run.costActualUsd = 0.38;
      run.endedAt = new Date().toISOString();
      workItem.status = "review";
      workItem.updatedAt = run.endedAt;
      this.recordCompletedRunEvidence(run, workItem, tests, run.endedAt);
      this.completeAgentAssignment(workItem.id, run.endedAt);
      this.completeBugIfNeeded(workItem, run.endedAt);
      await this.save();
    } catch (error) {
      await this.markRunFailed(runId, error);
    }
  }

  private async markRunFailed(runId: string, error: unknown) {
    await this.load();
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run) return;
    const workItem = this.snapshot.workItems.find((item) => item.id === run.workItemId);
    run.status = "failed";
    run.failureSummary = error instanceof Error ? error.message : String(error);
    run.timeline = run.timeline.map((step) =>
      step.key === run.currentStep ? { ...step, status: "failed" } : step
    );
    run.events.push(this.makeEvent("run.failed", "执行失败，已生成失败摘要"));
    run.endedAt = new Date().toISOString();
    if (workItem) workItem.status = "blocked";
    if (workItem) {
      workItem.updatedAt = run.endedAt;
      this.markWorkspaceRun(run.id, "failed", run.endedAt);
      this.addAuditEvent({
        actor: "runner",
        action: "agent_run.failed",
        targetType: "agent_run",
        targetId: run.id,
        message: run.failureSummary || "Agent run 执行失败。",
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: run.workItemId,
        runId: run.id
      });
      this.completeAgentAssignment(workItem.id, run.endedAt);
    }
    await this.save();
  }

  private async appendRunEvent(runId: string, event: RunnerEvent) {
    await this.load();
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run || run.status !== "running") return;
    if (event.step) {
      run.currentStep = event.step;
      run.timeline = advanceTimeline(run.timeline, event.step);
    }
    run.events.push(this.makeEvent(event.type, event.message));
    await this.save();
  }

  private async resolveRunner(
    override?: AgentRun["runner"],
    availability?: { codexAvailable: boolean; gitWorkspaceAvailable: boolean }
  ): Promise<AgentRun["runner"]> {
    if (override) return override;
    if (process.env.NODE_ENV === "test") return "simulated";
    const configured = process.env.PATCHPILOT_RUNNER;
    if (configured === "simulated" || configured === "codex") return configured;
    const checks = availability || {
      codexAvailable: await isCodexAvailable(),
      gitWorkspaceAvailable: await isGitWorkspaceAvailable()
    };
    return checks.codexAvailable && checks.gitWorkspaceAvailable ? "codex" : "simulated";
  }

  private findRequirement(id: string) {
    const requirement = this.snapshot.requirements.find((item) => item.id === id);
    if (!requirement) throw new DomainError("NOT_FOUND", `Requirement not found: ${id}`);
    return requirement;
  }

  private findPrd(id: string) {
    const prd = this.snapshot.prds.find((item) => item.id === id);
    if (!prd) throw new DomainError("NOT_FOUND", `PRD not found: ${id}`);
    return prd;
  }

  private findWorkItem(id: string) {
    const workItem = this.snapshot.workItems.find((item) => item.id === id);
    if (!workItem) throw new DomainError("NOT_FOUND", `WorkItem not found: ${id}`);
    return workItem;
  }

  private findAgent(id: string) {
    const agent = this.snapshot.agents.find((item) => item.id === id);
    if (!agent) throw new DomainError("NOT_FOUND", `Agent not found: ${id}`);
    return agent;
  }

  private findRun(id: string) {
    const run = this.snapshot.agentRuns.find((item) => item.id === id);
    if (!run) throw new DomainError("NOT_FOUND", `AgentRun not found: ${id}`);
    return run;
  }

  private makeEvent(type: AgentRunEvent["type"], message: string): AgentRunEvent {
    return {
      id: `evt_${randomUUID()}`,
      at: new Date().toISOString(),
      type,
      message
    };
  }

  private async save() {
    await mkdir(dirname(dataFile), { recursive: true });
    const tempFile = `${dataFile}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify(this.snapshot, null, 2));
    await rename(tempFile, dataFile);
  }

  private normalizeSnapshot() {
    const now = new Date().toISOString();
    this.snapshot.requirements ||= [];
    this.snapshot.prds ||= [];
    this.snapshot.workItems ||= [];
    this.snapshot.interfaceContracts ||= [];
    this.snapshot.agentRuns ||= [];
    this.snapshot.workspaceRuns ||= [];
    this.snapshot.testRuns ||= [];
    this.snapshot.auditEvents ||= [];
    this.snapshot.acceptances ||= [];
    this.snapshot.bugs ||= [];
    this.snapshot.agents = this.mergeDefaultAgents(this.snapshot.agents || [], now);
    this.snapshot.requirements = this.snapshot.requirements.map((item) => ({
      ...item,
      clarificationTurns:
        item.clarificationTurns && item.clarificationTurns.length > 0
          ? item.clarificationTurns
          : [createInitialClarificationTurn(item.rawInput, item.template, item.createdAt || now)]
    }));
    this.snapshot.workItems = this.snapshot.workItems.map((item) => ({
      ...item,
      role: item.role || (item.sourceBugId ? "test" : "backend"),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now
    }));
    this.rebuildAgentBusyState(now);
  }

  private mergeDefaultAgents(existing: AgentProfile[], now: string) {
    const byId = new Map(existing.map((agent) => [agent.id, agent]));
    for (const agent of createDefaultAgents(now)) {
      if (!byId.has(agent.id)) byId.set(agent.id, agent);
    }
    return [...byId.values()];
  }

  private rebuildAgentBusyState(now: string) {
    for (const agent of this.snapshot.agents) {
      if (agent.currentWorkItemId) {
        const active = this.snapshot.workItems.find(
          (item) => item.id === agent.currentWorkItemId && ["claimed", "running"].includes(item.status)
        );
        if (!active) {
          agent.status = "idle";
          agent.currentWorkItemId = undefined;
          agent.lastSeenAt = now;
        }
      }
    }
  }

  private agentCanClaim(agent: AgentProfile, role: WorkItemRole) {
    return agent.status !== "offline" && (agent.role === role || agent.role === "reviewer");
  }

  private findAvailableAgentForRole(role: WorkItemRole) {
    return (
      this.snapshot.agents.find((agent) => agent.status === "idle" && agent.role === role) ||
      this.snapshot.agents.find((agent) => agent.status === "idle" && agent.role === "reviewer")
    );
  }

  private canStartOrReuseRun(workItemId: string, status: PatchPilotSnapshot["workItems"][number]["status"]) {
    if (["ready", "claimed"].includes(status)) return true;
    const existingRun = this.snapshot.agentRuns.find(
      (item) => item.workItemId === workItemId && !["failed", "cancelled"].includes(item.status)
    );
    return Boolean(existingRun && ["running", "review", "done"].includes(status));
  }

  private completeAgentAssignment(workItemId: string, now: string) {
    const agent = this.snapshot.agents.find((item) => item.currentWorkItemId === workItemId);
    if (!agent) return;
    agent.status = "idle";
    agent.currentWorkItemId = undefined;
    agent.lastSeenAt = now;
  }

  private createWorkspaceRun(run: AgentRun, workItem: WorkItem, now: string): WorkspaceRun {
    const workspaceRoot = process.env.PATCHPILOT_WORKSPACE_ROOT || join(process.cwd(), ".patchpilot", "worktrees");
    return {
      id: `ws_${run.id}`,
      runId: run.id,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runner: run.runner,
      status: "active",
      isolation: run.runner === "codex" ? "git_worktree" : "simulated",
      path: run.runner === "codex" ? join(workspaceRoot, run.id) : `simulated://${run.id}`,
      createdAt: now,
      updatedAt: now
    };
  }

  private recordCompletedRunEvidence(run: AgentRun, workItem: WorkItem, tests: TestRun[], endedAt: string) {
    const normalizedTests = tests.map((test) => ({
      ...test,
      runId: run.id,
      prdId: run.prdId,
      workItemId: workItem.id,
      startedAt: test.startedAt || new Date(new Date(endedAt).getTime() - test.durationMs).toISOString(),
      endedAt: test.endedAt || endedAt
    }));

    if (run.result) {
      run.result.tests = normalizedTests;
    }

    const testIds = new Set(normalizedTests.map((test) => test.id));
    this.snapshot.testRuns = [
      ...normalizedTests,
      ...this.snapshot.testRuns.filter((test) => !testIds.has(test.id))
    ];
    this.markWorkspaceRun(run.id, "archived", endedAt, run.result?.workspacePath);

    for (const test of normalizedTests) {
      this.addAuditEvent({
        actor: "test_runner",
        action: `test_run.${test.status}`,
        targetType: "test_run",
        targetId: test.id,
        message: `${test.command}：${test.summary}`,
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: workItem.id,
        runId: run.id,
        createdAt: test.endedAt || endedAt
      });
    }

    this.addAuditEvent({
      actor: "reviewer_agent",
      action: "agent_run.succeeded",
      targetType: "agent_run",
      targetId: run.id,
      message: "Agent run 已完成测试和审查，等待验收。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: endedAt
    });
  }

  private markWorkspaceRun(
    runId: string,
    status: WorkspaceRun["status"],
    now: string,
    path?: string
  ) {
    let workspaceRun = this.snapshot.workspaceRuns.find((item) => item.runId === runId);
    if (!workspaceRun) {
      const run = this.snapshot.agentRuns.find((item) => item.id === runId);
      const workItem = run ? this.snapshot.workItems.find((item) => item.id === run.workItemId) : undefined;
      if (!run || !workItem) return;
      workspaceRun = this.createWorkspaceRun(run, workItem, now);
      this.snapshot.workspaceRuns.unshift(workspaceRun);
    }
    workspaceRun.status = status;
    workspaceRun.path = path || workspaceRun.path;
    workspaceRun.updatedAt = now;
    if (status === "archived") workspaceRun.archivedAt = now;
  }

  private addAuditEvent(
    input: Omit<AuditEvent, "id" | "traceId" | "createdAt"> & {
      traceId?: string;
      createdAt?: string;
    }
  ) {
    const { traceId, createdAt, ...event } = input;
    this.snapshot.auditEvents.unshift({
      id: `audit_${randomUUID()}`,
      ...event,
      traceId: traceId || input.runId || input.prdId || input.requirementId || input.targetId,
      createdAt: createdAt || new Date().toISOString()
    });
  }

  private latestRunForWorkItem(workItemId: string) {
    return this.snapshot.agentRuns
      .filter((item) => item.workItemId === workItemId)
      .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0];
  }

  private makeSimulatedTestRun(workItem: WorkItem): TestRun {
    if (workItem.sourceBugId && workItem.role === "test") {
      return {
        id: `test_${randomUUID()}`,
        status: "passed",
        command: "pnpm test -- --bug-repro",
        summary: "测试 agent 已根据复现步骤确认问题，并整理回归测试建议",
        durationMs: 1320
      };
    }

    if (workItem.sourceBugId) {
      return {
        id: `test_${randomUUID()}`,
        status: "passed",
        command: "pnpm test -- --bug-regression",
        summary: "开发修复后的回归检查通过，bug 不再复现",
        durationMs: 1760
      };
    }

    return {
      id: `test_${randomUUID()}`,
      status: "passed",
      command: "npm test --workspaces --if-present",
      summary: "领域规则和 UI smoke 检查通过",
      durationMs: 1840
    };
  }

  private makeSimulatedSummary(workItem: WorkItem) {
    if (workItem.sourceBugId && workItem.role === "test") {
      return "测试 agent 已复现 bug，记录最小复现路径，并生成开发修复任务。";
    }
    if (workItem.sourceBugId) {
      return "开发 agent 已根据复现证据完成模拟修复，回归检查通过，等待验收。";
    }
    return "已完成一次从需求确认到执行证据的模拟交付闭环。真实 CodexRunner 可以替换当前模拟 runner。";
  }

  private makeSimulatedReviewerSummary(workItem: WorkItem) {
    if (workItem.sourceBugId && workItem.role === "test") {
      return "复现证据完整，已把失败现象、期望行为和回归建议交给开发 agent。";
    }
    if (workItem.sourceBugId) {
      return "修复结果覆盖复现路径，回归检查通过，未发现高风险变更。";
    }
    return "变更符合 MVP 普通模式目标：白色底、模板入口、进度展示、完成证据和验收入口齐备。";
  }

  private completeBugIfNeeded(workItem: WorkItem, now: string) {
    if (!workItem.sourceBugId) return;
    const bug = this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId);
    if (!bug) return;
    const run = this.latestRunForWorkItem(workItem.id);
    if (workItem.role === "test") {
      bug.status = "confirmed";
      bug.updatedAt = now;
      this.ensureBugFixWorkItem(bug, workItem, now);
      this.addAuditEvent({
        actor: "test_agent",
        action: "bug.reproduced",
        targetType: "bug",
        targetId: bug.id,
        message: "测试 agent 已复现 bug，并创建开发修复任务。",
        requirementId: bug.requirementId,
        prdId: bug.prdId,
        workItemId: workItem.id,
        runId: run?.id,
        createdAt: now
      });
      return;
    }
    bug.status = "fixed";
    bug.updatedAt = now;
    this.addAuditEvent({
      actor: "backend_agent",
      action: "bug.fixed",
      targetType: "bug",
      targetId: bug.id,
      message: "开发 agent 已完成 bug 修复并通过回归检查。",
      requirementId: bug.requirementId,
      prdId: bug.prdId,
      workItemId: workItem.id,
      runId: run?.id,
      createdAt: now
    });
  }

  private ensureBugFixWorkItem(bug: BugReport, sourceWorkItem: WorkItem, now: string) {
    const existing = this.snapshot.workItems.find(
      (item) => item.sourceBugId === bug.id && item.role !== "test" && item.status !== "cancelled"
    );
    if (existing) return;

    this.snapshot.workItems.unshift(
      createBugFixWorkItem({
        bugId: bug.id,
        requirementId: bug.requirementId,
        prdId: sourceWorkItem.prdId,
        title: bug.title,
        now
      })
    );
  }
}

type WorkItemRole = PatchPilotSnapshot["workItems"][number]["role"];

export class DomainError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_STATE" | "STORE_CORRUPT",
    message: string
  ) {
    super(message);
  }
}
