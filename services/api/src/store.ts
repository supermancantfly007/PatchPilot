import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createArtifactStore,
  type ArtifactStore
} from "@patchpilot/artifacts";
import {
  type AcceptanceDecision,
  type ApprovalRecord,
  type AgentProfile,
  type AgentRun,
  type AgentRunDiffSummary,
  type AgentRunEvent,
  type ArtifactRecord,
  type AuditEvent,
  type BugReport,
  type BugSeverity,
  type BugStatus,
  type FailureType,
  type PatchPilotSnapshot,
  type PullRequestRecord,
  type Requirement,
  type ReviewRecord,
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
  createPrd,
  createTestCasesForWorkItems,
  createTimeline,
  createWorkItems,
  emptySnapshot,
  generateClarificationQuestions,
  makeSimpleSummary,
  testCaseStatusFromTestRunStatus,
  type RuntimeConfig
} from "@patchpilot/domain";
import { createInterfaceContracts } from "@patchpilot/contracts";
import {
  CodexRunError,
  LocalCodexRunner,
  classifyFailureMessage,
  type CodexRunner,
  type CodexRunnerEvent
} from "@patchpilot/codex-runner";
import { readPatchPilotConfig } from "./config";

const defaultDataFile = join(process.env.PATCHPILOT_DATA_DIR || join(process.cwd(), "data"), "patchpilot-store.json");

const defaultClaimLeaseMs = 5 * 60 * 1000;
const defaultRunCostEstimateUsd = 0.42;
const budgetApprovalTtlMs = 24 * 60 * 60 * 1000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const simulationDelay = (ms: number) =>
  Math.max(0, Math.round(ms * readPatchPilotConfig().dev.simulationDelayFactor));
const failureTypes = new Set<FailureType>([
  "transient",
  "deterministic",
  "test_failed",
  "policy_denied",
  "budget_exhausted",
  "environment_failed"
]);

type BudgetScopeType = "agent_run" | "work_item" | "prd";

interface BudgetScopeCheck {
  type: BudgetScopeType;
  limitUsd: number;
  spentUsd: number;
  nextSpendUsd: number;
}

interface BudgetCheckResult {
  effectiveBudgetUsd?: number;
  effectiveSoftThresholdUsd?: number;
  hardExceeded: BudgetScopeCheck[];
  softExceeded: BudgetScopeCheck[];
}

interface RunFailureDetails {
  failureType: FailureType;
  failureSummary: string;
  testRun?: TestRun;
}

export class PatchPilotStore {
  private snapshot: PatchPilotSnapshot = emptySnapshot();
  private loaded = false;
  private readonly codexRunner: CodexRunner;
  private readonly artifactStore?: ArtifactStore;
  private readonly dataFilePath: string | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(options: { codexRunner?: CodexRunner; dataFilePath?: string | false; artifactStore?: ArtifactStore } = {}) {
    this.codexRunner = options.codexRunner ?? new LocalCodexRunner();
    this.artifactStore = options.artifactStore;
    this.dataFilePath =
      options.dataFilePath === false
        ? undefined
        : options.dataFilePath ?? (process.env.NODE_ENV === "test" ? undefined : defaultDataFile);
  }

  async load() {
    if (this.loaded) return;
    if (!this.dataFilePath) {
      this.normalizeSnapshot();
      this.loaded = true;
      return;
    }
    try {
      const raw = await readFile(this.dataFilePath, "utf8");
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
    if (this.expireOverdueApprovals()) await this.save();
    return structuredClone(this.snapshot);
  }

  async getAgents() {
    await this.load();
    return structuredClone(this.snapshot.agents);
  }

  async createApproval(
    input: Pick<
      ApprovalRecord,
      | "kind"
      | "targetType"
      | "targetId"
      | "requestedBy"
      | "requestedReason"
      | "riskLevel"
      | "expiresAt"
      | "requirementId"
      | "prdId"
      | "workItemId"
      | "runId"
    >
  ) {
    return this.withMutation(async () => {
      await this.load();
      const now = new Date().toISOString();
      this.expireOverdueApprovals(now);
      const approval = this.createApprovalRecord(input, now);
      await this.save();
      return structuredClone(approval);
    });
  }

  async approveApproval(id: string, input: { decidedBy: string; decisionReason: string }) {
    return this.decideApproval(id, "approved", input);
  }

  async denyApproval(id: string, input: { decidedBy: string; decisionReason: string }) {
    return this.decideApproval(id, "denied", input);
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
    this.applyConfiguredBudgets(prd);
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
    this.applyConfiguredBudgets(prd);
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
      this.applyConfiguredBudgets(prd, existingWorkItems);
      let existingInterfaceContracts = this.snapshot.interfaceContracts.filter((item) => item.prdId === prdId);
      if (existingInterfaceContracts.length === 0) {
        existingInterfaceContracts = createInterfaceContracts(prd);
        this.snapshot.interfaceContracts = [
          ...existingInterfaceContracts,
          ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
        ];
        await this.save();
      }
      const existingTestCases = this.ensureTestCasesForWorkItems(prd, existingWorkItems);
      await this.save();
      return { prd, workItems: existingWorkItems, interfaceContracts: existingInterfaceContracts, testCases: existingTestCases };
    }
    prd.status = "approved";
    prd.approvedAt = new Date().toISOString();

    const requirement = this.findRequirement(prd.requirementId);
    requirement.status = "approved";
    requirement.updatedAt = new Date().toISOString();

    const workItems = createWorkItems(prd);
    this.applyConfiguredBudgets(prd, workItems);
    const interfaceContracts = createInterfaceContracts(prd);
    const testCases = createTestCasesForWorkItems(prd, workItems);
    this.snapshot.workItems = [
      ...workItems,
      ...this.snapshot.workItems.filter((item) => item.prdId !== prdId)
    ];
    this.snapshot.interfaceContracts = [
      ...interfaceContracts,
      ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
    ];
    this.snapshot.testCases = [
      ...testCases,
      ...this.snapshot.testCases.filter((item) => item.prdId !== prdId)
    ];
    this.addAuditEvent({
      actor: "product_agent",
      action: "prd.approved",
      targetType: "prd",
      targetId: prd.id,
      message: "PRD 已批准，工作项、接口契约和测试用例已生成。",
      requirementId: prd.requirementId,
      prdId: prd.id
    });
    await this.save();
    return { prd, workItems, interfaceContracts, testCases };
  }

  async startTeam(prdId: string, runnerOverride?: AgentRun["runner"]) {
    await this.load();
    const { prd, interfaceContracts } = await this.approvePrd(prdId);
    const workItems = this.snapshot.workItems.filter((item) => item.prdId === prd.id);
    const runs: AgentRun[] = [];
    const skippedWorkItems: typeof workItems = [];

    for (const workItem of workItems) {
      if (this.canStartOrReuseRun(workItem.id, workItem.status)) {
        runs.push(await this.startRun(workItem.id, runnerOverride, { claimToken: workItem.claimToken }));
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
    this.applyConfiguredBudgets(prd, [workItem]);
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
    this.snapshot.testCases.unshift(...createTestCasesForWorkItems(prd, [workItem], now));
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

  async claimWorkItem(workItemId: string, agentId: string, options: { leaseDurationMs?: number } = {}) {
    return this.withMutation(async () => {
      await this.load();
      const workItem = this.findWorkItem(workItemId);
      const agent = this.findAgent(agentId);
      const now = new Date().toISOString();
      const expiredClaim = workItem.status === "claimed" && this.isClaimExpired(workItem, now);
      if (!["ready", "blocked"].includes(workItem.status) && !expiredClaim) {
        throw new DomainError("INVALID_STATE", "Work item is not available to claim");
      }
      if (!this.agentCanClaim(agent, workItem.role)) {
        throw new DomainError("INVALID_STATE", `Agent ${agent.name} cannot claim ${workItem.role} work`);
      }
      if (agent.status === "busy" && agent.currentWorkItemId && agent.currentWorkItemId !== workItem.id) {
        throw new DomainError("INVALID_STATE", `Agent ${agent.name} is already assigned to another work item`);
      }

      if (expiredClaim && workItem.assignedAgentId && workItem.assignedAgentId !== agent.id) {
        this.releaseAgentAssignment(workItem.assignedAgentId, now);
      }

      const claimToken = randomUUID();
      const leaseDurationMs = options.leaseDurationMs ?? defaultClaimLeaseMs;
      workItem.status = "claimed";
      workItem.assignedAgentId = agent.id;
      workItem.claimedAt = now;
      workItem.claimToken = claimToken;
      workItem.leaseExpiresAt = new Date(Date.parse(now) + leaseDurationMs).toISOString();
      workItem.heartbeatAt = now;
      workItem.version = (workItem.version ?? 0) + 1;
      workItem.updatedAt = now;
      agent.status = "busy";
      agent.currentWorkItemId = workItem.id;
      agent.lastSeenAt = now;

      const bug = workItem.sourceBugId
        ? this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId)
        : undefined;
      if (bug && workItem.role === "test" && bug.status === "reported") {
        bug.status = "needs_repro";
        bug.updatedAt = now;
      }

      this.addAuditEvent({
        actor: agent.id,
        action: "work_item.claimed",
        targetType: "work_item",
        targetId: workItem.id,
        message: `${agent.name} 已领取 ${workItem.title}，lease 到期时间 ${workItem.leaseExpiresAt}。`,
        prdId: workItem.prdId,
        workItemId: workItem.id,
        createdAt: now
      });

      await this.save();
      return { workItem, agent, bug, claimToken, leaseExpiresAt: workItem.leaseExpiresAt };
    });
  }

  async releaseWorkItem(workItemId: string, options: { claimToken?: string } = {}) {
    return this.withMutation(async () => {
      await this.load();
      const workItem = this.findWorkItem(workItemId);
      if (workItem.status !== "claimed") {
        throw new DomainError("INVALID_STATE", "Only claimed work items can be released");
      }
      this.assertClaimToken(workItem, options.claimToken);

      const agent = workItem.assignedAgentId
        ? this.snapshot.agents.find((item) => item.id === workItem.assignedAgentId)
        : undefined;
      const now = new Date().toISOString();
      workItem.status = "ready";
      this.clearClaim(workItem);
      workItem.version = (workItem.version ?? 0) + 1;
      workItem.updatedAt = now;
      if (agent) {
        agent.status = "idle";
        agent.currentWorkItemId = undefined;
        agent.lastSeenAt = now;
      }
      this.addAuditEvent({
        actor: agent?.id || "scheduler",
        action: "work_item.released",
        targetType: "work_item",
        targetId: workItem.id,
        message: `${workItem.title} 已释放回 ready 队列。`,
        prdId: workItem.prdId,
        workItemId: workItem.id,
        createdAt: now
      });
      await this.save();
      return { workItem, agent };
    });
  }

  async getRuntimeConfig(): Promise<RuntimeConfig> {
    const config = readPatchPilotConfig();
    const codexAvailable = await this.codexRunner.isAvailable();
    const gitWorkspaceAvailable = await this.codexRunner.isGitWorkspaceAvailable();
    return {
      configuredRunner: config.dev.runner,
      activeRunner: await this.resolveRunner(undefined, { codexAvailable, gitWorkspaceAvailable }),
      codexAvailable,
      gitWorkspaceAvailable,
      testCommand: config.test.command,
      workspaceRoot: config.dev.workspaceRoot,
      previewUrl: config.dev.previewUrl,
      configSource: config.configSource,
      configPath: config.configPath,
      setup: config.setup,
      test: config.test,
      smoke: config.smoke,
      e2e: config.e2e,
      dev: config.dev,
      security: config.security,
      budget: config.budget,
      artifacts: {
        provider: config.artifacts.provider,
        ...(config.artifacts.provider === "local_fs" ? { localRoot: config.artifacts.localRoot } : {}),
        ...(config.artifacts.provider === "s3"
          ? {
              s3: {
                endpoint: config.artifacts.s3.endpoint,
                region: config.artifacts.s3.region,
                bucket: config.artifacts.s3.bucket,
                forcePathStyle: config.artifacts.s3.forcePathStyle,
                prefix: config.artifacts.s3.prefix
              }
            }
          : {})
      }
    };
  }

  async startRun(
    workItemId: string,
    runnerOverride?: AgentRun["runner"],
    options: { claimToken?: string } = {}
  ) {
    return this.withMutation(async () => {
      await this.load();
      const workItem = this.findWorkItem(workItemId);
      const existingRun = this.snapshot.agentRuns.find(
        (item) => item.workItemId === workItemId && !["failed", "cancelled"].includes(item.status)
      );
      if (existingRun && !this.shouldStartReworkRun(workItem, existingRun)) {
        return existingRun;
      }
      if (!["ready", "claimed"].includes(workItem.status)) {
        throw new DomainError("INVALID_STATE", "Work item is not ready to start");
      }
      const prd = this.findPrd(workItem.prdId);
      const runner = await this.resolveRunner(runnerOverride);
      const now = new Date().toISOString();
      const budgetConfig = readPatchPilotConfig().budget;
      this.applyConfiguredBudgets(prd, [workItem], budgetConfig);
      const budgetCheck = this.evaluateBudget(prd, workItem, defaultRunCostEstimateUsd, budgetConfig);
      const needsBudgetApproval = budgetCheck.hardExceeded.length > 0;

      if (workItem.status === "claimed") {
        if (this.isClaimExpired(workItem, now)) {
          if (workItem.assignedAgentId) this.releaseAgentAssignment(workItem.assignedAgentId, now);
          this.clearClaim(workItem);
        } else {
          this.assertClaimToken(workItem, options.claimToken);
        }
      }

      if (!workItem.assignedAgentId) {
        const agent = this.findAvailableAgentForRole(workItem.role);
        if (agent) {
          workItem.assignedAgentId = agent.id;
          workItem.claimedAt = now;
          workItem.claimToken = randomUUID();
          agent.status = "busy";
          agent.currentWorkItemId = workItem.id;
          agent.lastSeenAt = now;
        }
      }
      if (workItem.assignedAgentId) {
        workItem.heartbeatAt = now;
        workItem.leaseExpiresAt = new Date(Date.parse(now) + defaultClaimLeaseMs).toISOString();
      }
      const runActor = workItem.assignedAgentId || "scheduler";
      workItem.status = needsBudgetApproval ? "blocked" : "running";
      workItem.version = (workItem.version ?? 0) + 1;
      workItem.updatedAt = now;
      if (!needsBudgetApproval && workItem.sourceBugId) {
        const bug = this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId);
        if (bug) {
          bug.status = workItem.role === "test" ? "needs_repro" : "fixing";
          bug.updatedAt = now;
        }
      }

      const run: AgentRun = {
        id: `run_${randomUUID()}`,
        requirementId: prd.requirementId,
        prdId: prd.id,
        workItemId,
        runner,
        status: needsBudgetApproval ? "needs_approval" : "running",
        currentStep: "understanding",
        timeline: createTimeline(),
        events: [],
        ...(budgetCheck.effectiveBudgetUsd !== undefined ? { budgetUsd: budgetCheck.effectiveBudgetUsd } : {}),
        ...(budgetCheck.effectiveSoftThresholdUsd !== undefined
          ? { budgetSoftThresholdUsd: budgetCheck.effectiveSoftThresholdUsd }
          : {}),
        costEstimateUsd: defaultRunCostEstimateUsd,
        startedAt: now
      };
      run.events.push(this.makeEvent("requirement.understood", "已读取需求说明，正在生成执行计划"));
      this.snapshot.agentRuns.unshift(run);

      if (needsBudgetApproval) {
        run.events.push(this.makeEvent("agent.progress", "预算硬阈值已触发，run 暂停等待审批"));
        const approval = this.createBudgetApproval(run, budgetCheck, now);
        run.budgetApprovalId = approval.id;
        this.addBudgetExceededAudit(run, budgetCheck, runActor, now);
        if (workItem.assignedAgentId) this.releaseAgentAssignment(workItem.assignedAgentId, now);
        this.clearClaim(workItem);
        await this.save();
        return run;
      }

      this.addBudgetSoftThresholdAudits(run, budgetCheck, runActor, now);
      const workspaceRun = this.createWorkspaceRun(run, workItem, now);
      this.snapshot.workspaceRuns.unshift(workspaceRun);
      this.addAuditEvent({
        actor: runActor,
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
    });
  }

  async acceptRun(runId: string, status: AcceptanceDecision["status"], reason?: string) {
    await this.load();
    const run = this.findRun(runId);
    if (run.status !== "succeeded") {
      throw new DomainError("INVALID_STATE", "Run is not ready for acceptance");
    }
    const workItem = this.findWorkItem(run.workItemId);
    const existing = this.snapshot.acceptances.find((item) => item.runId === runId);
    if (existing?.status === "rejected") {
      throw new DomainError("INVALID_STATE", "Run was rejected and needs a new rework run");
    }
    const now = new Date().toISOString();
    const decision: AcceptanceDecision = {
      runId,
      status,
      reason,
      decidedAt: now
    };
    if (existing) Object.assign(existing, decision);
    else this.snapshot.acceptances.unshift(decision);
    if (status === "accepted") {
      workItem.status = "done";
      workItem.updatedAt = now;
    } else {
      this.requestWorkItemRework(workItem, run, reason, now);
    }
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
      return item.status !== "done" && (item.status !== "review" || run?.status !== "succeeded" || this.isRunRejected(run.id));
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
      if (status === "accepted") {
        workItem.status = "done";
        workItem.updatedAt = now;
      } else {
        this.requestWorkItemRework(workItem, run, reason, now);
      }
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

    const result = await this.codexRunner.run(
      { runId, requirement, prd, workItem },
      (event) => this.appendRunEvent(runId, event),
      readPatchPilotConfig()
    );

    await this.load();
    const completedRun = this.findRun(runId);
    const completedWorkItem = this.findWorkItem(completedRun.workItemId);
    completedRun.timeline = completeTimeline(completedRun.timeline);
    completedRun.currentStep = "confirming";
    completedRun.events.push(this.makeEvent("review.completed", "Reviewer agent 已整理执行证据，等待你确认"));
    completedRun.events.push(this.makeEvent("acceptance.waiting", "执行完成，请查看证据摘要并确认"));
    completedRun.result = result;
    completedRun.costActualUsd = 0;
    completedRun.endedAt = new Date().toISOString();
    completedWorkItem.status = "review";
    completedWorkItem.updatedAt = completedRun.endedAt;
    await this.recordCompletedRunEvidence(completedRun, completedWorkItem, result.tests, completedRun.endedAt, "succeeded");
    completedRun.status = "succeeded";
    this.completeAgentAssignment(completedWorkItem.id, completedRun.endedAt);
    this.completeBugIfNeeded(completedWorkItem, completedRun.endedAt);
    await this.save();
  }

  private async simulateRun(runId: string) {
    const simulatedFailureType = parseFailureType(process.env.PATCHPILOT_SIMULATED_FAILURE_TYPE);
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
      ...(simulatedFailureType
        ? []
        : [
            { step: "testing", type: "test.passed", message: "目标测试通过，未发现高风险问题", wait: 900 },
            { step: "confirming", type: "review.completed", message: "Reviewer agent 已完成审查摘要，等待你确认", wait: 800 }
          ] satisfies Array<{
            step: AgentRun["currentStep"];
            type: AgentRunEvent["type"];
            message: string;
            wait: number;
          }>)
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
      if (simulatedFailureType) {
        const testRun = simulatedFailureType === "test_failed"
          ? this.makeSimulatedFailedTestRun(run, workItem)
          : undefined;
        throw createRunFailureError(
          `模拟 ${failureTypeLabel(simulatedFailureType)} 失败${testRun ? `：${testRun.summary}` : ""}`,
          simulatedFailureType,
          testRun
        );
      }
      const tests: TestRun[] = [this.makeSimulatedTestRun(workItem)];
      const changedFiles = ["apps/web", "services/api", "packages/domain"];
      run.timeline = completeTimeline(run.timeline);
      run.currentStep = "confirming";
      run.events.push(this.makeEvent("acceptance.waiting", "执行完成，请查看证据摘要并确认"));
      run.result = {
        summary: this.makeSimulatedSummary(workItem),
        previewUrl: "http://localhost:3000",
        riskLevel: "low",
        changedFiles,
        tests,
        reviewerSummary: this.makeSimulatedReviewerSummary(workItem),
        runner: "simulated",
        agentMessages: ["模拟 agent 已完成实现摘要、测试证据和交付记录整理。"],
        reasoningSummaries: ["模拟 runner 按 PRD 验收标准生成垂直交付证据。"],
        toolCalls: [
          {
            id: `tool_simulated_${run.id}`,
            name: "simulated_delivery",
            status: "completed",
            summary: "模拟生成代码变更、测试运行和 review 证据"
          }
        ],
        diffSummary: buildRunDiffSummary(changedFiles),
        testOutputSummary: summarizeRunTestOutput(tests)
      };
      run.costActualUsd = 0.38;
      run.endedAt = new Date().toISOString();
      workItem.status = "review";
      workItem.updatedAt = run.endedAt;
      await this.recordCompletedRunEvidence(run, workItem, tests, run.endedAt, "succeeded");
      run.status = "succeeded";
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
    const failure = extractRunFailureDetails(error);
    const endedAt = new Date().toISOString();
    run.failureType = failure.failureType;
    run.failureSummary = failure.failureSummary;
    run.timeline = run.timeline.map((step) =>
      step.key === run.currentStep ? { ...step, status: "failed" } : step
    );
    run.events.push(this.makeEvent("run.failed", `执行失败，已分类为 ${failureTypeLabel(failure.failureType)}`));
    run.endedAt = endedAt;
    if (workItem) {
      const failedTests = failure.testRun
        ? await this.recordRunTestEvidence(run, workItem, [failure.testRun], endedAt, {
            workspaceStatus: "failed",
            finalRunStatus: "failed"
          })
        : [];
      if (failedTests.length === 0) this.markWorkspaceRun(run.id, "failed", endedAt);
      this.recordFailureDefect(run, workItem, failure, failedTests[0], endedAt);
      this.addAuditEvent({
        actor: "runner",
        action: "agent_run.failed",
        targetType: "agent_run",
        targetId: run.id,
        message: `${failureTypeLabel(failure.failureType)}：${run.failureSummary || "Agent run 执行失败。"}`,
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: run.workItemId,
        runId: run.id
      });
      this.completeAgentAssignment(workItem.id, endedAt);
      workItem.status = "blocked";
      workItem.updatedAt = endedAt;
    }
    run.status = "failed";
    await this.save();
  }

  private async appendRunEvent(runId: string, event: CodexRunnerEvent) {
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
    const configured = readPatchPilotConfig().dev.runner;
    if (configured === "simulated" || configured === "codex") return configured;
    const checks = availability || {
      codexAvailable: await this.codexRunner.isAvailable(),
      gitWorkspaceAvailable: await this.codexRunner.isGitWorkspaceAvailable()
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

  private findApproval(id: string) {
    const approval = this.snapshot.approvals.find((item) => item.id === id);
    if (!approval) throw new DomainError("NOT_FOUND", `Approval not found: ${id}`);
    return approval;
  }

  private makeEvent(type: AgentRunEvent["type"], message: string): AgentRunEvent {
    return {
      id: `evt_${randomUUID()}`,
      at: new Date().toISOString(),
      type,
      message
    };
  }

  private createApprovalRecord(
    input: Pick<
      ApprovalRecord,
      | "kind"
      | "targetType"
      | "targetId"
      | "requestedBy"
      | "requestedReason"
      | "riskLevel"
      | "expiresAt"
      | "requirementId"
      | "prdId"
      | "workItemId"
      | "runId"
    >,
    now: string
  ) {
    const isExpired = this.isApprovalExpired(input.expiresAt, now);
    const approval: ApprovalRecord = {
      id: `approval_${randomUUID()}`,
      ...input,
      status: isExpired ? "expired" : "pending",
      ...(isExpired ? {
        decisionReason: "Approval expired before a decision was recorded.",
        decidedAt: now
      } : {}),
      createdAt: now,
      updatedAt: now
    };

    this.snapshot.approvals.unshift(approval);
    this.addAuditEvent({
      actor: input.requestedBy,
      action: "approval.requested",
      targetType: "approval",
      targetId: approval.id,
      message: `已请求 ${approval.kind} 审批：${approval.requestedReason}`,
      requirementId: approval.requirementId,
      prdId: approval.prdId,
      workItemId: approval.workItemId,
      runId: approval.runId,
      createdAt: now
    });
    if (isExpired) this.addApprovalExpiredAudit(approval, now);
    return approval;
  }

  private async decideApproval(
    id: string,
    status: Extract<ApprovalRecord["status"], "approved" | "denied">,
    input: { decidedBy: string; decisionReason: string }
  ) {
    return this.withMutation(async () => {
      await this.load();
      const now = new Date().toISOString();
      this.expireOverdueApprovals(now);
      const approval = this.findApproval(id);
      if (approval.status !== "pending") {
        throw new DomainError("INVALID_STATE", `Approval is already ${approval.status}`);
      }

      approval.status = status;
      approval.decisionReason = input.decisionReason;
      approval.decidedAt = now;
      approval.updatedAt = now;
      if (status === "approved") approval.approvedBy = input.decidedBy;
      else approval.deniedBy = input.decidedBy;

      this.addAuditEvent({
        actor: input.decidedBy,
        action: status === "approved" ? "approval.approved" : "approval.denied",
        targetType: "approval",
        targetId: approval.id,
        message: status === "approved" ? "审批已批准。" : "审批已拒绝。",
        requirementId: approval.requirementId,
        prdId: approval.prdId,
        workItemId: approval.workItemId,
        runId: approval.runId
      });

      const resumeRunId =
        status === "approved"
          ? this.resumeBudgetGatedRun(approval, input.decidedBy, now)
          : this.recordBudgetApprovalDenied(approval, input.decidedBy, now);
      const output = structuredClone(approval);
      await this.save();
      if (resumeRunId) void this.executeRun(resumeRunId);
      return output;
    });
  }

  private resumeBudgetGatedRun(approval: ApprovalRecord, actor: string, now: string) {
    if (approval.kind !== "budget_exceeded" || approval.targetType !== "agent_run") return undefined;
    const runId = approval.runId || approval.targetId;
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run || run.status !== "needs_approval") return undefined;
    const workItem = this.findWorkItem(run.workItemId);

    if (!workItem.assignedAgentId) {
      const agent = this.findAvailableAgentForRole(workItem.role);
      if (agent) {
        workItem.assignedAgentId = agent.id;
        workItem.claimedAt = now;
        workItem.claimToken = randomUUID();
        agent.status = "busy";
        agent.currentWorkItemId = workItem.id;
        agent.lastSeenAt = now;
      }
    }
    if (workItem.assignedAgentId) {
      workItem.heartbeatAt = now;
      workItem.leaseExpiresAt = new Date(Date.parse(now) + defaultClaimLeaseMs).toISOString();
    }

    run.status = "running";
    run.events.push(this.makeEvent("agent.progress", "预算审批已通过，run 继续执行"));
    workItem.status = "running";
    workItem.version = (workItem.version ?? 0) + 1;
    workItem.updatedAt = now;

    if (workItem.sourceBugId) {
      const bug = this.snapshot.bugs.find((item) => item.id === workItem.sourceBugId);
      if (bug) {
        bug.status = workItem.role === "test" ? "needs_repro" : "fixing";
        bug.updatedAt = now;
      }
    }

    const workspaceRun = this.snapshot.workspaceRuns.find((item) => item.runId === run.id) ??
      this.createWorkspaceRun(run, workItem, now);
    if (!this.snapshot.workspaceRuns.some((item) => item.id === workspaceRun.id)) {
      this.snapshot.workspaceRuns.unshift(workspaceRun);
    }
    workspaceRun.status = "active";
    workspaceRun.updatedAt = now;

    this.addAuditEvent({
      actor,
      action: "agent_run.resumed",
      targetType: "agent_run",
      targetId: run.id,
      message: "预算审批通过，已恢复暂停的 agent run。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId: run.id,
      createdAt: now
    });
    this.addAuditEvent({
      actor: "workspace_manager",
      action: "workspace_run.created",
      targetType: "workspace_run",
      targetId: workspaceRun.id,
      message: `已为恢复执行创建 ${workspaceRun.isolation === "git_worktree" ? "git worktree" : "模拟"}工作区。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId: run.id,
      createdAt: now
    });
    return run.id;
  }

  private recordBudgetApprovalDenied(approval: ApprovalRecord, actor: string, now: string) {
    if (approval.kind !== "budget_exceeded" || approval.targetType !== "agent_run") return undefined;
    const runId = approval.runId || approval.targetId;
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run || run.status !== "needs_approval") return undefined;
    run.events.push(this.makeEvent("agent.progress", "预算审批被拒绝，run 继续保持暂停"));
    this.addAuditEvent({
      actor,
      action: "budget.approval_denied",
      targetType: "agent_run",
      targetId: run.id,
      message: "预算审批被拒绝，agent run 保持 needs_approval。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId: run.id,
      createdAt: now
    });
    return undefined;
  }

  private expireOverdueApprovals(now = new Date().toISOString()) {
    let changed = false;
    for (const approval of this.snapshot.approvals) {
      if (approval.status !== "pending" || !this.isApprovalExpired(approval.expiresAt, now)) continue;
      approval.status = "expired";
      approval.decisionReason = approval.decisionReason || "Approval expired before a decision was recorded.";
      approval.decidedAt = approval.decidedAt || now;
      approval.updatedAt = now;
      this.addApprovalExpiredAudit(approval, now);
      changed = true;
    }
    return changed;
  }

  private addApprovalExpiredAudit(approval: ApprovalRecord, now: string) {
    this.addAuditEvent({
      actor: "scheduler",
      action: "approval.expired",
      targetType: "approval",
      targetId: approval.id,
      message: "审批已过期，未记录批准或拒绝决定。",
      requirementId: approval.requirementId,
      prdId: approval.prdId,
      workItemId: approval.workItemId,
      runId: approval.runId,
      createdAt: now
    });
  }

  private applyConfiguredBudgets(
    prd: PatchPilotSnapshot["prds"][number],
    workItems: WorkItem[] = [],
    budgetConfig = readPatchPilotConfig().budget
  ) {
    if (prd.budgetUsd === undefined && budgetConfig.prdUsd > 0) {
      prd.budgetUsd = budgetConfig.prdUsd;
    }
    for (const workItem of workItems) {
      if (workItem.budgetUsd === undefined && budgetConfig.workItemUsd > 0) {
        workItem.budgetUsd = budgetConfig.workItemUsd;
      }
    }
  }

  private evaluateBudget(
    prd: PatchPilotSnapshot["prds"][number],
    workItem: WorkItem,
    costEstimateUsd: number,
    budgetConfig = readPatchPilotConfig().budget
  ): BudgetCheckResult {
    const scopes: BudgetScopeCheck[] = [];
    if (budgetConfig.runUsd > 0) {
      scopes.push({
        type: "agent_run",
        limitUsd: budgetConfig.runUsd,
        spentUsd: 0,
        nextSpendUsd: costEstimateUsd
      });
    }
    if (workItem.budgetUsd !== undefined && workItem.budgetUsd > 0) {
      const spentUsd = this.costSpentForWorkItem(workItem.id);
      scopes.push({
        type: "work_item",
        limitUsd: workItem.budgetUsd,
        spentUsd,
        nextSpendUsd: spentUsd + costEstimateUsd
      });
    }
    if (prd.budgetUsd !== undefined && prd.budgetUsd > 0) {
      const spentUsd = this.costSpentForPrd(prd.id);
      scopes.push({
        type: "prd",
        limitUsd: prd.budgetUsd,
        spentUsd,
        nextSpendUsd: spentUsd + costEstimateUsd
      });
    }

    const hardExceeded = scopes.filter((scope) => scope.nextSpendUsd > scope.limitUsd);
    const softExceeded = scopes.filter(
      (scope) => scope.nextSpendUsd <= scope.limitUsd && scope.nextSpendUsd >= scope.limitUsd * budgetConfig.softThresholdRatio
    );
    const remainingBudgets = scopes.map((scope) => Math.max(0, scope.limitUsd - scope.spentUsd));
    const softThresholds = scopes.map((scope) =>
      Math.max(0, scope.limitUsd * budgetConfig.softThresholdRatio - scope.spentUsd)
    );

    return {
      ...(remainingBudgets.length > 0 ? { effectiveBudgetUsd: roundUsd(Math.min(...remainingBudgets)) } : {}),
      ...(softThresholds.length > 0 ? { effectiveSoftThresholdUsd: roundUsd(Math.min(...softThresholds)) } : {}),
      hardExceeded,
      softExceeded
    };
  }

  private createBudgetApproval(run: AgentRun, budgetCheck: BudgetCheckResult, now: string) {
    return this.createApprovalRecord({
      kind: "budget_exceeded",
      targetType: "agent_run",
      targetId: run.id,
      requestedBy: "budget-governor",
      requestedReason: this.describeBudgetScopes("预算硬阈值触发", budgetCheck.hardExceeded),
      riskLevel: "high",
      expiresAt: new Date(Date.parse(now) + budgetApprovalTtlMs).toISOString(),
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId: run.id
    }, now);
  }

  private addBudgetExceededAudit(run: AgentRun, budgetCheck: BudgetCheckResult, actor: string, now: string) {
    this.addAuditEvent({
      actor,
      action: "budget.hard_threshold_exceeded",
      targetType: "agent_run",
      targetId: run.id,
      message: this.describeBudgetScopes("预算硬阈值触发，agent run 已暂停", budgetCheck.hardExceeded),
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId: run.id,
      createdAt: now
    });
  }

  private addBudgetSoftThresholdAudits(run: AgentRun, budgetCheck: BudgetCheckResult, actor: string, now: string) {
    for (const scope of budgetCheck.softExceeded) {
      this.addAuditEvent({
        actor,
        action: "budget.soft_threshold_exceeded",
        targetType: "agent_run",
        targetId: run.id,
        message: `${scopeLabel(scope.type)} 预算软阈值已触发：预计累计 ${formatUsd(scope.nextSpendUsd)} / 预算 ${formatUsd(scope.limitUsd)}。`,
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: run.workItemId,
        runId: run.id,
        createdAt: now
      });
    }
  }

  private describeBudgetScopes(prefix: string, scopes: BudgetScopeCheck[]) {
    const details = scopes.map((scope) =>
      `${scopeLabel(scope.type)} 预计累计 ${formatUsd(scope.nextSpendUsd)} / 预算 ${formatUsd(scope.limitUsd)}`
    );
    return `${prefix}：${details.join("；")}`;
  }

  private costSpentForWorkItem(workItemId: string) {
    return this.snapshot.agentRuns
      .filter((run) => run.workItemId === workItemId && run.status !== "cancelled")
      .reduce((total, run) => total + (run.costActualUsd ?? run.costEstimateUsd ?? 0), 0);
  }

  private costSpentForPrd(prdId: string) {
    return this.snapshot.agentRuns
      .filter((run) => run.prdId === prdId && run.status !== "cancelled")
      .reduce((total, run) => total + (run.costActualUsd ?? run.costEstimateUsd ?? 0), 0);
  }

  private getArtifactStore() {
    if (this.artifactStore) return this.artifactStore;
    const artifacts = readPatchPilotConfig().artifacts;
    return createArtifactStore({
      provider: artifacts.provider,
      localRoot: artifacts.localRoot,
      s3: artifacts.s3
    });
  }

  private upsertArtifactRecords(records: ArtifactRecord[]) {
    const byId = new Map(this.snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
    for (const record of records) byId.set(record.id, record);
    this.snapshot.artifacts = [...byId.values()].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
  }

  private isApprovalExpired(expiresAt: string, now: string) {
    const expiresAtMs = Date.parse(expiresAt);
    const nowMs = Date.parse(now);
    return !Number.isFinite(expiresAtMs) || expiresAtMs <= nowMs;
  }

  private async save() {
    if (!this.dataFilePath) return;
    await mkdir(dirname(this.dataFilePath), { recursive: true });
    const tempFile = `${this.dataFilePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify(this.snapshot, null, 2));
    await rename(tempFile, this.dataFilePath);
  }

  private normalizeSnapshot() {
    const now = new Date().toISOString();
    this.snapshot.requirements ||= [];
    this.snapshot.prds ||= [];
    this.snapshot.workItems ||= [];
    this.snapshot.interfaceContracts ||= [];
    this.snapshot.agentRuns ||= [];
    this.snapshot.workspaceRuns ||= [];
    this.snapshot.testCases ||= [];
    this.snapshot.testRuns ||= [];
    this.snapshot.artifacts ||= [];
    this.snapshot.pullRequests ||= [];
    this.snapshot.reviewRecords ||= [];
    this.snapshot.auditEvents ||= [];
    this.snapshot.acceptances ||= [];
    this.snapshot.approvals ||= [];
    this.snapshot.bugs ||= [];
    this.snapshot.agents = this.mergeDefaultAgents(this.snapshot.agents || [], now);
    this.snapshot.approvals = this.snapshot.approvals.map((item) => ({
      ...item,
      status: item.status || "pending",
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || item.createdAt || now
    }));
    this.snapshot.bugs = this.snapshot.bugs.map((item) => ({
      ...item,
      status: normalizeBugStatus(item.status),
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || item.createdAt || now
    }));
    this.snapshot.artifacts = this.snapshot.artifacts.map((item) => ({
      ...item,
      storage: item.storage || "local_fs",
      createdAt: item.createdAt || now
    }));
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
      version: item.version ?? 1,
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
          (item) =>
            item.id === agent.currentWorkItemId &&
            (item.status === "running" || (item.status === "claimed" && !this.isClaimExpired(item, now)))
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

  private shouldStartReworkRun(workItem: WorkItem, run: AgentRun) {
    if (!["ready", "claimed"].includes(workItem.status) || run.status !== "succeeded") return false;
    return this.isRunRejected(run.id);
  }

  private isRunRejected(runId: string) {
    return this.snapshot.acceptances.some((acceptance) => acceptance.runId === runId && acceptance.status === "rejected");
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationQueue;
    let release!: () => void;
    this.mutationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous.then(async () => {
      try {
        return await operation();
      } finally {
        release();
      }
    });
  }

  private assertClaimToken(workItem: WorkItem, claimToken: string | undefined) {
    if (!workItem.claimToken) return;
    if (workItem.claimToken !== claimToken) {
      throw new DomainError("INVALID_STATE", "Claim token does not match the current work item lease");
    }
  }

  private isClaimExpired(workItem: WorkItem, now: string) {
    if (!workItem.leaseExpiresAt) return true;
    const expiresAt = Date.parse(workItem.leaseExpiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= Date.parse(now);
  }

  private clearClaim(workItem: WorkItem) {
    workItem.assignedAgentId = undefined;
    workItem.claimedAt = undefined;
    workItem.claimToken = undefined;
    workItem.leaseExpiresAt = undefined;
    workItem.heartbeatAt = undefined;
  }

  private releaseAgentAssignment(agentId: string, now: string) {
    const agent = this.snapshot.agents.find((item) => item.id === agentId);
    if (!agent) return;
    agent.status = "idle";
    agent.currentWorkItemId = undefined;
    agent.lastSeenAt = now;
  }

  private requestWorkItemRework(workItem: WorkItem, run: AgentRun, reason: string | undefined, now: string) {
    const normalizedReason = reason?.trim() || "用户要求修改，但没有填写原因。";
    workItem.status = "ready";
    this.clearClaim(workItem);
    workItem.version = (workItem.version ?? 0) + 1;
    workItem.reworkCount = (workItem.reworkCount ?? 0) + 1;
    workItem.lastRejectionReason = normalizedReason;
    workItem.updatedAt = now;
    this.addAuditEvent({
      actor: "human",
      action: "work_item.rework_requested",
      targetType: "work_item",
      targetId: workItem.id,
      message: `用户要求返工：${normalizedReason}`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: now
    });
  }

  private completeAgentAssignment(workItemId: string, now: string) {
    const workItem = this.snapshot.workItems.find((item) => item.id === workItemId);
    if (workItem) {
      this.clearClaim(workItem);
      workItem.version = (workItem.version ?? 0) + 1;
    }
    const agent = this.snapshot.agents.find((item) => item.currentWorkItemId === workItemId);
    if (!agent) return;
    agent.status = "idle";
    agent.currentWorkItemId = undefined;
    agent.lastSeenAt = now;
  }

  private createWorkspaceRun(run: AgentRun, workItem: WorkItem, now: string): WorkspaceRun {
    const workspaceRoot = readPatchPilotConfig().dev.workspaceRoot;
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

  private async recordRunTestEvidence(
    run: AgentRun,
    workItem: WorkItem,
    tests: TestRun[],
    endedAt: string,
    options: { workspaceStatus: WorkspaceRun["status"]; workspacePath?: string; finalRunStatus?: AgentRun["status"] }
  ) {
    const prd = this.findPrd(run.prdId);
    const testCase = this.ensureTestCasesForWorkItems(prd, [workItem], endedAt)[0];
    const normalizedTests: TestRun[] = tests.map((test) => {
      const logArtifactId = test.logArtifactId || `artifact_test_log_${test.id}`;
      const workspacePath = test.workspacePath || options.workspacePath || run.result?.workspacePath || `simulated://${run.id}`;
      return {
        ...test,
        testCaseId: test.testCaseId || testCase?.id,
        runId: run.id,
        prdId: run.prdId,
        workItemId: workItem.id,
        startedAt: test.startedAt || new Date(new Date(endedAt).getTime() - test.durationMs).toISOString(),
        endedAt: test.endedAt || endedAt,
        runner: test.runner || (run.runner === "codex" ? "patchpilot-test-runner" : "simulated-test-runner"),
        environmentImage: test.environmentImage || (run.runner === "codex" ? "local" : "simulated"),
        workspacePath,
        commit: run.result?.headCommit || test.commit,
        branch: run.result?.branchName || test.branch,
        exitCode: test.exitCode !== undefined ? test.exitCode : test.status === "passed" ? 0 : 1,
        retryCount: test.retryCount ?? 0,
        attempt: test.attempt ?? 1,
        maxAttempts: test.maxAttempts ?? 1,
        flakySignal: test.flakySignal ?? false,
        logArtifactId,
        artifactIds: test.artifactIds || [logArtifactId]
      };
    });

    if (run.result) {
      run.result.tests = normalizedTests;
    }

    await this.recordRunArtifacts(run, workItem, normalizedTests, endedAt, options.finalRunStatus);

    for (const test of normalizedTests) {
      const linkedTestCase = this.snapshot.testCases.find((item) => item.id === test.testCaseId);
      if (!linkedTestCase) continue;
      linkedTestCase.status = testCaseStatusFromTestRunStatus(test.status);
      linkedTestCase.lastRunId = run.id;
      linkedTestCase.lastTestRunId = test.id;
      linkedTestCase.flaky = Boolean(test.flakySignal);
      linkedTestCase.updatedAt = test.endedAt || endedAt;
    }

    const testIds = new Set(normalizedTests.map((test) => test.id));
    this.snapshot.testRuns = [
      ...normalizedTests,
      ...this.snapshot.testRuns.filter((test) => !testIds.has(test.id))
    ];
    this.markWorkspaceRun(
      run.id,
      options.workspaceStatus,
      endedAt,
      options.workspacePath || run.result?.workspacePath || normalizedTests[0]?.workspacePath
    );

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

    return normalizedTests;
  }

  private async recordRunArtifacts(
    run: AgentRun,
    workItem: WorkItem,
    tests: TestRun[],
    endedAt: string,
    finalRunStatus = run.status
  ) {
    const artifactStore = this.getArtifactStore();
    const common = {
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: endedAt
    };
    const records: ArtifactRecord[] = [];

    for (const test of tests) {
      const logArtifactId = test.logArtifactId || `artifact_test_log_${test.id}`;
      const logRecord = await artifactStore.putArtifact({
        id: logArtifactId,
        kind: "log",
        content: renderTestLog(test),
        contentType: "text/plain",
        extension: ".log",
        metadata: {
          command: test.command,
          status: test.status
        },
        ...common,
        testRunId: test.id
      });
      const reportRecord = await artifactStore.putArtifact({
        id: `artifact_test_report_${test.id}`,
        kind: "test_report",
        content: JSON.stringify(test, null, 2),
        contentType: "application/json",
        extension: ".json",
        metadata: {
          command: test.command,
          status: test.status
        },
        ...common,
        testRunId: test.id
      });
      test.logArtifactId = logRecord.id;
      test.artifactIds = uniqueStrings([...(test.artifactIds ?? []), logRecord.id, reportRecord.id]);
      records.push(logRecord, reportRecord);
    }

    const traceRecord = await artifactStore.putArtifact({
      id: `artifact_trace_${run.id}`,
      kind: "trace",
      content: JSON.stringify({
        runId: run.id,
        status: finalRunStatus,
        currentStep: run.currentStep,
        timeline: run.timeline,
        events: run.events,
        capture: {
          codexSessionId: run.result?.codexSessionId,
          agentMessages: run.result?.agentMessages ?? [],
          reasoningSummaries: run.result?.reasoningSummaries ?? [],
          toolCalls: run.result?.toolCalls ?? [],
          testOutputSummary: run.result?.testOutputSummary
        }
      }, null, 2),
      contentType: "application/json",
      extension: ".json",
      metadata: {
        status: finalRunStatus,
        runner: run.runner
      },
      ...common
    });
    const diffRecord = await artifactStore.putArtifact({
      id: `artifact_diff_${run.id}`,
      kind: "diff",
      content: JSON.stringify({
        diffSummary: run.result?.diffSummary ?? buildRunDiffSummary(run.result?.changedFiles ?? [], run.result),
        changedFiles: run.result?.changedFiles ?? [],
        branchName: run.result?.branchName,
        baseBranch: run.result?.baseBranch,
        baseCommit: run.result?.baseCommit,
        headCommit: run.result?.headCommit
      }, null, 2),
      contentType: "application/json",
      extension: ".json",
      metadata: {
        changedFileCount: String(run.result?.diffSummary?.changedFileCount ?? run.result?.changedFiles.length ?? 0)
      },
      ...common
    });
    const previewRecord = await artifactStore.putArtifact({
      id: `artifact_preview_${run.id}`,
      kind: "preview_metadata",
      content: JSON.stringify({
        previewUrl: run.result?.previewUrl,
        workspacePath: run.result?.workspacePath,
        runner: run.runner
      }, null, 2),
      contentType: "application/json",
      extension: ".json",
      metadata: {
        runner: run.runner
      },
      ...common
    });

    records.push(traceRecord, diffRecord, previewRecord);
    this.upsertArtifactRecords(records);
    const runArtifactIds = uniqueStrings([
      ...(run.artifactIds ?? []),
      traceRecord.id,
      diffRecord.id,
      previewRecord.id
    ]);
    run.artifactIds = runArtifactIds;
    if (run.result) {
      run.result.artifactIds = uniqueStrings([...(run.result.artifactIds ?? []), ...runArtifactIds]);
      run.result.tests = tests;
    }
  }

  private async recordCompletedRunEvidence(
    run: AgentRun,
    workItem: WorkItem,
    tests: TestRun[],
    endedAt: string,
    finalRunStatus: AgentRun["status"]
  ) {
    await this.recordRunTestEvidence(run, workItem, tests, endedAt, { workspaceStatus: "archived", finalRunStatus });

    const pullRequest = this.recordPullRequest(run, workItem, endedAt);
    this.addAuditEvent({
      actor: "pr_adapter",
      action: "pull_request.ready_for_review",
      targetType: "pull_request",
      targetId: pullRequest.id,
      message: "PR 交付记录已生成，包含需求、工作项、测试和 reviewer 摘要。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: endedAt
    });

    const reviewRecord = this.recordReview(run, workItem, pullRequest, endedAt);
    this.addAuditEvent({
      actor: "reviewer_agent",
      action: "review.approved",
      targetType: "review_record",
      targetId: reviewRecord.id,
      message: "Reviewer agent 已审查 PR、测试证据和风险摘要。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: endedAt
    });

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

  private recordFailureDefect(
    run: AgentRun,
    workItem: WorkItem,
    failure: RunFailureDetails,
    testRun: TestRun | undefined,
    now: string
  ) {
    if (!testRun) return undefined;
    const existing = this.snapshot.bugs.find(
      (item) => item.sourceRunId === run.id && item.sourceTestRunId === testRun.id
    );
    if (existing) return existing;

    const defect: BugReport = {
      id: `bug_${randomUUID()}`,
      title: `失败沉淀：${workItem.title}`,
      description: [
        `AgentRun ${run.id} 执行失败，失败分类为 ${failure.failureType}。`,
        `失败摘要：${failure.failureSummary}`
      ].join("\n"),
      reproductionSteps: [
        `WorkItem: ${workItem.id}`,
        `Run: ${run.id}`,
        `TestRun: ${testRun.id}`,
        `Command: ${testRun.command}`,
        `Commit: ${testRun.commit || "not recorded"}`,
        `Branch: ${testRun.branch || "not recorded"}`
      ].join("\n"),
      expectedBehavior: "工作项执行完成后，目标测试应通过并进入 review/验收。",
      actualBehavior: testRun.failureSummary || testRun.summary || failure.failureSummary,
      severity: severityForFailure(failure.failureType),
      status: "reported",
      reporter: "system",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      sourceRunId: run.id,
      sourceTestRunId: testRun.id,
      sourceFailureType: failure.failureType,
      ...(testRun.commit ? { sourceCommit: testRun.commit } : {}),
      ...(testRun.branch ? { sourceBranch: testRun.branch } : {}),
      createdAt: now,
      updatedAt: now
    };

    this.snapshot.bugs.unshift(defect);
    this.addAuditEvent({
      actor: "failure-classifier",
      action: "defect.created",
      targetType: "bug",
      targetId: defect.id,
      message: `已从失败 TestRun ${testRun.id} 沉淀 Defect，分类为 ${failure.failureType}。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: now
    });
    return defect;
  }

  private recordPullRequest(run: AgentRun, workItem: WorkItem, now: string): PullRequestRecord {
    const existing = this.snapshot.pullRequests.find((item) => item.runId === run.id);
    const result = run.result;
    const tests = result?.tests ?? [];
    const testSummary =
      tests.length > 0
        ? tests.map((test) => `${test.status}: ${test.command} (${test.durationMs}ms)`).join("\n")
        : "No test evidence recorded.";
    const reviewerSummary = result?.reviewerSummary || "Reviewer agent 尚未返回摘要。";
    const branchName = result?.branchName || existing?.branchName || buildFallbackBranchName(workItem, run.id);
    const baseBranch = result?.baseBranch || existing?.baseBranch || "main";
    const baseCommit = result?.baseCommit || existing?.baseCommit;
    const headCommit = result?.headCommit || existing?.headCommit;
    const pullRequest: PullRequestRecord = {
      id: existing?.id || `pr_${run.id}`,
      provider: "local",
      status: "ready_for_review",
      title: `[PatchPilot] ${workItem.title}`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      branchName,
      baseBranch,
      ...(baseCommit ? { baseCommit } : {}),
      ...(headCommit ? { headCommit } : {}),
      url: existing?.url || `local://pull-requests/${run.id}`,
      bodyMarkdown: this.buildPullRequestBody(run, workItem, testSummary, reviewerSummary, {
        branchName,
        baseBranch,
        baseCommit,
        headCommit
      }),
      reviewerSummary,
      testSummary,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    if (existing) Object.assign(existing, pullRequest);
    else this.snapshot.pullRequests.unshift(pullRequest);
    return pullRequest;
  }

  private recordReview(
    run: AgentRun,
    workItem: WorkItem,
    pullRequest: PullRequestRecord,
    now: string
  ): ReviewRecord {
    const existing = this.snapshot.reviewRecords.find((item) => item.runId === run.id);
    const tests = run.result?.tests ?? [];
    const allTestsPassed = tests.length > 0 && tests.every((test) => test.status === "passed");
    const reviewerSummary = run.result?.reviewerSummary || "Reviewer agent 尚未返回摘要。";
    const testSummary =
      tests.length > 0
        ? tests.map((test) => `${test.status}: ${test.command} (${test.summary})`).join("\n")
        : "No test evidence recorded.";
    const reviewRecord: ReviewRecord = {
      id: existing?.id || `review_${run.id}`,
      status: allTestsPassed ? "approved" : "changes_requested",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      linkedPullRequestId: pullRequest.id,
      reviewerAgentId: "agent_reviewer",
      summary: `Reviewer agent 摘要：${reviewerSummary}`,
      testSummary,
      riskLevel: run.result?.riskLevel || "medium",
      findings: allTestsPassed
        ? ["测试证据通过", "PR 交付记录已生成", "未发现阻断验收的高风险问题"]
        : ["测试证据不足或存在失败，需要返工"],
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };

    if (existing) Object.assign(existing, reviewRecord);
    else this.snapshot.reviewRecords.unshift(reviewRecord);
    return reviewRecord;
  }

  private buildPullRequestBody(
    run: AgentRun,
    workItem: WorkItem,
    testSummary: string,
    reviewerSummary: string,
    git: {
      branchName: string;
      baseBranch: string;
      baseCommit?: string;
      headCommit?: string;
    }
  ) {
    const result = run.result;
    return [
      "## 需求",
      `Requirement: ${run.requirementId}`,
      `PRD: ${run.prdId}`,
      "",
      "## 工作项",
      `WorkItem: ${workItem.id}`,
      `Role: ${workItem.role}`,
      `Scope: ${workItem.scope}`,
      "",
      "## Git",
      `Branch: ${git.branchName}`,
      `Base: ${git.baseBranch}${git.baseCommit ? ` (${git.baseCommit})` : ""}`,
      `Commit: ${git.headCommit || "not recorded"}`,
      "",
      "## 改动摘要",
      result?.summary || "Agent run completed without a summary.",
      "",
      "## Diff 摘要",
      result?.diffSummary
        ? `${result.diffSummary.changedFileCount} changed files: ${result.diffSummary.changedFiles.join(", ") || "none"}`
        : "No diff summary recorded.",
      "",
      "## 工具调用",
      result?.toolCalls?.length
        ? result.toolCalls.map((toolCall) =>
            `- ${toolCall.status}: ${toolCall.name}${toolCall.command ? ` (${toolCall.command})` : ""} - ${toolCall.summary}`
          ).join("\n")
        : "No structured tool call evidence recorded.",
      "",
      "## 测试结果",
      testSummary,
      "",
      "## 风险",
      result?.riskLevel || "unknown",
      "",
      "## Reviewer Agent 摘要",
      reviewerSummary
    ].join("\n");
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

  private makeSimulatedFailedTestRun(run: AgentRun, workItem: WorkItem): TestRun {
    const branch = `simulated/${slugSegment(workItem.id)}`;
    return {
      id: `test_${randomUUID()}`,
      runId: run.id,
      prdId: run.prdId,
      workItemId: workItem.id,
      status: "failed",
      command: "npm test --workspaces --if-present",
      summary: "模拟测试失败：断言发现交付结果不满足验收标准",
      durationMs: 760,
      commit: `simulated-${run.id.replace(/^run_/, "").slice(0, 12)}`,
      branch,
      failureSummary: "expected delivery evidence to satisfy acceptance criteria",
      exitCode: 1,
      retryCount: 0,
      attempt: 1,
      maxAttempts: 1,
      flakySignal: false,
      runner: "simulated-test-runner",
      environmentImage: "simulated",
      workspacePath: `simulated://${run.id}`,
      logArtifactId: `artifact_test_log_${run.id}`,
      artifactIds: [`artifact_test_log_${run.id}`]
    };
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
      bug.status = "reproduced";
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
    bug.status = "verifying";
    bug.updatedAt = now;
    this.addAuditEvent({
      actor: "backend_agent",
      action: "bug.verifying",
      targetType: "bug",
      targetId: bug.id,
      message: "开发 agent 已完成 bug 修复，正在根据回归证据关闭 Defect。",
      requirementId: bug.requirementId,
      prdId: bug.prdId,
      workItemId: workItem.id,
      runId: run?.id,
      createdAt: now
    });
    bug.status = "closed";
    bug.updatedAt = now;
    this.addAuditEvent({
      actor: "test_runner",
      action: "bug.closed",
      targetType: "bug",
      targetId: bug.id,
      message: "回归测试证据通过，Defect 已关闭。",
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

    const fixWorkItem = createBugFixWorkItem({
      bugId: bug.id,
      requirementId: bug.requirementId,
      prdId: sourceWorkItem.prdId,
      title: bug.title,
      now
    });
    this.applyConfiguredBudgets(this.findPrd(sourceWorkItem.prdId), [fixWorkItem]);
    this.snapshot.workItems.unshift(fixWorkItem);
    this.ensureTestCasesForWorkItems(this.findPrd(sourceWorkItem.prdId), [fixWorkItem], now);
  }

  private ensureTestCasesForWorkItems(prd: PatchPilotSnapshot["prds"][number], workItems: WorkItem[], now = new Date().toISOString()) {
    const missingWorkItems = workItems.filter(
      (workItem) => !this.snapshot.testCases.some((testCase) => testCase.workItemId === workItem.id)
    );
    if (missingWorkItems.length > 0) {
      this.snapshot.testCases = [
        ...createTestCasesForWorkItems(prd, missingWorkItems, now),
        ...this.snapshot.testCases
      ];
    }
    return this.snapshot.testCases.filter((testCase) =>
      workItems.some((workItem) => workItem.id === testCase.workItemId)
    );
  }
}

type WorkItemRole = PatchPilotSnapshot["workItems"][number]["role"];

function buildFallbackBranchName(workItem: WorkItem, runId: string) {
  const workItemId = slugSegment(workItem.id).slice(0, 80);
  const titleSlug = slugSegment(workItem.title).slice(0, 48);
  const fallbackSlug = runId.replace(/^run_/, "").slice(0, 8) || "run";
  return `patchpilot/${workItemId}-${titleSlug || fallbackSlug}`;
}

function slugSegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}

function uniqueStrings(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function buildRunDiffSummary(
  changedFiles: string[],
  git: {
    branchName?: string;
    baseBranch?: string;
    baseCommit?: string;
    headCommit?: string;
  } = {}
): AgentRunDiffSummary {
  return {
    changedFileCount: changedFiles.length,
    changedFiles,
    hasChanges: changedFiles.length > 0,
    ...(git.branchName ? { branchName: git.branchName } : {}),
    ...(git.baseBranch ? { baseBranch: git.baseBranch } : {}),
    ...(git.baseCommit ? { baseCommit: git.baseCommit } : {}),
    ...(git.headCommit ? { headCommit: git.headCommit } : {})
  };
}

function summarizeRunTestOutput(tests: TestRun[]) {
  if (!tests.length) return "No test output captured.";
  return tests.map((test) => {
    const failure = test.failureSummary ? ` Failure: ${test.failureSummary}` : "";
    return `${test.status}: ${test.command} (${test.durationMs}ms). ${test.summary}${failure}`;
  }).join("\n");
}

function renderTestLog(test: TestRun) {
  return [
    `TestRun: ${test.id}`,
    `Status: ${test.status}`,
    `Command: ${test.command}`,
    `Exit code: ${test.exitCode ?? "not recorded"}`,
    `Duration: ${test.durationMs}ms`,
    `Retry: ${test.retryCount ?? 0}/${test.maxAttempts ?? 1}`,
    `Flaky: ${test.flakySignal ? "yes" : "no"}`,
    "",
    "Summary:",
    test.summary,
    ...(test.failureSummary ? ["", "Failure:", test.failureSummary] : [])
  ].join("\n");
}

function roundUsd(value: number) {
  return Math.round(value * 100) / 100;
}

function formatUsd(value: number) {
  return `$${roundUsd(value).toFixed(2)}`;
}

function scopeLabel(scope: BudgetScopeType) {
  if (scope === "prd") return "PRD";
  if (scope === "work_item") return "WorkItem";
  return "AgentRun";
}

function extractRunFailureDetails(error: unknown): RunFailureDetails {
  const failureSummary = error instanceof Error ? error.message : String(error);
  const record = asRecord(error);
  const rawFailureType =
    error instanceof CodexRunError
      ? error.failureType
      : record && isFailureType(record.failureType)
        ? record.failureType
        : undefined;
  const testRun = error instanceof CodexRunError
    ? error.testRun
    : record
      ? asTestRun(record.testRun)
      : undefined;
  const failureType = rawFailureType || (testRun?.status === "failed" ? "test_failed" : classifyFailureMessage(failureSummary));

  return {
    failureType,
    failureSummary,
    ...(testRun ? { testRun } : {})
  };
}

function createRunFailureError(message: string, failureType: FailureType, testRun?: TestRun) {
  const error = new Error(message) as Error & { failureType: FailureType; testRun?: TestRun };
  error.failureType = failureType;
  if (testRun) error.testRun = testRun;
  return error;
}

function parseFailureType(value: string | undefined) {
  const normalized = value?.trim();
  return isFailureType(normalized) ? normalized : undefined;
}

function isFailureType(value: unknown): value is FailureType {
  return typeof value === "string" && failureTypes.has(value as FailureType);
}

function asTestRun(value: unknown): TestRun | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (
    typeof record.id !== "string" ||
    typeof record.status !== "string" ||
    typeof record.command !== "string" ||
    typeof record.summary !== "string" ||
    typeof record.durationMs !== "number"
  ) {
    return undefined;
  }
  return record as unknown as TestRun;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function failureTypeLabel(failureType: FailureType) {
  const labels: Record<FailureType, string> = {
    transient: "暂态失败",
    deterministic: "确定性失败",
    test_failed: "测试失败",
    policy_denied: "策略拒绝",
    budget_exhausted: "预算耗尽",
    environment_failed: "环境失败"
  };
  return labels[failureType];
}

function severityForFailure(failureType: FailureType): BugSeverity {
  if (failureType === "budget_exhausted" || failureType === "policy_denied") return "high";
  if (failureType === "environment_failed") return "medium";
  if (failureType === "transient") return "low";
  return "medium";
}

function normalizeBugStatus(status: string): BugStatus {
  const legacyStatusMap: Record<string, BugStatus> = {
    confirmed: "reproduced",
    fixed: "closed",
    rejected: "unreproducible"
  };
  if (legacyStatusMap[status]) return legacyStatusMap[status];
  const statuses = ["reported", "needs_repro", "reproduced", "unreproducible", "fixing", "verifying", "closed"];
  if (statuses.includes(status)) return status as BugStatus;
  return "reported";
}

export class DomainError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_STATE" | "STORE_CORRUPT",
    message: string
  ) {
    super(message);
  }
}
