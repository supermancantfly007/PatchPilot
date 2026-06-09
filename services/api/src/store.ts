import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AcceptanceDecision,
  type AgentProfile,
  type AgentRun,
  type AgentRunEvent,
  type BugReport,
  type BugSeverity,
  type PatchPilotSnapshot,
  type Requirement,
  type TestRun,
  advanceTimeline,
  completeTimeline,
  createBugPrd,
  createBugRequirement,
  createGrillMeQuestion,
  createInitialClarificationTurn,
  createBugWorkItem,
  createDefaultAgents,
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
    await this.save();
    return { requirement, prd };
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
    await this.save();
    return { requirement, prd };
  }

  async approvePrd(prdId: string) {
    await this.load();
    const prd = this.findPrd(prdId);
    if (prd.status === "approved") {
      const existingWorkItems = this.snapshot.workItems.filter((item) => item.prdId === prdId);
      return { prd, workItems: existingWorkItems };
    }
    prd.status = "approved";
    prd.approvedAt = new Date().toISOString();

    const requirement = this.findRequirement(prd.requirementId);
    requirement.status = "approved";
    requirement.updatedAt = new Date().toISOString();

    const workItems = createWorkItems(prd);
    this.snapshot.workItems = [
      ...workItems,
      ...this.snapshot.workItems.filter((item) => item.prdId !== prdId)
    ];
    await this.save();
    return { prd, workItems };
  }

  async startTeam(prdId: string, runnerOverride?: AgentRun["runner"]) {
    await this.load();
    const { prd } = await this.approvePrd(prdId);
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
    this.snapshot.bugs.unshift(bug);
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
        bug.status = "fixing";
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
    await this.save();
    return decision;
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
    return { requirement, prd, workItems };
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
      const tests: TestRun[] = [
        {
          id: `test_${randomUUID()}`,
          status: "passed",
          command: "npm test --workspaces --if-present",
          summary: "领域规则和 UI smoke 检查通过",
          durationMs: 1840
        }
      ];
      run.status = "succeeded";
      run.timeline = completeTimeline(run.timeline);
      run.currentStep = "confirming";
      run.events.push(this.makeEvent("acceptance.waiting", "执行完成，请查看证据摘要并确认"));
      run.result = {
        summary: "已完成一次从需求确认到执行证据的模拟交付闭环。真实 CodexRunner 可以替换当前模拟 runner。",
        previewUrl: "http://localhost:3000",
        riskLevel: "low",
        changedFiles: ["apps/web", "services/api", "packages/domain"],
        tests,
        reviewerSummary: "变更符合 MVP 普通模式目标：白色底、模板入口、进度展示、完成证据和验收入口齐备。",
        runner: "simulated"
      };
      run.costActualUsd = 0.38;
      run.endedAt = new Date().toISOString();
      workItem.status = "review";
      workItem.updatedAt = run.endedAt;
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
    this.snapshot.agentRuns ||= [];
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

  private completeBugIfNeeded(workItem: { sourceBugId?: string }, now: string) {
    if (!workItem.sourceBugId) return;
    const bug = this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId);
    if (!bug) return;
    bug.status = "fixed";
    bug.updatedAt = now;
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
