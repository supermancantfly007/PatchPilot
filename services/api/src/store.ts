import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  createArtifactStore,
  type ArtifactStore
} from "@patchpilot/artifacts";
import {
  createPglitePatchPilotRepository,
  createPostgresPatchPilotRepository,
  type PatchPilotRepository,
  type PatchPilotRepositoryInfo
} from "@patchpilot/db";
import {
  type AcceptanceDecision,
  type ApprovalRecord,
  type AgentProfile,
  type AgentRun,
  type AgentRunDiffSummary,
  type AgentRunEvent,
  type AgentRunResult,
  type ArtifactRecord,
  type AuditEvent,
  type AuditJsonValue,
  type BugReport,
  type BugSeverity,
  type BugStatus,
  type ContractDiffSummary,
  type ContractRegistryMetadata,
  type EgressPolicyEvidence,
  type ExternalIssueBlocker,
  type ExternalIssueLink,
  type ExternalIssueProvider,
  type ExternalIssueStatusCategory,
  type ExternalIssueSyncAction,
  type ExternalIssueSyncEvidence,
  type FailureType,
  type GitHubAppInstallationRecord,
  type IntakeArtifactReference,
  type InterfaceContract,
  type PatchPilotSnapshot,
  type Prd,
  type PullRequestRecord,
  type Requirement,
  type RepositoryRecord,
  type ReviewRecord,
  type SecretBrokerEvidence,
  type TestCase,
  type TestRun,
  type WorkspaceRun,
  type WorkItem,
  type WorkItemRepositoryTarget,
  advanceTimeline,
  completeTimeline,
  computeAuditEventHash,
  createBugFixWorkItem,
  createBugPrd,
  createBugRequirement,
  createGrillMeQuestion,
  createInitialClarificationTurn,
  createBugWorkItem,
  createDefaultAgents,
  evaluateAcceptanceQualityGate,
  createPrd,
  createTestCasesForWorkItems,
  createTimeline,
  createWorkItems,
  emptySnapshot,
  generateClarificationQuestions,
  makeSimpleSummary,
  normalizeAuditActor,
  testCaseStatusFromTestRunStatus,
  type RuntimeConfig,
  verifyAuditChain as verifyAuditHashChain
} from "@patchpilot/domain";
import {
  buildContractRegistryArtifacts,
  buildContractTestRequirements,
  createContractRegistryMetadata,
  createInterfaceContracts,
  type ContractRegistryArtifact,
  type ContractTestRequirement
} from "@patchpilot/contracts";
import {
  CodexRunError,
  LocalCodexRunner,
  classifyFailureMessage,
  resolveSecretBrokerGrants,
  revokeSecretBrokerGrants,
  type CodexRunner,
  type CodexRunnerEvent
} from "@patchpilot/codex-runner";
import {
  verifyGitHubWebhookSignature,
  type GitHubAppRepository,
  type PullRequestAdapter,
  type PullRequestCheckSummary,
  type PullRequestDraft
} from "@patchpilot/pull-request-adapter";
import {
  asCommandAuditEvidenceList,
  type CommandAuditEvidence
} from "@patchpilot/command-executor";
import {
  createMemoryIssueTrackerAdapters,
  isPatchPilotTerminalEntity,
  normalizeExternalIssueStatus,
  shouldExternalStatusBlockWork,
  shouldExternalStatusTriggerWork,
  type ExternalIssueAdapterRegistry,
  type ExternalIssueTrackerAdapter
} from "@patchpilot/issue-tracker-adapter";
import {
  generateCapabilityManifest,
  summarizeCapabilityManifest,
  type CapabilityManifest
} from "@patchpilot/policy";
import { redactJsonValue, redactRecordValues, redactSecrets, type SecretRedactionOptions } from "@patchpilot/security";
import { getTelemetry, type PatchPilotTelemetry } from "@patchpilot/telemetry";
import {
  auditExportAuthEnforcement,
  auditExportFormatVersion,
  auditRetentionPolicyVersion,
  buildPrdAuditExportPackage
} from "./auditExport";
import { readPatchPilotConfig } from "./config";
import {
  createConfiguredGitHubAppRepositoryClient,
  createConfiguredPullRequestAdapter
} from "./pullRequestAdapter";

const defaultDataFile = join(process.env.PATCHPILOT_DATA_DIR || join(process.cwd(), "data"), "patchpilot-store.json");
const defaultPgliteDataDir = join(
  process.env.PATCHPILOT_DATA_DIR || join(process.cwd(), "data"),
  "patchpilot-pglite"
);

const defaultClaimLeaseMs = 5 * 60 * 1000;
const defaultRunCostEstimateUsd = 0.42;
const budgetApprovalTtlMs = 24 * 60 * 60 * 1000;
const contractApprovalTtlMs = 14 * 24 * 60 * 60 * 1000;
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
  egressPolicyEvidence?: EgressPolicyEvidence;
  secretBrokerEvidence?: SecretBrokerEvidence;
  commandAuditEvents?: CommandAuditEvidence[];
}

type AddAuditEventInput = Pick<AuditEvent, "action" | "targetType" | "targetId" | "message"> &
  Partial<
    Pick<
      AuditEvent,
      | "actor"
      | "actorType"
      | "actorId"
      | "traceId"
      | "requirementId"
      | "prdId"
      | "workItemId"
      | "runId"
      | "createdAt"
    >
  > & {
    beforeJson?: AuditJsonValue | null;
    afterJson?: AuditJsonValue | null;
    metadataJson?: AuditJsonValue | null;
  };

type IntakeArtifactReferenceInput = Omit<IntakeArtifactReference, "id" | "createdAt"> &
  Partial<Pick<IntakeArtifactReference, "id" | "createdAt">>;

type ExternalIssueLinkInput = {
  provider: ExternalIssueProvider;
  entityType: "work_item" | "defect";
  entityId: string;
  externalIssueId?: string;
  externalKey?: string;
  externalUrl?: string;
  statusName?: string;
  statusCategory?: ExternalIssueStatusCategory;
  summary?: string;
};

type ExternalIssueStatusUpdateInput = {
  provider: ExternalIssueProvider;
  externalIssueId?: string;
  externalKey?: string;
  statusName: string;
  statusCategory?: ExternalIssueStatusCategory;
  actor?: string;
  observedAt?: string;
  idempotencyKey?: string;
};

interface GitHubAppRepositoryClient {
  listRepositories(): Promise<GitHubAppRepository[]>;
}

export class PatchPilotStore {
  private snapshot: PatchPilotSnapshot = emptySnapshot();
  private loaded = false;
  private readonly codexRunner: CodexRunner;
  private readonly artifactStore?: ArtifactStore;
  private readonly telemetry: PatchPilotTelemetry;
  private readonly pullRequestAdapter?: PullRequestAdapter;
  private readonly githubAppRepositoryClient?: GitHubAppRepositoryClient;
  private readonly issueTrackerAdapters: Record<ExternalIssueProvider, ExternalIssueTrackerAdapter>;
  private readonly dataFilePath: string | undefined;
  private readonly repositoryPromise: Promise<PatchPilotRepository> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly activeExecutions = new Set<Promise<void>>();

  constructor(
    options: {
      codexRunner?: CodexRunner;
      dataFilePath?: string | false;
      artifactStore?: ArtifactStore;
      telemetry?: PatchPilotTelemetry;
      pullRequestAdapter?: PullRequestAdapter;
      githubAppRepositoryClient?: GitHubAppRepositoryClient;
      issueTrackerAdapters?: ExternalIssueAdapterRegistry;
      repository?: PatchPilotRepository | Promise<PatchPilotRepository> | false;
    } = {}
  ) {
    this.codexRunner = options.codexRunner ?? new LocalCodexRunner();
    this.artifactStore = options.artifactStore;
    this.telemetry = options.telemetry ?? getTelemetry({ serviceName: "patchpilot-api" });
    this.pullRequestAdapter = options.pullRequestAdapter;
    this.githubAppRepositoryClient = options.githubAppRepositoryClient;
    this.issueTrackerAdapters = {
      ...createMemoryIssueTrackerAdapters(),
      ...options.issueTrackerAdapters
    };
    this.dataFilePath =
      options.dataFilePath === false
        ? undefined
        : options.dataFilePath ?? (process.env.NODE_ENV === "test" ? undefined : defaultDataFile);
    this.repositoryPromise =
      options.repository === false
        ? undefined
        : Promise.resolve(options.repository ?? createDefaultRepository());
  }

  async load() {
    if (this.loaded) return;
    const repository = await this.repositoryPromise;
    if (repository) {
      const databaseSnapshot = await repository.loadSnapshot();
      if (isProductSnapshotEmpty(databaseSnapshot)) {
        const importedSnapshot = await this.readLegacyJsonSnapshotIfPresent();
        this.snapshot = importedSnapshot ?? databaseSnapshot;
        this.normalizeSnapshot();
        if (importedSnapshot) await this.save();
      } else {
        this.snapshot = databaseSnapshot;
        this.normalizeSnapshot();
      }
      this.loaded = true;
      return;
    }
    if (!this.dataFilePath) {
      this.normalizeSnapshot();
      this.loaded = true;
      return;
    }
    const snapshot = await this.readLegacyJsonSnapshotIfPresent();
    if (snapshot) this.snapshot = snapshot;
    else this.snapshot = emptySnapshot();
    this.normalizeSnapshot();
    if (!snapshot) await this.save();
    this.loaded = true;
  }

  async close() {
    await Promise.allSettled([...this.activeExecutions]);
    const repository = await this.repositoryPromise;
    await repository?.close();
  }

  async getPersistenceInfo(): Promise<PatchPilotRepositoryInfo | { kind: "memory" | "json"; path?: string }> {
    const repository = await this.repositoryPromise;
    if (repository) return repository.info;
    if (this.dataFilePath) return { kind: "json", path: this.dataFilePath };
    return { kind: "memory" };
  }

  async exportJsonSnapshot() {
    return this.getSnapshot();
  }

  async importJsonSnapshot(snapshot: PatchPilotSnapshot) {
    this.snapshot = redactJsonValue(structuredClone(snapshot));
    this.normalizeSnapshot();
    this.loaded = true;
    await this.save();
    return this.redactedSnapshot();
  }

  async importJsonFile(filePath: string) {
    try {
      const raw = await readFile(filePath, "utf8");
      return this.importJsonSnapshot(JSON.parse(raw) as PatchPilotSnapshot);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new DomainError("STORE_CORRUPT", "Store file could not be read or parsed");
      }
      throw new DomainError("NOT_FOUND", `JSON fixture not found: ${filePath}`);
    }
  }

  async getSnapshot() {
    await this.load();
    if (this.expireOverdueApprovals()) await this.save();
    return this.redactedSnapshot();
  }

  async getAgents() {
    await this.load();
    return structuredClone(this.snapshot.agents);
  }

  async getWorkItem(id: string) {
    await this.load();
    return structuredClone(this.findWorkItem(id));
  }

  async previewWorkItemsForPrd(prdId: string) {
    await this.load();
    const prd = this.findPrd(prdId);
    if (prd.status === "approved") {
      return structuredClone(this.snapshot.workItems.filter((item) => item.prdId === prdId));
    }
    const previewPrd = structuredClone(prd);
    const workItems = createWorkItems(previewPrd, { repositories: this.repositoryTargetsForPrd() });
    this.applyConfiguredBudgets(previewPrd, workItems);
    return structuredClone(workItems);
  }

  async getApproval(id: string) {
    await this.load();
    return structuredClone(this.findApproval(id));
  }

  private redactedSnapshot() {
    return redactJsonValue(structuredClone(this.snapshot));
  }

  async verifyAuditChain() {
    await this.load();
    return verifyAuditHashChain(this.snapshot.auditEvents);
  }

  async exportPrdAuditPackage(prdId: string, options: { actorId?: string } = {}) {
    return this.withMutation(async () => {
      await this.load();
      const prd = this.findPrd(prdId);
      const actor = { actorType: "admin", actorId: options.actorId?.trim() || "admin" };
      const now = new Date().toISOString();
      const existingVerification = verifyAuditHashChain(this.snapshot.auditEvents);
      const exportEvent = this.addAuditEvent({
        actorType: actor.actorType,
        actorId: actor.actorId,
        actor: options.actorId || actor.actorId,
        action: "audit.exported",
        targetType: "prd",
        targetId: prd.id,
        message: "管理员导出 PRD 全链路审计包。",
        requirementId: prd.requirementId,
        prdId: prd.id,
        createdAt: now,
        beforeJson: null,
        afterJson: {
          export: {
            formatVersion: auditExportFormatVersion,
            scope: "prd",
            prdId: prd.id,
            redacted: true,
            retentionPolicyVersion: auditRetentionPolicyVersion
          }
        },
        metadataJson: {
          adminIntent: true,
          authEnforcement: auditExportAuthEnforcement,
          worm: {
            mode: "metadata_only",
            semantics: "audit hash chain plus export payload checksums"
          },
          chainHeadBeforeExport: existingVerification.headHash,
          checkedEventsBeforeExport: existingVerification.checkedEvents
        }
      });
      const auditPackage = buildPrdAuditExportPackage({
        snapshot: this.snapshot,
        prdId: prd.id,
        createdAt: now,
        actorType: actor.actorType,
        actorId: actor.actorId,
        exportAuditEventId: exportEvent.id
      });
      await this.save();
      return auditPackage;
    });
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
    artifactReferences?: IntakeArtifactReferenceInput[];
  }) {
    await this.load();
    const now = new Date().toISOString();
    const id = `req_${randomUUID()}`;
    const rawInput = redactSecrets(input.rawInput).redacted;
    const artifactReferences = this.prepareIntakeArtifactReferences(input.artifactReferences ?? [], id, now);
    const requirement: Requirement = {
      id,
      title: makeSimpleSummary(rawInput, input.template),
      rawInput,
      template: input.template,
      status: "clarifying",
      simpleSummary: makeSimpleSummary(rawInput, input.template),
      artifactReferences,
      clarificationQuestions: generateClarificationQuestions(rawInput, input.template),
      clarificationTurns: [createInitialClarificationTurn(rawInput, input.template, now)],
      createdAt: now,
      updatedAt: now
    };

    this.snapshot.requirements.unshift(requirement);
    await this.recordIntakeArtifactReferenceArtifacts(requirement, artifactReferences, now);
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
      answer: redactSecrets(answers[question.id] || question.recommendedAnswer).redacted
    }));
    requirement.status = "prd_draft";
    requirement.updatedAt = new Date().toISOString();

    const prd = createPrd(requirement);
    this.applyConfiguredBudgets(prd);
    this.snapshot.prds = this.snapshot.prds.filter((item) => item.requirementId !== requirementId);
    this.snapshot.prds.unshift(prd);
    this.snapshot.interfaceContracts = [
      ...createInterfaceContracts(prd, "draft", new Date().toISOString(), this.repositoryTargetsForPrd()),
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
    const safeMessage = redactSecrets(message).redacted;
    requirement.clarificationTurns.push({
      id: `turn_${randomUUID()}`,
      speaker: "user",
      message: safeMessage,
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
      ...createInterfaceContracts(prd, "draft", now, this.repositoryTargetsForPrd()),
      ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prd.id)
    ];
    await this.save();
    return { requirement, prd, interfaceContracts: this.snapshot.interfaceContracts.filter((item) => item.prdId === prd.id) };
  }

  async approvePrd(prdId: string, options: { actor?: string } = {}) {
    await this.load();
    const prd = this.findPrd(prdId);
    if (prd.status === "approved") {
      const existingWorkItems = this.snapshot.workItems.filter((item) => item.prdId === prdId);
      this.applyConfiguredBudgets(prd, existingWorkItems);
      let existingInterfaceContracts = this.snapshot.interfaceContracts.filter((item) => item.prdId === prdId);
      const existingTestCases = this.ensureTestCasesForWorkItems(prd, existingWorkItems);
      if (existingInterfaceContracts.length === 0) {
        existingInterfaceContracts = await this.registerInterfaceContracts(
          prd,
          createInterfaceContracts(prd, "draft", new Date().toISOString(), this.repositoryTargetsForPrd()),
          existingWorkItems,
          existingTestCases,
          new Date().toISOString()
        );
        this.snapshot.interfaceContracts = [
          ...existingInterfaceContracts,
          ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
        ];
        await this.save();
      } else if (existingInterfaceContracts.some((contract) => this.contractNeedsGeneratedTestRuns(contract))) {
        existingInterfaceContracts = await this.registerInterfaceContracts(
          prd,
          existingInterfaceContracts,
          existingWorkItems,
          existingTestCases,
          new Date().toISOString()
        );
        this.snapshot.interfaceContracts = [
          ...existingInterfaceContracts,
          ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
        ];
        await this.save();
      }
      await this.save();
      return {
        prd,
        workItems: existingWorkItems,
        interfaceContracts: existingInterfaceContracts,
        testCases: this.snapshot.testCases.filter((testCase) => testCase.prdId === prdId)
      };
    }
    const beforeJson = {
      prd: { id: prd.id, status: prd.status, approvedAt: prd.approvedAt || null },
      requirement: { id: prd.requirementId, status: this.findRequirement(prd.requirementId).status }
    };
    const now = new Date().toISOString();
    prd.status = "approved";
    prd.approvedAt = now;

    const requirement = this.findRequirement(prd.requirementId);
    requirement.status = "approved";
    requirement.updatedAt = now;

    const repositoryTargets = this.repositoryTargetsForPrd();
    const workItems = createWorkItems(prd, { repositories: repositoryTargets });
    this.applyConfiguredBudgets(prd, workItems);
    const testCases = createTestCasesForWorkItems(prd, workItems);
    this.snapshot.workItems = [
      ...workItems,
      ...this.snapshot.workItems.filter((item) => item.prdId !== prdId)
    ];
    this.snapshot.testCases = [
      ...testCases,
      ...this.snapshot.testCases.filter((item) => item.prdId !== prdId)
    ];
    const interfaceContracts = await this.registerInterfaceContracts(
      prd,
      createInterfaceContracts(prd, "draft", now, repositoryTargets),
      workItems,
      testCases,
      now
    );
    this.snapshot.interfaceContracts = [
      ...interfaceContracts,
      ...this.snapshot.interfaceContracts.filter((item) => item.prdId !== prdId)
    ];
    this.addAuditEvent({
      actor: options.actor ?? "product_agent",
      action: "prd.approved",
      targetType: "prd",
      targetId: prd.id,
      message: "PRD 已批准，工作项、接口契约和测试用例已生成。",
      requirementId: prd.requirementId,
      prdId: prd.id,
      beforeJson,
      afterJson: {
        prd: { id: prd.id, status: prd.status, approvedAt: prd.approvedAt || null },
        requirement: { id: requirement.id, status: requirement.status },
        workItemIds: workItems.map((item) => item.id),
        interfaceContractIds: interfaceContracts.map((contract) => contract.id),
        testCaseIds: this.snapshot.testCases.filter((testCase) => testCase.prdId === prdId).map((testCase) => testCase.id)
      }
    });
    await this.save();
    return { prd, workItems, interfaceContracts, testCases: this.snapshot.testCases.filter((testCase) => testCase.prdId === prdId) };
  }

  async startTeam(prdId: string, runnerOverride?: AgentRun["runner"], options: { actor?: string } = {}) {
    await this.load();
    const { prd, interfaceContracts } = await this.approvePrd(prdId, options.actor ? { actor: options.actor } : {});
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
    artifactReferences?: IntakeArtifactReferenceInput[];
  }) {
    await this.load();
    const now = new Date().toISOString();
    const bugId = `bug_${randomUUID()}`;
    const requirementId = `req_${bugId}`;
    const safeBugInput = redactJsonValue(input);
    const artifactReferences = this.prepareIntakeArtifactReferences(safeBugInput.artifactReferences ?? [], requirementId, now);
    const requirement = createBugRequirement({
      id: requirementId,
      title: safeBugInput.title,
      description: safeBugInput.description,
      reproductionSteps: safeBugInput.reproductionSteps,
      expectedBehavior: safeBugInput.expectedBehavior,
      actualBehavior: safeBugInput.actualBehavior,
      artifactReferences,
      now
    });
    const prd = createBugPrd(requirement, now);
    const workItem = createBugWorkItem({
      bugId,
      requirementId,
      prdId: prd.id,
      title: safeBugInput.title,
      now
    });
    this.applyConfiguredBudgets(prd, [workItem]);
    const bug: BugReport = {
      id: bugId,
      title: safeBugInput.title,
      description: safeBugInput.description,
      reproductionSteps: safeBugInput.reproductionSteps,
      expectedBehavior: safeBugInput.expectedBehavior,
      actualBehavior: safeBugInput.actualBehavior,
      severity: safeBugInput.severity,
      status: "reported",
      reporter: safeBugInput.reporter?.trim() || "human",
      requirementId,
      prdId: prd.id,
      workItemId: workItem.id,
      artifactReferences,
      createdAt: now,
      updatedAt: now
    };

    this.snapshot.requirements.unshift(requirement);
    this.snapshot.prds.unshift(prd);
    this.snapshot.workItems.unshift(workItem);
    const testCases = createTestCasesForWorkItems(prd, [workItem], now);
    this.snapshot.testCases.unshift(...testCases);
    const interfaceContracts = await this.registerInterfaceContracts(
      prd,
      createInterfaceContracts(prd, "draft", now),
      [workItem],
      testCases,
      now
    );
    this.snapshot.interfaceContracts.unshift(...interfaceContracts);
    this.snapshot.bugs.unshift(bug);
    await this.recordIntakeArtifactReferenceArtifacts(requirement, artifactReferences, now);
    this.addAuditEvent({
      actor: bug.reporter,
      action: "bug.reported",
      targetType: "bug",
      targetId: bug.id,
      message: "用户提交 bug，平台已创建测试 agent 复现任务。",
      requirementId,
      prdId: prd.id,
      workItemId: workItem.id,
      beforeJson: null,
      afterJson: {
        bug: { id: bug.id, status: bug.status, severity: bug.severity },
        requirementId,
        prdId: prd.id,
        workItemId: workItem.id
      }
    });
    await this.save();
    return { bug, requirement, prd, workItem };
  }

  async registerExternalIssueLink(input: ExternalIssueLinkInput) {
    return this.withMutation(async () => {
      await this.load();
      const now = new Date().toISOString();
      const entity = input.entityType === "work_item"
        ? this.findWorkItem(input.entityId)
        : this.findBug(input.entityId);
      const normalized = normalizeExternalIssueStatus({
        provider: input.provider,
        statusName: input.statusName ?? "Todo",
        statusCategory: input.statusCategory
      });
      const link = this.upsertExternalIssueLink(entity, {
        provider: input.provider,
        externalIssueId: input.externalIssueId ?? input.externalKey ?? "",
        ...(input.externalKey ? { externalKey: input.externalKey } : {}),
        ...(input.externalUrl ? { externalUrl: input.externalUrl } : {}),
        statusName: normalized.statusName,
        statusCategory: normalized.statusCategory,
        ...(input.summary ? { summary: input.summary } : {})
      }, now);
      const beforeJson = {
        entity: auditExternalIssueEntityState(entity, input.entityType),
        link: auditExternalIssueLink(link)
      };
      const adapterRecord = await this.issueTrackerAdapters[input.provider].upsertIssue({
        link,
        entity,
        entityType: input.entityType,
        now
      });
      link.statusName = adapterRecord.statusName;
      link.statusCategory = adapterRecord.statusCategory;
      link.lastSyncedAt = adapterRecord.updatedAt;
      link.updatedAt = now;
      const evidence = this.appendExternalIssueEvidence(entity, {
        link,
        direction: "patchpilot_to_external",
        action: "linked",
        message: `PatchPilot ${input.entityType === "work_item" ? "WorkItem" : "Defect"} linked and mirrored to ${input.provider}.`,
        observedAt: now,
        recordedAt: now,
        patchPilotStatusBefore: entity.status,
        patchPilotStatusAfter: entity.status
      });
      this.addAuditEvent({
        actor: "issue_tracker_adapter",
        action: "external_issue.linked",
        targetType: input.entityType === "work_item" ? "work_item" : "bug",
        targetId: entity.id,
        message: `Linked ${input.provider} issue ${link.externalKey || link.externalIssueId} and mirrored PatchPilot state.`,
        requirementId: this.requirementIdForExternalIssueEntity(entity, input.entityType),
        prdId: entity.prdId,
        workItemId: input.entityType === "work_item" ? entity.id : (entity as BugReport).workItemId,
        beforeJson,
        afterJson: {
          entity: auditExternalIssueEntityState(entity, input.entityType),
          link: auditExternalIssueLink(link),
          evidence: auditExternalIssueEvidence(evidence),
          sourceBoundary: "patchpilot_authoritative"
        },
        metadataJson: {
          provider: input.provider,
          externalIssueId: link.externalIssueId,
          externalKey: link.externalKey ?? null,
          direction: "patchpilot_to_external"
        }
      });
      await this.save();
      return this.externalIssueSyncResponse(input.entityType, link, evidence, entity);
    });
  }

  async ingestExternalIssueStatus(input: ExternalIssueStatusUpdateInput) {
    return this.withMutation(async () => {
      await this.load();
      const now = new Date().toISOString();
      const observedAt = input.observedAt ?? now;
      const normalized = normalizeExternalIssueStatus({
        provider: input.provider,
        statusName: input.statusName,
        statusCategory: input.statusCategory
      });
      const target = this.findExternalIssueTarget(input.provider, input.externalIssueId, input.externalKey);
      const entity = target.entity;
      const existingEvidence = input.idempotencyKey
        ? entity.externalIssueSyncEvidence?.find((item) =>
            item.direction === "external_to_patchpilot" && item.idempotencyKey === input.idempotencyKey
          )
        : undefined;
      if (existingEvidence) return this.externalIssueSyncResponse(target.entityType, target.link, existingEvidence, entity);

      const beforeJson = {
        entity: auditExternalIssueEntityState(entity, target.entityType),
        link: auditExternalIssueLink(target.link)
      };
      const beforeStatus = entity.status;
      target.link.statusName = normalized.statusName;
      target.link.statusCategory = normalized.statusCategory;
      target.link.lastSyncedAt = observedAt;
      target.link.updatedAt = now;

      let action: ExternalIssueSyncAction = "observed";
      let message = `${input.provider} issue ${target.link.externalKey || target.link.externalIssueId} status observed as ${normalized.statusName}.`;
      const terminalEntity = isPatchPilotTerminalEntity(entity, target.entityType);
      if (terminalEntity) {
        action = "ignored";
        message = `${message} PatchPilot terminal state remains authoritative.`;
      } else if (shouldExternalStatusBlockWork(normalized.statusCategory)) {
        action = "blocked";
        message = `${message} PatchPilot work is blocked until the external issue is unblocked.`;
        this.applyExternalIssueBlocker(target, normalized.statusName, observedAt, now);
      } else if (shouldExternalStatusTriggerWork(normalized.statusCategory)) {
        const triggered = this.clearExternalIssueBlocker(target, now);
        action = triggered ? "triggered" : "observed";
        message = triggered
          ? `${message} External blocker cleared; PatchPilot work item is ready to run.`
          : `${message} PatchPilot recorded the trigger without handing over source-of-truth state.`;
      } else {
        message = `${message} PatchPilot recorded the external terminal state without completing local work.`;
      }

      const evidence = this.appendExternalIssueEvidence(entity, {
        link: target.link,
        direction: "external_to_patchpilot",
        action,
        statusName: normalized.statusName,
        statusCategory: normalized.statusCategory,
        message,
        actor: input.actor,
        idempotencyKey: input.idempotencyKey,
        observedAt,
        recordedAt: now,
        patchPilotStatusBefore: beforeStatus,
        patchPilotStatusAfter: entity.status
      });
      this.addAuditEvent({
        actor: input.actor || `${input.provider}_webhook`,
        action: "external_issue.status_observed",
        targetType: target.entityType === "work_item" ? "work_item" : "bug",
        targetId: entity.id,
        message,
        requirementId: this.requirementIdForExternalIssueEntity(entity, target.entityType),
        prdId: entity.prdId,
        workItemId: target.entityType === "work_item" ? entity.id : (entity as BugReport).workItemId,
        beforeJson,
        afterJson: {
          entity: auditExternalIssueEntityState(entity, target.entityType),
          link: auditExternalIssueLink(target.link),
          evidence: auditExternalIssueEvidence(evidence),
          sourceBoundary: "patchpilot_authoritative"
        },
        metadataJson: {
          provider: input.provider,
          externalIssueId: target.link.externalIssueId,
          externalKey: target.link.externalKey ?? null,
          direction: "external_to_patchpilot",
          action
        }
      });
      await this.save();
      return this.externalIssueSyncResponse(target.entityType, target.link, evidence, entity);
    });
  }

  async listGitHubAppRepositories() {
    return this.withMutation(async () => {
      await this.load();
      const client = this.githubAppRepositoryClient ??
        createConfiguredGitHubAppRepositoryClient(undefined, undefined, this.githubInstallationIdForRepositoryListing());
      const githubRepositories = await client.listRepositories();
      const now = new Date().toISOString();
      const repositories = this.syncGitHubAppRepositories(githubRepositories, now);
      const installation = this.installationForGitHubRepositories(githubRepositories, now);
      const selectedRepositories = this.selectedGitHubRepositories();
      const selectedRepository = selectedRepositories[0];
      const permissionReady = selectedRepository
        ? selectedRepositories.every((repository) =>
          this.githubRepositoryHasPrPermissions(repository, this.githubInstallationForRepository(repository) ?? installation)
        )
        : repositories.some((repository) => this.githubRepositoryHasPrPermissions(repository, installation));
      this.addAuditEvent({
        actor: "github-app",
        action: "github_app.repositories_synced",
        targetType: "repository",
        targetId: selectedRepository?.id ?? installation?.id ?? "github_app",
        message: `GitHub App repositories synced (${repositories.length}).`,
        beforeJson: null,
        afterJson: {
          installation: installation ? auditGitHubInstallation(installation) : null,
          repositoryIds: repositories.map((repository) => repository.id),
          selectedRepositoryId: selectedRepository?.id ?? null,
          selectedRepositoryIds: selectedRepositories.map((repository) => repository.id),
          permissionReady
        },
        metadataJson: {
          provider: "github",
          repositoryCount: repositories.length,
          permissionReady
        }
      });
      await this.save();
      return {
        ...(installation ? { installation } : {}),
        repositories,
        ...(selectedRepository ? { selectedRepositoryId: selectedRepository.id } : {}),
        ...(selectedRepositories.length > 0 ? { selectedRepositoryIds: selectedRepositories.map((repository) => repository.id) } : {}),
        permissionReady
      };
    });
  }

  async selectGitHubAppRepository(repositoryId: string, options: { actor?: string } = {}) {
    return this.selectGitHubAppRepositories([repositoryId], options);
  }

  async selectGitHubAppRepositories(repositoryIds: string[], options: { actor?: string } = {}) {
    return this.withMutation(async () => {
      await this.load();
      const selectedIds = [...new Set(repositoryIds.map((id) => id.trim()).filter(Boolean))];
      if (selectedIds.length === 0) throw new DomainError("INVALID_STATE", "At least one GitHub repository must be selected.");
      const repositories = selectedIds.map((repositoryId) => {
        const repository = this.snapshot.repositories.find((item) => item.id === repositoryId && item.provider === "github");
        if (!repository) throw new DomainError("NOT_FOUND", `GitHub repository not found: ${repositoryId}`);
        return repository;
      });
      const now = new Date().toISOString();
      const installations = new Map<string, GitHubAppInstallationRecord>();
      for (const repository of repositories) {
        const installation = this.githubInstallationForRepository(repository) ??
          this.createGitHubInstallationFromRepository(repository, now);
        installations.set(installation.id, installation);
        if (!this.githubRepositoryHasPrPermissions(repository, installation)) {
          throw new DomainError("INVALID_STATE", "GitHub App installation does not have repository PR permissions.");
        }
      }
      const primaryRepository = repositories[0];
      if (!primaryRepository) throw new DomainError("INVALID_STATE", "At least one GitHub repository must be selected.");
      const primaryInstallation = this.githubInstallationForRepository(primaryRepository) ??
        this.createGitHubInstallationFromRepository(primaryRepository, now);
      const beforeJson = {
        selectedRepositoryId: primaryInstallation.selectedRepositoryId ?? null,
        selectedRepositoryIds: this.selectedGitHubRepositories().map((repository) => repository.id),
        repositories: this.snapshot.repositories
          .filter((item) => item.provider === "github")
          .map((item) => ({ id: item.id, selected: item.selected ?? false }))
      };
      this.snapshot.repositories.forEach((item) => {
        if (item.provider === "github") {
          item.selected = selectedIds.includes(item.id);
          item.updatedAt = now;
        }
      });
      for (const installation of installations.values()) {
        const selectedForInstallation = repositories.find((repository) =>
          this.githubInstallationForRepository(repository)?.id === installation.id
        );
        if (selectedForInstallation) installation.selectedRepositoryId = selectedForInstallation.id;
        installation.updatedAt = now;
      }
      this.addAuditEvent({
        actor: options.actor ?? "github-app",
        action: "github_app.repository_selected",
        targetType: "repository",
        targetId: primaryRepository.id,
        message: repositories.length === 1
          ? `GitHub repository selected for PatchPilot PR creation: ${primaryRepository.fullName}.`
          : `GitHub repositories selected for PatchPilot PR creation: ${repositories.map((repository) => repository.fullName).join(", ")}.`,
        beforeJson,
        afterJson: {
          installation: auditGitHubInstallation(primaryInstallation),
          repository: auditRepository(primaryRepository),
          repositories: repositories.map((repository) => auditRepository(repository)),
          selectedRepositoryIds: repositories.map((repository) => repository.id),
          permissionReady: true
        },
        metadataJson: {
          provider: "github",
          installationId: primaryInstallation.installationId,
          repositoryId: primaryRepository.githubRepositoryId ?? primaryRepository.id,
          repositoryIds: repositories.map((repository) => repository.githubRepositoryId ?? repository.id),
          fullName: primaryRepository.fullName,
          repositoryCount: repositories.length
        }
      });
      await this.save();
      return {
        installation: primaryInstallation,
        repository: primaryRepository,
        repositories,
        selectedRepositoryIds: repositories.map((repository) => repository.id),
        permissionReady: true
      };
    });
  }

  async ingestGitHubAppWebhook(input: {
    event: string;
    payload: Record<string, unknown>;
    payloadText: string;
    signature?: string;
    secret: string;
    deliveryId?: string;
  }) {
    return this.withMutation(async () => {
      await this.load();
      if (!verifyGitHubWebhookSignature({
        payload: input.payloadText,
        signature: input.signature,
        secret: input.secret
      })) {
        throw new DomainError("INVALID_STATE", "GitHub webhook signature verification failed.");
      }
      const now = new Date().toISOString();
      const payload = input.payload;
      const action = stringFromUnknown(payload.action) ?? "";
      const installation = this.upsertGitHubInstallationFromWebhook(payload, now);
      const repositories = this.upsertGitHubRepositoriesFromWebhook(payload, installation, now);
      this.addAuditEvent({
        actor: "github-webhook",
        action: "github_app.webhook_ingested",
        targetType: "repository",
        targetId: repositories[0]?.id ?? installation?.id ?? "github_app",
        message: `GitHub webhook ingested: ${input.event}${action ? `/${action}` : ""}.`,
        beforeJson: null,
        afterJson: {
          event: input.event,
          action: action || null,
          installation: installation ? auditGitHubInstallation(installation) : null,
          repositoryIds: repositories.map((repository) => repository.id),
          selectedRepositoryId: installation?.selectedRepositoryId ?? null
        },
        metadataJson: {
          provider: "github",
          event: input.event,
          action: action || null,
          deliveryId: input.deliveryId ?? null,
          installationId: installation?.installationId ?? null,
          repositoryCount: repositories.length
        }
      });
      await this.save();
      return {
        accepted: true,
        event: input.event,
        ...(action ? { action } : {}),
        ...(installation ? { installationId: installation.installationId } : {}),
        repositoryCount: repositories.length,
        ...(installation?.selectedRepositoryId ? { selectedRepositoryId: installation.selectedRepositoryId } : {})
      };
    });
  }

  async claimWorkItem(workItemId: string, agentId: string, options: { leaseDurationMs?: number } = {}) {
    return this.withMutation(async () => {
      await this.load();
      const workItem = this.findWorkItem(workItemId);
      const agent = this.findAgent(agentId);
      const now = new Date().toISOString();
      const expiredClaim = workItem.status === "claimed" && this.isClaimExpired(workItem, now);
      if (workItem.status === "blocked" && workItem.externalBlocker) {
        throw new DomainError("INVALID_STATE", "Work item is blocked by an external issue");
      }
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

      const beforeJson = {
        workItem: auditWorkItemState(workItem),
        agent: { id: agent.id, status: agent.status, currentWorkItemId: agent.currentWorkItemId || null }
      };
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
        createdAt: now,
        beforeJson,
        afterJson: {
          workItem: auditWorkItemState(workItem),
          agent: { id: agent.id, status: agent.status, currentWorkItemId: agent.currentWorkItemId || null },
          bug: bug ? { id: bug.id, status: bug.status } : null
        }
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
      const beforeJson = {
        workItem: auditWorkItemState(workItem),
        agent: agent ? { id: agent.id, status: agent.status, currentWorkItemId: agent.currentWorkItemId || null } : null
      };
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
        createdAt: now,
        beforeJson,
        afterJson: {
          workItem: auditWorkItemState(workItem),
          agent: agent ? { id: agent.id, status: agent.status, currentWorkItemId: agent.currentWorkItemId || null } : null
        }
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
      if (workItem.externalBlocker) {
        throw new DomainError("INVALID_STATE", "Work item is blocked by an external issue");
      }
      if (!["ready", "claimed"].includes(workItem.status)) {
        throw new DomainError("INVALID_STATE", "Work item is not ready to start");
      }
      const missingDependencyIds = this.unsatisfiedDependencyIds(workItem);
      if (missingDependencyIds.length > 0) {
        throw new DomainError("INVALID_STATE", `Work item dependencies are not done: ${missingDependencyIds.join(", ")}`);
      }
      const prd = this.findPrd(workItem.prdId);
      const runner = await this.resolveRunner(runnerOverride);
      const now = new Date().toISOString();
      const budgetConfig = readPatchPilotConfig().budget;
      this.applyConfiguredBudgets(prd, [workItem], budgetConfig);
      const budgetCheck = this.evaluateBudget(prd, workItem, defaultRunCostEstimateUsd, budgetConfig);
      const needsBudgetApproval = budgetCheck.hardExceeded.length > 0;
      const beforeWorkItemJson = auditWorkItemState(workItem);

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
      this.telemetry.startAgentRun(run);
      this.pushRunEvent(run, "requirement.understood", "已读取需求说明，正在生成执行计划");
      this.snapshot.agentRuns.unshift(run);

      if (needsBudgetApproval) {
        this.pushRunEvent(run, "agent.progress", "预算硬阈值已触发，run 暂停等待审批");
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
        runId: run.id,
        beforeJson: { workItem: beforeWorkItemJson },
        afterJson: {
          workItem: auditWorkItemState(workItem),
          run: { id: run.id, status: run.status, runner: run.runner }
        }
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
        runId: run.id,
        beforeJson: null,
        afterJson: {
          workspaceRun: {
            id: workspaceRun.id,
            status: workspaceRun.status,
            isolation: workspaceRun.isolation,
            path: workspaceRun.path
          }
        }
      });
      await this.save();

      this.scheduleRunExecution(run.id);
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
    if (status === "accepted") {
      this.assertAcceptanceQualityGate({
        prdId: run.prdId,
        runIds: [run.id],
        workItemIds: [run.workItemId],
        scope: "run"
      });
    }
    const now = new Date().toISOString();
    const beforeJson = {
      acceptance: existing ? { runId: existing.runId, status: existing.status, reason: existing.reason || null } : null,
      workItem: auditWorkItemState(workItem)
    };
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
      runId,
      beforeJson,
      afterJson: {
        acceptance: { runId: decision.runId, status: decision.status, reason: decision.reason || null },
        workItem: auditWorkItemState(workItem)
      }
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

    const acceptanceRuns = workItems
      .map((item) => runsByWorkItem.get(item.id))
      .filter((item): item is AgentRun => item !== undefined && item.status === "succeeded");
    if (status === "accepted") {
      this.assertAcceptanceQualityGate({
        prdId,
        runIds: acceptanceRuns.map((run) => run.id),
        workItemIds: workItems.map((item) => item.id),
        scope: "prd"
      });
    }

    const now = new Date().toISOString();
    const decisions: AcceptanceDecision[] = [];
    for (const [workItemId, run] of runsByWorkItem) {
      if (run.status !== "succeeded") continue;
      const workItem = this.findWorkItem(workItemId);
      const existing = this.snapshot.acceptances.find((item) => item.runId === run.id);
      const beforeJson = {
        acceptance: existing ? { runId: existing.runId, status: existing.status, reason: existing.reason || null } : null,
        workItem: auditWorkItemState(workItem)
      };
      const decision: AcceptanceDecision = {
        runId: run.id,
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
        targetId: run.id,
        message: status === "accepted" ? "用户接受了团队交付结果。" : "用户要求团队交付返工。",
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId,
        runId: run.id,
        beforeJson,
        afterJson: {
          acceptance: { runId: decision.runId, status: decision.status, reason: decision.reason || null },
          workItem: auditWorkItemState(workItem)
        }
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
    return redactJsonValue(structuredClone(this.findRun(runId)));
  }

  async getRequirementBundle(requirementId: string) {
    await this.load();
    const requirement = this.findRequirement(requirementId);
    const prd = this.snapshot.prds.find((item) => item.requirementId === requirementId);
    const workItems = prd ? this.snapshot.workItems.filter((item) => item.prdId === prd.id) : [];
    const interfaceContracts = prd
      ? this.snapshot.interfaceContracts.filter((item) => item.prdId === prd.id)
      : [];
    return redactJsonValue({ requirement, prd, workItems, interfaceContracts });
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

    const config = readPatchPilotConfig();
    const capabilityManifest = generateCapabilityManifest({
      runId,
      prdId: prd.id,
      workItem,
      testCommand: config.test.command,
      testTimeoutMs: config.test.timeoutMs,
      security: config.security,
      budget: config.budget,
      createdBy: "scheduler"
    });
    const manifestSummary = summarizeCapabilityManifest(capabilityManifest);
    this.addAuditEvent({
      actor: "policy",
      action: "capability_manifest.activated",
      targetType: "agent_run",
      targetId: run.id,
      message: "Capability Manifest 已为 agent run 激活。",
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      runId: run.id,
      beforeJson: null,
      afterJson: {
        manifest: manifestSummary
      },
      metadataJson: manifestSummary
    });
    const secretBrokerResolution = await this.resolveAndAuditSecretBroker(
      run,
      workItem,
      config.security.secretBroker,
      capabilityManifest
    );
    const redactionOptions = { knownSecrets: Object.values(secretBrokerResolution.env) };
    let result: AgentRunResult | undefined;
    let runError: unknown;
    try {
      result = await this.codexRunner.run(
        { runId, requirement, prd, workItem },
        (event) => this.appendRunEvent(runId, event, redactionOptions),
        {
          ...config,
          policyManifest: capabilityManifest,
          security: {
            ...config.security,
            secretEnv: secretBrokerResolution.env
          }
        }
      );
    } catch (error) {
      runError = redactRunError(error, redactionOptions);
    }
    const revocationEvidence = await this.revokeAndAuditSecretBroker(
      run,
      workItem,
      config.security.secretBroker,
      secretBrokerResolution
    );
    secretBrokerResolution.evidence.revoked.push(...revocationEvidence);
    if (runError) {
      throw attachSecretBrokerEvidence(runError, secretBrokerResolution.evidence);
    }
    if (!result) throw createRunFailureError("Codex runner did not return a result.", "environment_failed");
    if (secretBrokerResolution.evidence.requestedSecretIds.length > 0) {
      result.secretBrokerEvidence = secretBrokerResolution.evidence;
    }
    const redactedResult = redactJsonValue(result, redactionOptions);

    await this.load();
    const completedRun = this.findRun(runId);
    const completedWorkItem = this.findWorkItem(completedRun.workItemId);
    completedRun.timeline = completeTimeline(completedRun.timeline);
    completedRun.currentStep = "confirming";
    this.pushRunEvent(completedRun, "review.completed", "Reviewer agent 已整理执行证据，等待你确认");
    this.pushRunEvent(completedRun, "acceptance.waiting", "执行完成，请查看证据摘要并确认");
    completedRun.result = redactedResult;
    completedRun.costActualUsd = 0;
    completedRun.endedAt = new Date().toISOString();
    completedWorkItem.status = "review";
    completedWorkItem.updatedAt = completedRun.endedAt;
    this.completeAgentAssignment(completedWorkItem.id, completedRun.endedAt);
    await this.recordCompletedRunEvidence(completedRun, completedWorkItem, redactedResult.tests, completedRun.endedAt, "succeeded", redactionOptions);
    completedRun.status = "succeeded";
    this.telemetry.endAgentRun(completedRun, "succeeded");
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
        this.pushRunEvent(run, item.type, item.message);
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
      this.pushRunEvent(run, "acceptance.waiting", "执行完成，请查看证据摘要并确认");
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
      this.completeAgentAssignment(workItem.id, run.endedAt);
      await this.recordCompletedRunEvidence(run, workItem, tests, run.endedAt, "succeeded");
      run.status = "succeeded";
      this.telemetry.endAgentRun(run, "succeeded");
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
    this.pushRunEvent(run, "run.failed", `执行失败，已分类为 ${failureTypeLabel(failure.failureType)}`);
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
        runId: run.id,
        beforeJson: {
          run: { id: run.id, status: "running" },
          workItem: auditWorkItemState(workItem)
        },
        afterJson: {
          run: {
            id: run.id,
            status: "failed",
            failureType: failure.failureType,
            failureSummary: run.failureSummary || null
          },
          workItem: { ...auditWorkItemState(workItem), status: "blocked", updatedAt: endedAt }
        }
      });
      this.recordEgressPolicyAudit(
        run,
        workItem,
        failure.egressPolicyEvidence ?? failure.testRun?.egressPolicyEvidence,
        endedAt
      );
      this.recordCommandPolicyDeniedAudit(run, workItem, failure.commandAuditEvents, endedAt);
      this.completeAgentAssignment(workItem.id, endedAt);
      workItem.status = "blocked";
      workItem.updatedAt = endedAt;
    }
    run.status = "failed";
    this.telemetry.endAgentRun(run, "failed");
    await this.save();
  }

  private async appendRunEvent(
    runId: string,
    event: CodexRunnerEvent,
    redactionOptions: SecretRedactionOptions = {}
  ) {
    await this.load();
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run || run.status !== "running") return;
    if (event.step) {
      run.currentStep = event.step;
      run.timeline = advanceTimeline(run.timeline, event.step);
    }
    this.pushRunEvent(run, event.type, event.message, redactionOptions);
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

  private findBug(id: string) {
    const bug = this.snapshot.bugs.find((item) => item.id === id);
    if (!bug) throw new DomainError("NOT_FOUND", `Defect not found: ${id}`);
    return bug;
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

  private pushRunEvent(
    run: AgentRun,
    type: AgentRunEvent["type"],
    message: string,
    redactionOptions: SecretRedactionOptions = {}
  ) {
    const event = this.makeEvent(type, redactSecrets(message, redactionOptions).redacted);
    run.events.push(event);
    this.telemetry.recordRunEvent(run, event);
    return event;
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
      createdAt: now,
      beforeJson: null,
      afterJson: {
        approval: auditApprovalState(approval)
      }
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
        runId: approval.runId,
        beforeJson: {
          approval: {
            id: approval.id,
            status: "pending"
          }
        },
        afterJson: {
          approval: auditApprovalState(approval)
        }
      });

      const resumeRunId =
        status === "approved"
          ? this.resumeBudgetGatedRun(approval, input.decidedBy, now)
          : this.recordBudgetApprovalDenied(approval, input.decidedBy, now);
      if (status === "approved") {
        this.promoteBreakingContractApproval(approval, input.decidedBy, now);
      } else {
        this.recordBreakingContractApprovalDenied(approval, input.decidedBy, now);
      }
      const output = structuredClone(approval);
      await this.save();
      if (resumeRunId) this.scheduleRunExecution(resumeRunId);
      return output;
    });
  }

  private scheduleRunExecution(runId: string) {
    const execution = this.executeRun(runId).finally(() => {
      this.activeExecutions.delete(execution);
    });
    this.activeExecutions.add(execution);
  }

  private resumeBudgetGatedRun(approval: ApprovalRecord, actor: string, now: string) {
    if (approval.kind !== "budget_exceeded" || approval.targetType !== "agent_run") return undefined;
    const runId = approval.runId || approval.targetId;
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run || run.status !== "needs_approval") return undefined;
    const workItem = this.findWorkItem(run.workItemId);
    const beforeJson = {
      run: { id: run.id, status: run.status },
      workItem: auditWorkItemState(workItem),
      approval: auditApprovalState(approval)
    };

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
    this.pushRunEvent(run, "agent.progress", "预算审批已通过，run 继续执行");
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
      createdAt: now,
      beforeJson,
      afterJson: {
        run: { id: run.id, status: run.status },
        workItem: auditWorkItemState(workItem),
        approval: auditApprovalState(approval)
      }
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
      createdAt: now,
      beforeJson: null,
      afterJson: {
        workspaceRun: {
          id: workspaceRun.id,
          status: workspaceRun.status,
          isolation: workspaceRun.isolation,
          path: workspaceRun.path
        }
      }
    });
    return run.id;
  }

  private recordBudgetApprovalDenied(approval: ApprovalRecord, actor: string, now: string) {
    if (approval.kind !== "budget_exceeded" || approval.targetType !== "agent_run") return undefined;
    const runId = approval.runId || approval.targetId;
    const run = this.snapshot.agentRuns.find((item) => item.id === runId);
    if (!run || run.status !== "needs_approval") return undefined;
    this.pushRunEvent(run, "agent.progress", "预算审批被拒绝，run 继续保持暂停");
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
      createdAt: now,
      beforeJson: {
        run: { id: run.id, status: run.status },
        approval: auditApprovalState(approval)
      },
      afterJson: {
        run: { id: run.id, status: run.status },
        approval: auditApprovalState(approval)
      }
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
      this.recordBreakingContractApprovalExpired(approval, now);
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
      createdAt: now,
      beforeJson: {
        approval: {
          id: approval.id,
          status: "pending"
        }
      },
      afterJson: {
        approval: auditApprovalState(approval)
      }
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
      createdAt: now,
      beforeJson: {
        run: { id: run.id, status: "queued" }
      },
      afterJson: {
        run: { id: run.id, status: run.status, budgetApprovalId: run.budgetApprovalId || null }
      },
      metadataJson: { hardExceeded: budgetCheck.hardExceeded.map(auditBudgetScope) }
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
        createdAt: now,
        beforeJson: null,
        afterJson: { run: { id: run.id, status: run.status } },
        metadataJson: { softExceeded: [auditBudgetScope(scope)] }
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
    const repository = await this.repositoryPromise;
    await repository?.replaceSnapshot(this.snapshot);
    if (!this.dataFilePath) return;
    await mkdir(dirname(this.dataFilePath), { recursive: true });
    const tempFile = `${this.dataFilePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tempFile, JSON.stringify(this.snapshot, null, 2));
    await rename(tempFile, this.dataFilePath);
  }

  private async readLegacyJsonSnapshotIfPresent() {
    if (!this.dataFilePath) return undefined;
    try {
      const raw = await readFile(this.dataFilePath, "utf8");
      return JSON.parse(raw) as PatchPilotSnapshot;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new DomainError("STORE_CORRUPT", "Store file could not be read or parsed");
    }
  }

  private normalizeSnapshot() {
    const now = new Date().toISOString();
    this.snapshot.repositories ||= [];
    this.snapshot.githubInstallations ||= [];
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
    this.snapshot.auditEvents = this.normalizeAuditEvents(this.snapshot.auditEvents || [], now);
    this.snapshot.acceptances ||= [];
    this.snapshot.approvals ||= [];
    this.snapshot.bugs ||= [];
    this.snapshot.agents = this.mergeDefaultAgents(this.snapshot.agents || [], now);
    this.snapshot.repositories = this.snapshot.repositories.map((repository) => ({
      ...repository,
      fullName: repository.fullName || `${repository.owner}/${repository.name}`,
      selected: repository.selected ?? false,
      permissions: repository.permissions ?? {},
      createdAt: repository.createdAt || now,
      updatedAt: repository.updatedAt || repository.createdAt || now
    }));
    this.snapshot.githubInstallations = this.snapshot.githubInstallations.map((installation) => ({
      ...installation,
      repositorySelection: installation.repositorySelection || "selected",
      permissions: installation.permissions ?? {},
      createdAt: installation.createdAt || now,
      updatedAt: installation.updatedAt || installation.createdAt || now
    }));
    this.snapshot.approvals = this.snapshot.approvals.map((item) => ({
      ...item,
      status: item.status || "pending",
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || item.createdAt || now
    }));
    this.snapshot.bugs = this.snapshot.bugs.map((item) => ({
      ...item,
      status: normalizeBugStatus(item.status),
      artifactReferences: this.normalizeStoredIntakeArtifactReferences(item.artifactReferences, item.requirementId, item.createdAt || now),
      externalIssueLinks: item.externalIssueLinks ?? [],
      externalIssueSyncEvidence: item.externalIssueSyncEvidence ?? [],
      externalBlocker: item.externalBlocker,
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
      artifactReferences: this.normalizeStoredIntakeArtifactReferences(item.artifactReferences, item.id, item.createdAt || now),
      clarificationTurns:
        item.clarificationTurns && item.clarificationTurns.length > 0
          ? item.clarificationTurns
          : [createInitialClarificationTurn(item.rawInput, item.template, item.createdAt || now)]
    }));
    this.snapshot.workItems = this.snapshot.workItems.map((item) => ({
      ...item,
      role: item.role || (item.sourceBugId ? "test" : "backend"),
      version: item.version ?? 1,
      externalIssueLinks: item.externalIssueLinks ?? [],
      externalIssueSyncEvidence: item.externalIssueSyncEvidence ?? [],
      externalBlocker: item.externalBlocker,
      createdAt: item.createdAt || now,
      updatedAt: item.updatedAt || now
    }));
    this.rebuildAgentBusyState(now);
  }

  private normalizeAuditEvents(events: Array<Partial<AuditEvent> & { actor?: string }>, now: string): AuditEvent[] {
    let needsMigration = false;
    const normalized = events.map((event) => {
      const actor = normalizeAuditActor(event.actorId || event.actor);
      if (
        !event.actorType ||
        !event.actorId ||
        !("beforeJson" in event) ||
        !("afterJson" in event) ||
        !("metadataJson" in event) ||
        !("previousHash" in event) ||
        !event.hash
      ) {
        needsMigration = true;
      }

      return {
        id: event.id || `audit_${randomUUID()}`,
        traceId: event.traceId || event.runId || event.prdId || event.requirementId || event.targetId || "trace_legacy",
        actorType: event.actorType || actor.actorType,
        actorId: event.actorId || actor.actorId,
        actor: event.actor || event.actorId || actor.actorId,
        action: event.action || "audit.legacy",
        targetType: event.targetType || "requirement",
        targetId: event.targetId || "legacy",
        message: event.message || "Legacy audit event migrated into the formal audit schema.",
        beforeJson: "beforeJson" in event ? event.beforeJson ?? null : null,
        afterJson: "afterJson" in event ? event.afterJson ?? null : null,
        metadataJson:
          "metadataJson" in event
            ? event.metadataJson ?? {}
            : {
              migratedFromLegacy: true,
              legacyActor: event.actor || null
            },
        hash: event.hash || "",
        previousHash: "previousHash" in event ? event.previousHash ?? null : null,
        ...(event.requirementId ? { requirementId: event.requirementId } : {}),
        ...(event.prdId ? { prdId: event.prdId } : {}),
        ...(event.workItemId ? { workItemId: event.workItemId } : {}),
        ...(event.runId ? { runId: event.runId } : {}),
        createdAt: event.createdAt || now
      };
    }) satisfies AuditEvent[];

    if (!needsMigration) return normalized;

    let previousHash: string | null = null;
    const migratedOldestFirst = [...normalized].reverse().map((event) => {
      const migratedEvent = {
        ...event,
        previousHash
      };
      migratedEvent.hash = computeAuditEventHash(migratedEvent);
      previousHash = migratedEvent.hash;
      return migratedEvent;
    });
    return migratedOldestFirst.reverse();
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
    const workItem = this.snapshot.workItems.find((item) => item.id === workItemId);
    if (["ready", "claimed"].includes(status)) return Boolean(workItem && this.unsatisfiedDependencyIds(workItem).length === 0);
    const existingRun = this.snapshot.agentRuns.find(
      (item) => item.workItemId === workItemId && !["failed", "cancelled"].includes(item.status)
    );
    return Boolean(existingRun && ["running", "review", "done"].includes(status));
  }

  private unsatisfiedDependencyIds(workItem: WorkItem) {
    return (workItem.dependsOn ?? []).filter((dependencyId) => {
      const dependency = this.snapshot.workItems.find((candidate) => candidate.id === dependencyId);
      return dependency?.status !== "done";
    });
  }

  private shouldStartReworkRun(workItem: WorkItem, run: AgentRun) {
    if (!["ready", "claimed"].includes(workItem.status) || run.status !== "succeeded") return false;
    return this.isRunRejected(run.id);
  }

  private isRunRejected(runId: string) {
    return this.snapshot.acceptances.some((acceptance) => acceptance.runId === runId && acceptance.status === "rejected");
  }

  private assertAcceptanceQualityGate(input: { prdId: string; runIds: string[]; workItemIds: string[]; scope: "run" | "prd" }) {
    const gate = evaluateAcceptanceQualityGate({
      snapshot: this.snapshot,
      prdId: input.prdId,
      runIds: input.runIds,
      workItemIds: input.workItemIds,
      scope: input.scope
    });
    if (!gate.passed) {
      throw new DomainError("INVALID_STATE", `Acceptance quality gate failed: ${gate.blockingReasons.join("; ")}`);
    }
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
    const beforeJson = { workItem: auditWorkItemState(workItem) };
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
      createdAt: now,
      beforeJson,
      afterJson: { workItem: auditWorkItemState(workItem) },
      metadataJson: { reason: normalizedReason }
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
      ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
      ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
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
    options: {
      workspaceStatus: WorkspaceRun["status"];
      workspacePath?: string;
      finalRunStatus?: AgentRun["status"];
      redactionOptions?: SecretRedactionOptions;
    }
  ) {
    const prd = this.findPrd(run.prdId);
    const workItemTestCases = this.ensureTestCasesForWorkItems(prd, [workItem], endedAt);
    const testCase = workItemTestCases.find((candidate) => !isGeneratedContractTestCase(candidate)) ??
      workItemTestCases[0];
    const normalizedTests: TestRun[] = tests.map((test) => {
      const logArtifactId = test.logArtifactId || `artifact_test_log_${test.id}`;
      const workspacePath = test.workspacePath || options.workspacePath || run.result?.workspacePath || `simulated://${run.id}`;
      return redactJsonValue({
        ...test,
        testCaseId: test.testCaseId || testCase?.id,
        runId: run.id,
        prdId: run.prdId,
        workItemId: workItem.id,
        ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
        ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
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
      }, options.redactionOptions);
    });

    if (run.result) {
      run.result.tests = normalizedTests;
    }

    await this.recordRunArtifacts(run, workItem, normalizedTests, endedAt, options.finalRunStatus, options.redactionOptions);

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
        createdAt: test.endedAt || endedAt,
        beforeJson: null,
        afterJson: {
          testRun: {
            id: test.id,
            status: test.status,
            command: test.command,
            durationMs: test.durationMs,
            repositoryId: test.repositoryId ?? null,
            artifactIds: test.artifactIds || []
          }
        }
      });
      this.telemetry.recordTestRun(run, test);
    }

    return normalizedTests;
  }

  private async recordRunArtifacts(
    run: AgentRun,
    workItem: WorkItem,
    tests: TestRun[],
    endedAt: string,
    finalRunStatus = run.status,
    redactionOptions: SecretRedactionOptions = {}
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
        content: redactSecrets(renderTestLog(test), redactionOptions).redacted,
        contentType: "text/plain",
        extension: ".log",
        metadata: {
          command: redactSecrets(test.command, redactionOptions).redacted,
          status: test.status
        },
        ...common,
        testRunId: test.id
      });
      const reportRecord = await artifactStore.putArtifact({
        id: `artifact_test_report_${test.id}`,
        kind: "test_report",
        content: JSON.stringify(redactJsonValue(test, redactionOptions), null, 2),
        contentType: "application/json",
        extension: ".json",
        metadata: {
          command: redactSecrets(test.command, redactionOptions).redacted,
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
      content: JSON.stringify(redactJsonValue({
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
          testOutputSummary: run.result?.testOutputSummary,
          egressPolicyEvidence: run.result?.egressPolicyEvidence,
          secretBrokerEvidence: run.result?.secretBrokerEvidence
        }
      }, redactionOptions), null, 2),
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
      content: JSON.stringify(redactJsonValue({
        diffSummary: run.result?.diffSummary ?? buildRunDiffSummary(run.result?.changedFiles ?? [], run.result),
        changedFiles: run.result?.changedFiles ?? [],
        branchName: run.result?.branchName,
        baseBranch: run.result?.baseBranch,
        baseCommit: run.result?.baseCommit,
        headCommit: run.result?.headCommit
      }, redactionOptions), null, 2),
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
      content: JSON.stringify(redactJsonValue({
        previewUrl: run.result?.previewUrl,
        workspacePath: run.result?.workspacePath,
        runner: run.runner
      }, redactionOptions), null, 2),
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
      run.result.tests = redactJsonValue(tests, redactionOptions);
    }
  }

  private prepareIntakeArtifactReferences(
    references: IntakeArtifactReferenceInput[],
    ownerId: string,
    now: string
  ): IntakeArtifactReference[] {
    return references
      .filter((reference) => reference.label?.trim())
      .slice(0, 12)
      .map((reference, index) => {
        const id = safeReferenceSegment(reference.id || `input_${ownerId}_${index + 1}`);
        const metadata = sanitizeReferenceMetadata(reference.metadata);
        return {
          id,
          kind: reference.kind,
          label: redactSecrets(reference.label.trim()).redacted,
          ...(reference.uri?.trim() ? { uri: redactSecrets(reference.uri.trim()).redacted } : {}),
          ...(reference.contentType?.trim() ? { contentType: redactSecrets(reference.contentType.trim()).redacted } : {}),
          ...(typeof reference.sizeBytes === "number" ? { sizeBytes: reference.sizeBytes } : {}),
          artifactId: reference.artifactId?.trim() || `artifact_intake_${id}`,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          createdAt: reference.createdAt || now
        };
      });
  }

  private normalizeStoredIntakeArtifactReferences(
    references: IntakeArtifactReference[] | undefined,
    ownerId: string,
    fallbackCreatedAt: string
  ): IntakeArtifactReference[] {
    return (references ?? [])
      .filter((reference) => reference.label?.trim())
      .slice(0, 12)
      .map((reference, index) => {
        const id = safeReferenceSegment(reference.id || `input_${ownerId}_${index + 1}`);
        const metadata = sanitizeReferenceMetadata(reference.metadata);
        return {
          id,
          kind: normalizeIntakeArtifactKind(reference.kind),
          label: redactSecrets(reference.label.trim()).redacted,
          ...(reference.uri?.trim() ? { uri: redactSecrets(reference.uri.trim()).redacted } : {}),
          ...(reference.contentType?.trim() ? { contentType: redactSecrets(reference.contentType.trim()).redacted } : {}),
          ...(typeof reference.sizeBytes === "number" ? { sizeBytes: reference.sizeBytes } : {}),
          artifactId: reference.artifactId?.trim() || `artifact_intake_${id}`,
          ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
          createdAt: reference.createdAt || fallbackCreatedAt
        };
      });
  }

  private async recordIntakeArtifactReferenceArtifacts(
    requirement: Requirement,
    references: IntakeArtifactReference[],
    now: string
  ) {
    if (references.length === 0) return;
    const artifactStore = this.getArtifactStore();
    const records: ArtifactRecord[] = [];
    for (const reference of references) {
      const record = await artifactStore.putArtifact({
        id: reference.artifactId,
        kind: "intake_attachment",
        content: JSON.stringify({
          requirementId: requirement.id,
          kind: reference.kind,
          label: reference.label,
          uri: reference.uri,
          contentType: reference.contentType,
          sizeBytes: reference.sizeBytes,
          metadata: reference.metadata ?? {}
        }, null, 2),
        contentType: "application/json",
        extension: ".json",
        metadata: {
          intakeKind: reference.kind,
          label: reference.label,
          ...(reference.uri ? { uri: reference.uri } : {}),
          ...(reference.contentType ? { contentType: reference.contentType } : {})
        },
        requirementId: requirement.id,
        createdAt: now
      });
      records.push(record);
    }
    this.upsertArtifactRecords(records);
  }

  private async registerInterfaceContracts(
    prd: Prd,
    contracts: InterfaceContract[],
    workItems: WorkItem[],
    testCases: TestCase[],
    now: string
  ) {
    const artifactsById = new Map(buildContractRegistryArtifacts().map((artifact) => [artifact.artifactId, artifact]));
    const registered: InterfaceContract[] = [];
    for (const contract of contracts) {
      const artifactId = contract.registry?.artifactId ?? artifactIdFromContractId(contract.id);
      const artifact = artifactId ? artifactsById.get(artifactId) : undefined;
      if (!artifact) {
        registered.push(contract);
        continue;
      }

      const baseline = this.findLatestApprovedContractBaseline(artifact, contract, prd.id);
      const contentChanged = baseline?.contentHash !== artifact.contentHash;
      const revision = baseline ? baseline.revision + (contentChanged ? 1 : 0) : 1;
      const proposedRevisionId = baseline && !contentChanged
        ? baseline.revisionId
        : `cr_${contract.repositoryId ? `${safeRepositorySegment(contract.repositoryId)}_` : ""}${artifact.artifactId}_r${revision}_${shortHash(artifact.contentHash)}`;
      const beforeJson = contract.registry
        ? { contract: auditInterfaceContractState(contract), registry: auditContractRegistryState(contract.registry) }
        : null;
      const registry = createContractRegistryMetadata({
        baseline,
        proposed: artifact,
        proposedRevisionId,
        revision,
        now
      });
      if (registry.status === "approved") {
        registry.approvedRevisionId = registry.revisionId;
        registry.approvedAt = now;
      }

      contract.version = registry.revision;
      contract.status = registry.status;
      contract.providerRole = artifact.providerRole;
      contract.consumerRoles = artifact.consumerRoles;
      contract.specMarkdown = artifact.specMarkdown;
      contract.testSuggestions = artifact.testSuggestions;
      contract.registry = registry;
      contract.updatedAt = now;

      this.addAuditEvent({
        actor: "contract_registry",
        action: "contract.revision_proposed",
        targetType: "interface_contract",
        targetId: contract.id,
        message: `${contract.name} contract revision ${registry.revision} proposed from ${artifact.sourceRef}.`,
        requirementId: prd.requirementId,
        prdId: prd.id,
        createdAt: now,
        beforeJson,
        afterJson: {
          contract: auditInterfaceContractState(contract),
          registry: auditContractRegistryState(registry)
        }
      });

      const diffArtifact = await this.recordContractDiffArtifact(prd, contract, workItems, registry.diff, now);
      const contractTestCases = this.ensureContractTestCasesForContract(prd, contract, artifact, workItems, testCases, now);
      const contractTestRuns = buildContractTestRequirements(artifact).map((requirement) =>
        this.createContractRequirementTestRun(prd, contract, registry, requirement, contractTestCases, diffArtifact?.id, now)
      );
      registry.testRunIds = contractTestRuns.map((testRun) => testRun.id);
      for (const testRun of contractTestRuns) {
        this.upsertContractTestRun(testRun, contractTestCases, now);
        this.addContractTestRunAudit(prd, contract, testRun, now);
      }
      const registryDiffTestRun = contractTestRuns.find((testRun) => testRun.runner === "patchpilot-contract-registry") ??
        contractTestRuns[0];
      if (!registryDiffTestRun) throw new DomainError("INVALID_STATE", `No contract registry TestRun was generated for ${contract.name}`);

      this.addAuditEvent({
        actor: "contract_registry",
        action: "contract.diff_completed",
        targetType: "interface_contract",
        targetId: contract.id,
        message: contractDiffMessage(contract, registry.diff),
        requirementId: prd.requirementId,
        prdId: prd.id,
        workItemId: registryDiffTestRun.workItemId,
        createdAt: now,
        beforeJson: null,
        afterJson: {
          contract: auditInterfaceContractState(contract),
          diff: auditContractDiffState(registry.diff),
          testRunIds: registry.testRunIds,
          testRuns: contractTestRuns.map((testRun) => ({
            id: testRun.id,
            status: testRun.status,
            runner: testRun.runner,
            command: testRun.command,
            artifactIds: testRun.artifactIds ?? []
          }))
        }
      });

      if (registry.diff?.hasBreakingChanges) {
        const approval = this.ensureBreakingContractApproval(prd, contract, registry, registryDiffTestRun, now);
        registry.approvalId = approval.id;
        registryDiffTestRun.summary = `Breaking contract diff detected for ${contract.name}; approval ${approval.id} is required.`;
      } else if (contentChanged || !baseline) {
        this.addContractBaselinePromotedAudit(prd, contract, "contract_registry", now);
      }

      registered.push(contract);
    }
    return registered;
  }

  private findLatestApprovedContractBaseline(
    artifact: ContractRegistryArtifact,
    proposedContract: InterfaceContract,
    currentPrdId: string
  ): ContractRegistryMetadata | undefined {
    return this.snapshot.interfaceContracts
      .filter((contract) =>
        contract.prdId !== currentPrdId &&
        contract.status === "approved" &&
        (contract.repositoryId ?? null) === (proposedContract.repositoryId ?? null) &&
        contract.registry?.artifactId === artifact.artifactId &&
        contract.registry.providerRole === artifact.providerRole
      )
      .map((contract) => contract.registry)
      .filter((registry): registry is ContractRegistryMetadata => Boolean(registry))
      .sort((left, right) => {
        if (left.revision !== right.revision) return right.revision - left.revision;
        return (right.approvedAt ?? "").localeCompare(left.approvedAt ?? "");
      })[0];
  }

  private contractNeedsGeneratedTestRuns(contract: InterfaceContract) {
    if (!contract.registry) return true;
    const registry = contract.registry;
    const artifactId = registry.artifactId ?? artifactIdFromContractId(contract.id);
    const artifact = artifactId ? buildContractRegistryArtifacts().find((candidate) => candidate.artifactId === artifactId) : undefined;
    const requiredTestRunIds = artifact
      ? buildContractTestRequirements(artifact).map((requirement) =>
          contractTestRunId(contract, registry, requirement)
        )
      : [];
    const recordedTestRunIds = registry.testRunIds ?? [];
    if (requiredTestRunIds.length === 0) return recordedTestRunIds.length === 0;
    if (recordedTestRunIds.length !== requiredTestRunIds.length) return true;
    const recordedIds = new Set(recordedTestRunIds);
    if (!requiredTestRunIds.every((id) => recordedIds.has(id))) return true;
    const testRunsById = new Map(this.snapshot.testRuns.map((testRun) => [testRun.id, testRun]));
    return requiredTestRunIds.some((id) => testRunsById.get(id)?.status !== "passed");
  }

  private async recordContractDiffArtifact(
    prd: Prd,
    contract: InterfaceContract,
    workItems: WorkItem[],
    diff: ContractDiffSummary | undefined,
    now: string
  ) {
    if (!diff) return undefined;
    const workItem = this.findProviderWorkItem(workItems, contract.providerRole, contract.repositoryId);
    const artifactStore = this.getArtifactStore();
    const record = await artifactStore.putArtifact({
      id: `artifact_contract_diff_${shortHash(`${contract.id}:${diff.id}`)}`,
      kind: "diff",
      content: JSON.stringify({
        contractId: contract.id,
        artifactId: contract.registry?.artifactId,
        registryRevisionId: contract.registry?.revisionId,
        diff
      }, null, 2),
      contentType: "application/json",
      extension: ".json",
      metadata: {
        contractId: contract.id,
        artifactId: contract.registry?.artifactId ?? contract.id,
        status: diff.status,
        breaking: String(diff.hasBreakingChanges)
      },
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId: workItem?.id,
      createdAt: now
    });
    this.upsertArtifactRecords([record]);
    return record;
  }

  private ensureContractTestCasesForContract(
    prd: Prd,
    contract: InterfaceContract,
    artifact: ContractRegistryArtifact,
    workItems: WorkItem[],
    testCases: TestCase[],
    now: string
  ): TestCase[] {
    const contractTestCases: TestCase[] = [];
    for (const requirement of buildContractTestRequirements(artifact)) {
      const workItem = this.findContractTestWorkItem(workItems, requirement, contract.providerRole, contract.repositoryId);
      if (!workItem) {
        throw new DomainError("INVALID_STATE", `No work item can own contract test requirement ${requirement.id}`);
      }
      const id = contractTestCaseId(contract, requirement);
      const existing = this.snapshot.testCases.find((candidate) => candidate.id === id) ??
        testCases.find((candidate) => candidate.id === id);
      const next: TestCase = {
        id,
        requirementId: prd.requirementId,
        prdId: prd.id,
        workItemId: workItem.id,
        ...(contract.repositoryId ? { repositoryId: contract.repositoryId } : {}),
        ...(contract.repositoryFullName ? { repositoryFullName: contract.repositoryFullName } : {}),
        title: requirement.title,
        kind: "contract",
        status: existing?.status ?? "ready",
        priority: "high",
        steps: requirement.steps,
        expectedResult: requirement.expectedResult,
        linkedAcceptanceCriteria: workItem.acceptanceCriteria,
        ...(existing?.lastRunId ? { lastRunId: existing.lastRunId } : {}),
        ...(existing?.lastTestRunId ? { lastTestRunId: existing.lastTestRunId } : {}),
        ...(existing?.flaky !== undefined ? { flaky: existing.flaky } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      };
      if (existing) Object.assign(existing, next);
      else {
        this.snapshot.testCases.unshift(next);
        testCases.push(next);
      }
      contractTestCases.push(existing ?? next);
    }
    return contractTestCases;
  }

  private findContractTestWorkItem(
    workItems: WorkItem[],
    requirement: ContractTestRequirement,
    providerRole: WorkItemRole,
    repositoryId: string | undefined
  ) {
    const scopedWorkItems = this.workItemsForRepository(workItems, repositoryId);
    if (requirement.requirementKind === "registry_diff" || requirement.requirementKind === "provider_validation") {
      return this.findProviderWorkItem(scopedWorkItems, providerRole, repositoryId);
    }
    if (requirement.participantLabel === "worker consumer") {
      return scopedWorkItems.find((workItem) => workItem.role === "ops") ??
        this.findProviderWorkItem(scopedWorkItems, providerRole, repositoryId);
    }
    if (requirement.participantRole === "reviewer") {
      return scopedWorkItems.find((workItem) => workItem.role === "test") ??
        this.findProviderWorkItem(scopedWorkItems, providerRole, repositoryId);
    }
    return scopedWorkItems.find((workItem) => workItem.role === requirement.participantRole) ??
      this.findProviderWorkItem(scopedWorkItems, providerRole, repositoryId);
  }

  private createContractRequirementTestRun(
    prd: Prd,
    contract: InterfaceContract,
    registry: ContractRegistryMetadata,
    requirement: ContractTestRequirement,
    testCases: TestCase[],
    diffArtifactId: string | undefined,
    now: string
  ): TestRun {
    const testCaseId = contractTestCaseId(contract, requirement);
    const testCase = testCases.find((candidate) => candidate.id === testCaseId) ??
      this.snapshot.testCases.find((candidate) => candidate.id === testCaseId);
    const blocked = requirement.requirementKind === "registry_diff" && Boolean(registry.diff?.hasBreakingChanges);
    return {
      id: contractTestRunId(contract, registry, requirement),
      testCaseId: testCase?.id,
      prdId: prd.id,
      workItemId: testCase?.workItemId,
      ...(contract.repositoryId ? { repositoryId: contract.repositoryId } : {}),
      ...(contract.repositoryFullName ? { repositoryFullName: contract.repositoryFullName } : {}),
      status: blocked ? "blocked" : "passed",
      command: requirement.command,
      summary: blocked
        ? `Breaking contract diff detected for ${contract.name}; approval is required.`
        : requirement.requirementKind === "registry_diff"
          ? contractDiffMessage(contract, registry.diff)
          : requirement.summary,
      durationMs: 0,
      startedAt: now,
      endedAt: now,
      runner: requirement.runner,
      environmentImage: "local",
      exitCode: blocked ? null : 0,
      artifactIds: diffArtifactId ? [diffArtifactId] : [],
      retryCount: 0,
      attempt: 1,
      maxAttempts: 1,
      flakySignal: false
    };
  }

  private upsertContractTestRun(testRun: TestRun, testCases: TestCase[], now: string) {
    this.snapshot.testRuns = [
      testRun,
      ...this.snapshot.testRuns.filter((existing) => existing.id !== testRun.id)
    ];
    if (!testRun.testCaseId) return;
    const linkedTestCase = testCases.find((testCase) => testCase.id === testRun.testCaseId) ??
      this.snapshot.testCases.find((testCase) => testCase.id === testRun.testCaseId);
    if (!linkedTestCase) return;
    linkedTestCase.status = testCaseStatusFromTestRunStatus(testRun.status);
    linkedTestCase.lastTestRunId = testRun.id;
    linkedTestCase.flaky = Boolean(testRun.flakySignal);
    linkedTestCase.updatedAt = now;
  }

  private addContractTestRunAudit(prd: Prd, contract: InterfaceContract, testRun: TestRun, now: string) {
    this.addAuditEvent({
      actor: testRun.runner ?? "contract_tests",
      action: `test_run.${testRun.status}`,
      targetType: "test_run",
      targetId: testRun.id,
      message: `${testRun.command}：${testRun.summary}`,
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId: testRun.workItemId,
      createdAt: now,
      beforeJson: null,
      afterJson: {
        contract: auditInterfaceContractState(contract),
        testRun: {
          id: testRun.id,
          status: testRun.status,
          command: testRun.command,
          runner: testRun.runner,
          artifactIds: testRun.artifactIds ?? []
        }
      }
    });
  }

  private ensureBreakingContractApproval(
    prd: Prd,
    contract: InterfaceContract,
    registry: ContractRegistryMetadata,
    testRun: TestRun,
    now: string
  ) {
    const existing = this.snapshot.approvals.find((approval) =>
      approval.kind === "breaking_contract" &&
      approval.targetType === "interface_contract" &&
      approval.targetId === contract.id &&
      approval.status === "pending"
    );
    if (existing) return existing;
    const approval = this.createApprovalRecord({
      kind: "breaking_contract",
      targetType: "interface_contract",
      targetId: contract.id,
      requestedBy: "contract_registry",
      requestedReason: breakingContractApprovalReason(contract, registry),
      riskLevel: contractRiskLevel(registry.diff),
      expiresAt: new Date(Date.parse(now) + contractApprovalTtlMs).toISOString(),
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId: testRun.workItemId
    }, now);
    this.addAuditEvent({
      actor: "contract_registry",
      action: "contract.breaking_approval_requested",
      targetType: "interface_contract",
      targetId: contract.id,
      message: `Breaking change approval requested for ${contract.name}.`,
      requirementId: prd.requirementId,
      prdId: prd.id,
      workItemId: testRun.workItemId,
      createdAt: now,
      beforeJson: null,
      afterJson: {
        contract: auditInterfaceContractState(contract),
        approval: auditApprovalState(approval),
        diff: auditContractDiffState(registry.diff)
      }
    });
    return approval;
  }

  private promoteBreakingContractApproval(approval: ApprovalRecord, actor: string, now: string) {
    if (approval.kind !== "breaking_contract" || approval.targetType !== "interface_contract") return undefined;
    const contract = this.snapshot.interfaceContracts.find((item) => item.id === approval.targetId);
    if (!contract?.registry || contract.status !== "breaking_change_pending") return undefined;
    const beforeJson = {
      contract: auditInterfaceContractState(contract),
      registry: auditContractRegistryState(contract.registry),
      approval: auditApprovalState(approval)
    };
    contract.status = "approved";
    contract.updatedAt = now;
    contract.registry.status = "approved";
    contract.registry.approvalId = approval.id;
    contract.registry.approvedRevisionId = contract.registry.revisionId;
    contract.registry.approvedAt = now;
    this.markContractDiffTestRunsAfterApproval(contract, approval, now);
    this.addContractBaselinePromotedAudit(this.findPrd(contract.prdId), contract, actor, now, beforeJson);
    return contract.id;
  }

  private recordBreakingContractApprovalDenied(approval: ApprovalRecord, actor: string, now: string) {
    if (approval.kind !== "breaking_contract" || approval.targetType !== "interface_contract") return undefined;
    const contract = this.snapshot.interfaceContracts.find((item) => item.id === approval.targetId);
    if (!contract?.registry) return undefined;
    this.addAuditEvent({
      actor,
      action: "contract.breaking_approval_denied",
      targetType: "interface_contract",
      targetId: contract.id,
      message: "Breaking contract approval denied; proposed revision remains blocked.",
      requirementId: approval.requirementId,
      prdId: approval.prdId,
      workItemId: approval.workItemId,
      createdAt: now,
      beforeJson: {
        contract: auditInterfaceContractState(contract),
        approval: auditApprovalState(approval)
      },
      afterJson: {
        contract: auditInterfaceContractState(contract),
        approval: auditApprovalState(approval)
      }
    });
    return undefined;
  }

  private recordBreakingContractApprovalExpired(approval: ApprovalRecord, now: string) {
    if (approval.kind !== "breaking_contract" || approval.targetType !== "interface_contract") return;
    const contract = this.snapshot.interfaceContracts.find((item) => item.id === approval.targetId);
    if (!contract?.registry) return;
    this.addAuditEvent({
      actor: "scheduler",
      action: "contract.breaking_approval_expired",
      targetType: "interface_contract",
      targetId: contract.id,
      message: "Breaking contract approval expired; proposed revision remains blocked.",
      requirementId: approval.requirementId,
      prdId: approval.prdId,
      workItemId: approval.workItemId,
      createdAt: now,
      beforeJson: {
        contract: auditInterfaceContractState(contract),
        approval: { id: approval.id, status: "pending" }
      },
      afterJson: {
        contract: auditInterfaceContractState(contract),
        approval: auditApprovalState(approval)
      }
    });
  }

  private markContractDiffTestRunsAfterApproval(
    contract: InterfaceContract,
    approval: ApprovalRecord,
    now: string
  ) {
    for (const testRunId of contract.registry?.testRunIds ?? []) {
      const testRun = this.snapshot.testRuns.find((candidate) => candidate.id === testRunId);
      if (!testRun || testRun.status !== "blocked") continue;
      testRun.status = "passed";
      testRun.summary = `Breaking contract diff approved by ${approval.approvedBy ?? "approval"}; registry gate passed.`;
      testRun.exitCode = 0;
      testRun.endedAt = now;
      if (!testRun.testCaseId) continue;
      const testCase = this.snapshot.testCases.find((candidate) => candidate.id === testRun.testCaseId);
      if (!testCase) continue;
      testCase.status = "passed";
      testCase.lastTestRunId = testRun.id;
      testCase.flaky = Boolean(testRun.flakySignal);
      testCase.updatedAt = now;
    }
  }

  private addContractBaselinePromotedAudit(
    prd: Prd,
    contract: InterfaceContract,
    actor: string,
    now: string,
    beforeJson: AuditJsonValue | null = null
  ) {
    this.addAuditEvent({
      actor,
      action: "contract.baseline_promoted",
      targetType: "interface_contract",
      targetId: contract.id,
      message: `${contract.name} contract revision ${contract.registry?.revision ?? contract.version} promoted to approved baseline.`,
      requirementId: prd.requirementId,
      prdId: prd.id,
      createdAt: now,
      beforeJson,
      afterJson: {
        contract: auditInterfaceContractState(contract),
        registry: contract.registry ? auditContractRegistryState(contract.registry) : null
      }
    });
  }

  private findProviderWorkItem(workItems: WorkItem[], providerRole: WorkItemRole, repositoryId?: string) {
    const scopedWorkItems = this.workItemsForRepository(workItems, repositoryId);
    return scopedWorkItems.find((workItem) => workItem.role === providerRole) ??
      scopedWorkItems.find((workItem) => workItem.role === "backend") ??
      scopedWorkItems[0];
  }

  private workItemsForRepository(workItems: WorkItem[], repositoryId?: string) {
    if (!repositoryId) return workItems;
    const scopedWorkItems = workItems.filter((workItem) => workItem.repositoryId === repositoryId);
    return scopedWorkItems.length > 0 ? scopedWorkItems : workItems;
  }

  private async recordCompletedRunEvidence(
    run: AgentRun,
    workItem: WorkItem,
    tests: TestRun[],
    endedAt: string,
    finalRunStatus: AgentRun["status"],
    redactionOptions: SecretRedactionOptions = {}
  ) {
    await this.recordRunTestEvidence(run, workItem, tests, endedAt, {
      workspaceStatus: "archived",
      finalRunStatus,
      redactionOptions
    });
    this.recordEgressPolicyAudit(run, workItem, run.result?.egressPolicyEvidence, endedAt);

    const { pullRequest, checkSummary } = await this.recordPullRequest(run, workItem, endedAt, redactionOptions);
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
      createdAt: endedAt,
      beforeJson: null,
      afterJson: {
        pullRequest: {
          id: pullRequest.id,
          status: pullRequest.status,
          provider: pullRequest.provider,
          branchName: pullRequest.branchName,
          url: pullRequest.url
        }
      }
    });
    if (checkSummary) {
      this.addAuditEvent({
        actor: "pr_adapter",
        action: "pull_request.checks_read",
        targetType: "pull_request",
        targetId: pullRequest.id,
        message: `GitHub checks 已读取：${checkSummary.status} (${checkSummary.totalCount})。`,
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: workItem.id,
        runId: run.id,
        createdAt: endedAt,
        beforeJson: null,
        afterJson: {
          checks: {
            status: checkSummary.status,
            totalCount: checkSummary.totalCount,
            runs: checkSummary.runs.map((check) => ({
              name: check.name,
              status: check.status,
              conclusion: check.conclusion ?? null,
              url: check.url ?? null
            }))
          }
        }
      });
    }

    const reviewRecord = this.recordReview(run, workItem, pullRequest, endedAt, redactionOptions);
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
      createdAt: endedAt,
      beforeJson: null,
      afterJson: {
        reviewRecord: {
          id: reviewRecord.id,
          status: reviewRecord.status,
          linkedPullRequestId: reviewRecord.linkedPullRequestId,
          riskLevel: reviewRecord.riskLevel
        }
      }
    });
    const reviewerComment = await this.writeReviewerComment(pullRequest, reviewRecord, endedAt);
    if (reviewerComment) {
      this.addAuditEvent({
        actor: "pr_adapter",
        action: "pull_request.reviewer_comment_written",
        targetType: "pull_request",
        targetId: pullRequest.id,
        message: "Reviewer agent 摘要已写入 GitHub PR comment。",
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: workItem.id,
        runId: run.id,
        createdAt: endedAt,
        beforeJson: null,
        afterJson: {
          comment: {
            id: reviewerComment.id,
            url: reviewerComment.url
          }
        }
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
      createdAt: endedAt,
      beforeJson: null,
      afterJson: {
        run: {
          id: run.id,
          status: finalRunStatus,
          currentStep: run.currentStep,
          artifactIds: run.artifactIds || []
        },
        workItem: auditWorkItemState(workItem)
      }
    });
  }

  private recordEgressPolicyAudit(
    run: AgentRun,
    workItem: WorkItem,
    evidence: EgressPolicyEvidence | undefined,
    now: string
  ) {
    if (!evidence?.enabled) return;
    this.addAuditEvent({
      actor: "egress_policy",
      action: "network.egress_policy.enforced",
      targetType: "agent_run",
      targetId: run.id,
      message: `网络 egress allowlist 已执行：允许 ${evidence.allowedCount} 次，拒绝 ${evidence.deniedCount} 次。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: now,
      beforeJson: null,
      afterJson: {
        policy: {
          mode: evidence.mode,
          allowedHosts: evidence.allowedHosts,
          auditLogPath: evidence.auditLogPath,
          allowedCount: evidence.allowedCount,
          deniedCount: evidence.deniedCount
        }
      },
      metadataJson: {
        recent: evidence.recent.map(auditEgressEntry)
      }
    });

    if (evidence.deniedCount === 0) return;
    this.addAuditEvent({
      actor: "egress_policy",
      action: "network.egress_denied",
      targetType: "agent_run",
      targetId: run.id,
      message: `网络 egress policy 拒绝了 ${evidence.deniedCount} 次 prohibited endpoint 请求。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: now,
      beforeJson: null,
      afterJson: {
        deniedCount: evidence.deniedCount,
        denied: evidence.denied.map(auditEgressEntry)
      },
      metadataJson: {
        allowedHosts: evidence.allowedHosts,
        auditLogPath: evidence.auditLogPath
      }
    });
  }

  private recordCommandPolicyDeniedAudit(
    run: AgentRun,
    workItem: WorkItem,
    evidence: CommandAuditEvidence[] | undefined,
    now: string
  ) {
    const denied = (evidence ?? []).filter((event) => event.action === "command.policy_denied");
    for (const event of denied) {
      this.addAuditEvent({
        actor: "command_executor",
        action: "command.policy_denied",
        targetType: "agent_run",
        targetId: run.id,
        message: `Command wrapper denied ${event.kind} command: ${event.policyDecision?.reason ?? "policy_denied"}.`,
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: workItem.id,
        runId: run.id,
        createdAt: now,
        beforeJson: null,
        afterJson: {
          command: auditCommandEvidence(event)
        },
        metadataJson: {
          manifestId: event.manifestId ?? null,
          policyDecision: event.policyDecision ? auditCommandPolicyDecision(event.policyDecision) : null,
          outputCaptured: Boolean(event.outputPreview),
          outputBytes: event.outputBytes ?? 0
        }
      });
    }
  }

  private async resolveAndAuditSecretBroker(
    run: AgentRun,
    workItem: WorkItem,
    secretBrokerConfig: ReturnType<typeof readPatchPilotConfig>["security"]["secretBroker"],
    capabilityManifest: CapabilityManifest
  ) {
    const resolution = await resolveSecretBrokerGrants({
      config: secretBrokerConfig,
      workItem,
      env: process.env,
      capabilityManifest
    });
    const evidence = resolution.evidence;
    if (evidence.requestedSecretIds.length === 0) return resolution;

    const now = new Date().toISOString();
    if (!resolution.authorized) {
      this.addAuditEvent({
        actor: "secret_broker",
        action: "secret_broker.request_denied",
        targetType: "agent_run",
        targetId: run.id,
        message: `Secret Broker 拒绝了 ${evidence.denied.length} 个未授权 secret 请求。`,
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: workItem.id,
        runId: run.id,
        createdAt: now,
        beforeJson: null,
        afterJson: {
          requestedSecretIds: evidence.requestedSecretIds,
          denied: evidence.denied.map(auditSecretBrokerDeniedSecret),
          injectedCount: 0
        },
        metadataJson: {
          brokerEnabled: evidence.enabled,
          mode: evidence.mode,
          configuredSecretIds: secretBrokerConfig.allowedSecrets.map((secret) => secret.id),
          allowProductionSecrets: secretBrokerConfig.allowProductionSecrets,
          secretValuesStored: false
        }
      });
      throw createRunFailureError(
        `Secret Broker 拒绝 secret 请求：${evidence.denied.map((secret) => `${secret.id}:${secret.reason}`).join(", ")}`,
        "policy_denied",
        undefined,
        undefined,
        evidence
      );
    }

    this.addAuditEvent({
      actor: "secret_broker",
      action: "secret_broker.secrets_injected",
      targetType: "agent_run",
      targetId: run.id,
      message: `Secret Broker 已注入 ${evidence.injected.length} 个明确授权的短期 secret grant。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: now,
      beforeJson: null,
      afterJson: {
        requestedSecretIds: evidence.requestedSecretIds,
        injected: evidence.injected.map(auditSecretBrokerInjectedSecret)
      },
      metadataJson: {
        brokerEnabled: evidence.enabled,
        mode: evidence.mode,
        providers: evidence.injected.map((secret) => secret.provider),
        expiresAt: evidence.injected.map((secret) => secret.expiresAt).filter((value): value is string => Boolean(value)),
        allowProductionSecrets: secretBrokerConfig.allowProductionSecrets,
        secretValuesStored: false
      }
    });
    return resolution;
  }

  private async revokeAndAuditSecretBroker(
    run: AgentRun,
    workItem: WorkItem,
    secretBrokerConfig: ReturnType<typeof readPatchPilotConfig>["security"]["secretBroker"],
    resolution: Awaited<ReturnType<typeof resolveSecretBrokerGrants>>
  ) {
    if (resolution.grants.length === 0) return [];
    const revocationEvidence = await revokeSecretBrokerGrants({
      config: secretBrokerConfig,
      grants: resolution.grants,
      env: process.env
    });
    const auditedEvidence = revocationEvidence.filter(
      (item) => item.provider !== "env" || item.status !== "unsupported"
    );
    if (auditedEvidence.length === 0) return [];
    const now = new Date().toISOString();
    this.addAuditEvent({
      actor: "secret_broker",
      action: "secret_broker.grants_revoked",
      targetType: "agent_run",
      targetId: run.id,
      message: `Secret Broker 已完成 ${auditedEvidence.length} 个 adapter grant 的撤销处理。`,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      createdAt: now,
      beforeJson: {
        injected: resolution.evidence.injected.map(auditSecretBrokerInjectedSecret)
      },
      afterJson: {
        revoked: auditedEvidence.map(auditSecretBrokerGrantOperation)
      },
      metadataJson: {
        brokerEnabled: resolution.evidence.enabled,
        mode: resolution.evidence.mode,
        statuses: auditedEvidence.map((item) => item.status),
        secretValuesStored: false
      }
    });
    return auditedEvidence;
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
      createdAt: now,
      beforeJson: null,
      afterJson: {
        bug: {
          id: defect.id,
          status: defect.status,
          severity: defect.severity,
          sourceRunId: defect.sourceRunId || null,
          sourceTestRunId: defect.sourceTestRunId || null,
          sourceFailureType: defect.sourceFailureType || null
        }
      }
    });
    return defect;
  }

  private async recordPullRequest(
    run: AgentRun,
    workItem: WorkItem,
    now: string,
    redactionOptions: SecretRedactionOptions = {}
  ): Promise<{ pullRequest: PullRequestRecord; checkSummary?: PullRequestCheckSummary }> {
    const existing = this.snapshot.pullRequests.find((item) => item.runId === run.id);
    const result = run.result;
    const tests = result?.tests ?? [];
    const testSummary =
      tests.length > 0
        ? tests.map((test) => `${test.status}: ${test.command} (${test.durationMs}ms)`).join("\n")
        : "No test evidence recorded.";
    const reviewerSummary = redactSecrets(
      result?.reviewerSummary || "Reviewer agent 尚未返回摘要。",
      redactionOptions
    ).redacted;
    const branchName = result?.branchName || existing?.branchName || buildFallbackBranchName(workItem, run.id);
    const baseBranch = result?.baseBranch || existing?.baseBranch || "main";
    const baseCommit = result?.baseCommit || existing?.baseCommit;
    const headCommit = result?.headCommit || existing?.headCommit;
    const draft: PullRequestDraft = {
      id: existing?.id || `pr_${run.id}`,
      status: "ready_for_review",
      title: redactSecrets(`[PatchPilot] ${workItem.title}`, redactionOptions).redacted,
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: workItem.id,
      runId: run.id,
      ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
      ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
      branchName,
      baseBranch,
      ...(baseCommit ? { baseCommit } : {}),
      ...(headCommit ? { headCommit } : {}),
      bodyMarkdown: redactSecrets(this.buildPullRequestBody(run, workItem, testSummary, reviewerSummary, {
        branchName,
        baseBranch,
        baseCommit,
        headCommit
      }), redactionOptions).redacted,
      reviewerSummary,
      testSummary: redactSecrets(testSummary, redactionOptions).redacted,
      createdAt: existing?.createdAt || now,
      updatedAt: now
    };
    const adapter = this.resolvePullRequestAdapter(workItem);
    const pullRequest = await adapter.upsertPullRequest({
      draft,
      ...(existing ? { existing } : {}),
      ...(result?.workspacePath ? { workspacePath: result.workspacePath } : {})
    });

    if (existing) Object.assign(existing, pullRequest);
    else this.snapshot.pullRequests.unshift(pullRequest);
    const checkSummary = pullRequest.provider === "github"
      ? await adapter.readChecks({ pullRequest })
      : undefined;
    return {
      pullRequest,
      ...(checkSummary ? { checkSummary } : {})
    };
  }

  private async writeReviewerComment(
    pullRequest: PullRequestRecord,
    reviewRecord: ReviewRecord,
    now: string
  ) {
    if (pullRequest.provider !== "github") return undefined;
    const workItem = this.snapshot.workItems.find((item) => item.id === pullRequest.workItemId);
    return this.resolvePullRequestAdapter(workItem).writeReviewerComment({
      pullRequest,
      body: [
        "## PatchPilot Reviewer Agent",
        reviewRecord.summary,
        "",
        `Status: ${reviewRecord.status}`,
        `Risk: ${reviewRecord.riskLevel}`,
        "",
        "## Findings",
        ...reviewRecord.findings.map((finding) => `- ${finding}`),
        "",
        "## Tests",
        reviewRecord.testSummary,
        "",
        `Recorded at: ${now}`
      ].join("\n")
    });
  }

  private resolvePullRequestAdapter(workItem?: WorkItem) {
    return this.pullRequestAdapter ?? createConfiguredPullRequestAdapter(
      readPatchPilotConfig(),
      process.env,
      this.repositoryForWorkItem(workItem) ?? this.selectedGitHubRepository()
    );
  }

  private repositoryTargetsForPrd(): WorkItemRepositoryTarget[] {
    const selected = this.snapshot.repositories.filter((repository) => repository.selected);
    const repositories = selected.length > 0
      ? selected
      : this.snapshot.repositories.length === 1
        ? this.snapshot.repositories
        : [];
    return repositories.map((repository) => ({
      id: repository.id,
      fullName: repository.fullName,
      provider: repository.provider
    }));
  }

  private repositoryForWorkItem(workItem: WorkItem | undefined) {
    if (!workItem?.repositoryId) return undefined;
    return this.snapshot.repositories.find((repository) => repository.id === workItem.repositoryId);
  }

  private selectedGitHubRepositories() {
    return this.snapshot.repositories.filter((repository) => repository.provider === "github" && repository.selected);
  }

  private selectedGitHubRepository() {
    return this.selectedGitHubRepositories()[0];
  }

  private githubInstallationIdForRepositoryListing() {
    const selectedRepositoryInstallationId = Number(this.selectedGitHubRepository()?.githubInstallationId);
    if (Number.isFinite(selectedRepositoryInstallationId) && selectedRepositoryInstallationId > 0) return selectedRepositoryInstallationId;
    return this.snapshot.githubInstallations[0]?.installationId;
  }

  private syncGitHubAppRepositories(repositories: GitHubAppRepository[], now: string) {
    const installation = this.installationForGitHubRepositories(repositories, now);
    return repositories.map((repository) => this.upsertGitHubRepository(repository, installation, now));
  }

  private installationForGitHubRepositories(
    repositories: GitHubAppRepository[],
    now: string
  ): GitHubAppInstallationRecord | undefined {
    const firstRepository = repositories[0];
    if (!firstRepository) return undefined;
    return this.upsertGitHubInstallation({
      installationId: firstRepository.installationId,
      accountLogin: firstRepository.owner,
      repositorySelection: "selected",
      permissions: {},
      now
    });
  }

  private upsertGitHubRepository(
    githubRepository: GitHubAppRepository,
    installation: GitHubAppInstallationRecord | undefined,
    now: string
  ) {
    const existing = this.snapshot.repositories.find((repository) => repository.id === githubRepository.id);
    const repository: RepositoryRecord = {
      id: githubRepository.id,
      provider: "github",
      owner: githubRepository.owner,
      name: githubRepository.name,
      fullName: githubRepository.fullName,
      remoteUrl: githubRepository.cloneUrl,
      htmlUrl: githubRepository.htmlUrl,
      defaultBranch: githubRepository.defaultBranch,
      githubInstallationId: String(githubRepository.installationId),
      githubRepositoryId: githubRepository.githubRepositoryId,
      private: githubRepository.private,
      selected: existing?.selected ?? false,
      permissions: githubRepository.permissions,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    if (existing) Object.assign(existing, repository);
    else this.snapshot.repositories.unshift(repository);
    if (installation?.selectedRepositoryId === repository.id) repository.selected = true;
    return existing ?? repository;
  }

  private upsertGitHubInstallation(input: {
    installationId: number;
    accountLogin: string;
    accountType?: string;
    repositorySelection: GitHubAppInstallationRecord["repositorySelection"];
    permissions: GitHubAppInstallationRecord["permissions"];
    selectedRepositoryId?: string;
    suspendedAt?: string;
    now: string;
  }) {
    const id = githubInstallationRecordId(input.installationId);
    const existing = this.snapshot.githubInstallations.find((installation) => installation.id === id);
    const permissions = Object.keys(input.permissions).length > 0
      ? input.permissions
      : existing?.permissions ?? input.permissions;
    const installation: GitHubAppInstallationRecord = {
      id,
      installationId: input.installationId,
      accountLogin: input.accountLogin,
      ...(input.accountType ? { accountType: input.accountType } : existing?.accountType ? { accountType: existing.accountType } : {}),
      repositorySelection: input.repositorySelection,
      permissions,
      ...(input.selectedRepositoryId
        ? { selectedRepositoryId: input.selectedRepositoryId }
        : existing?.selectedRepositoryId
          ? { selectedRepositoryId: existing.selectedRepositoryId }
          : {}),
      ...(input.suspendedAt ? { suspendedAt: input.suspendedAt } : existing?.suspendedAt ? { suspendedAt: existing.suspendedAt } : {}),
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now
    };
    if (existing) Object.assign(existing, installation);
    else this.snapshot.githubInstallations.unshift(installation);
    return existing ?? installation;
  }

  private githubInstallationForRepository(repository: RepositoryRecord) {
    const installationId = Number(repository.githubInstallationId);
    if (!Number.isFinite(installationId)) return undefined;
    return this.snapshot.githubInstallations.find((installation) => installation.installationId === installationId);
  }

  private createGitHubInstallationFromRepository(repository: RepositoryRecord, now: string) {
    const installationId = Number(repository.githubInstallationId);
    if (!Number.isFinite(installationId)) {
      throw new DomainError("INVALID_STATE", "GitHub repository is missing installation metadata.");
    }
    return this.upsertGitHubInstallation({
      installationId,
      accountLogin: repository.owner,
      repositorySelection: "selected",
      permissions: {},
      now
    });
  }

  private githubRepositoryHasPrPermissions(
    repository: RepositoryRecord,
    installation: GitHubAppInstallationRecord | undefined
  ) {
    const repositoryAllowsPush =
      repository.permissions?.admin ||
      repository.permissions?.maintain ||
      repository.permissions?.push;
    const permissions = installation?.permissions ?? {};
    const installationPermissionsKnown = Object.keys(permissions).length > 0;
    const appAllowsPr = !installationPermissionsKnown ||
      permissions.contents === "write" &&
      (permissions.pull_requests === "write" || permissions.pullRequests === "write");
    return Boolean(repositoryAllowsPush && appAllowsPr);
  }

  private upsertGitHubInstallationFromWebhook(
    payload: Record<string, unknown>,
    now: string
  ): GitHubAppInstallationRecord | undefined {
    const installationPayload = objectFromUnknown(payload.installation);
    const installationId = numberFromUnknown(installationPayload?.id);
    if (!installationId) return undefined;
    const account = objectFromUnknown(installationPayload?.account);
    const action = stringFromUnknown(payload.action);
    return this.upsertGitHubInstallation({
      installationId,
      accountLogin: stringFromUnknown(account?.login) ?? `installation-${installationId}`,
      accountType: stringFromUnknown(account?.type),
      repositorySelection: repositorySelectionFromUnknown(installationPayload?.repository_selection),
      permissions: githubInstallationPermissionsFromUnknown(installationPayload?.permissions),
      suspendedAt: action === "suspended" ? now : stringFromUnknown(installationPayload?.suspended_at),
      now
    });
  }

  private upsertGitHubRepositoriesFromWebhook(
    payload: Record<string, unknown>,
    installation: GitHubAppInstallationRecord | undefined,
    now: string
  ) {
    if (!installation) return [];
    const repositoryPayloads = [
      ...arrayFromUnknown(payload.repositories),
      ...arrayFromUnknown(payload.repositories_added),
      ...(payload.repository ? [payload.repository] : [])
    ];
    const removedRepositoryPayloads = arrayFromUnknown(payload.repositories_removed);
    const repositories = repositoryPayloads
      .map((repositoryPayload) => githubRepositoryFromWebhook(repositoryPayload, installation.installationId))
      .filter((repository): repository is GitHubAppRepository => Boolean(repository))
      .map((repository) => this.upsertGitHubRepository(repository, installation, now));

    for (const removedPayload of removedRepositoryPayloads) {
      const removed = githubRepositoryFromWebhook(removedPayload, installation.installationId);
      if (!removed) continue;
      const existing = this.snapshot.repositories.find((repository) => repository.id === removed.id);
      if (!existing) continue;
      existing.selected = false;
      existing.updatedAt = now;
      if (installation.selectedRepositoryId === existing.id) delete installation.selectedRepositoryId;
    }
    return repositories;
  }

  private contractEvidenceForWorkItem(prdId: string, workItemId: string) {
    const contractTestCases = this.snapshot.testCases.filter((testCase) =>
      testCase.prdId === prdId &&
      testCase.workItemId === workItemId &&
      testCase.kind === "contract" &&
      isGeneratedContractTestCase(testCase)
    );
    if (contractTestCases.length === 0) return { passed: true, details: [] };
    const details: string[] = [];
    for (const testCase of contractTestCases) {
      const testRun = testCase.lastTestRunId
        ? this.snapshot.testRuns.find((candidate) => candidate.id === testCase.lastTestRunId)
        : undefined;
      if (testCase.status === "passed" && testRun?.status === "passed") continue;
      details.push(`${testCase.title}: ${testRun?.status ?? testCase.status}`);
    }
    return {
      passed: details.length === 0,
      details
    };
  }

  private recordReview(
    run: AgentRun,
    workItem: WorkItem,
    pullRequest: PullRequestRecord,
    now: string,
    redactionOptions: SecretRedactionOptions = {}
  ): ReviewRecord {
    const existing = this.snapshot.reviewRecords.find((item) => item.runId === run.id);
    const tests = run.result?.tests ?? [];
    const contractEvidence = this.contractEvidenceForWorkItem(workItem.prdId, workItem.id);
    const allTestsPassed = tests.length > 0 && tests.every((test) => test.status === "passed") && contractEvidence.passed;
    const reviewerSummary = redactSecrets(
      run.result?.reviewerSummary || "Reviewer agent 尚未返回摘要。",
      redactionOptions
    ).redacted;
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
      summary: redactSecrets(`Reviewer agent 摘要：${reviewerSummary}`, redactionOptions).redacted,
      testSummary: redactSecrets(testSummary, redactionOptions).redacted,
      riskLevel: run.result?.riskLevel || "medium",
      findings: allTestsPassed
        ? ["测试证据通过", "契约 TestRun 证据通过", "PR 交付记录已生成", "未发现阻断验收的高风险问题"]
        : ["测试证据不足、契约 TestRun 缺失或存在失败，需要返工", ...contractEvidence.details],
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
      ...(workItem.repositoryId
        ? [
            "",
            "## Repository",
            `Repository: ${workItem.repositoryFullName ?? workItem.repositoryId}`,
            `Repository ID: ${workItem.repositoryId}`
          ]
        : []),
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

  private addAuditEvent(input: AddAuditEventInput) {
    const createdAt = input.createdAt || new Date().toISOString();
    const actor = input.actorType && input.actorId
      ? { actorType: input.actorType, actorId: input.actorId }
      : normalizeAuditActor(input.actor || input.actorId);
    const message = redactSecrets(input.message).redacted;
    const beforeJson = redactJsonValue(input.beforeJson ?? null);
    const afterJson = redactJsonValue(input.afterJson ?? null);
    const metadataJson = redactJsonValue(input.metadataJson ?? {});
    const previousHash = this.snapshot.auditEvents[0]?.hash ?? null;
    const eventWithoutHash: Omit<AuditEvent, "hash"> = {
      id: `audit_${randomUUID()}`,
      traceId: input.traceId || input.runId || input.prdId || input.requirementId || input.targetId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actor: input.actor || actor.actorId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      message,
      beforeJson,
      afterJson,
      metadataJson,
      previousHash,
      ...(input.requirementId ? { requirementId: input.requirementId } : {}),
      ...(input.prdId ? { prdId: input.prdId } : {}),
      ...(input.workItemId ? { workItemId: input.workItemId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      createdAt
    };
    const auditEvent = {
      ...eventWithoutHash,
      hash: computeAuditEventHash(eventWithoutHash)
    };
    this.snapshot.auditEvents.unshift(auditEvent);
    this.telemetry.recordAuditEvent(auditEvent);
    return auditEvent;
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
      ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
      ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
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
        ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
        ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
        status: "passed",
        command: "pnpm test -- --bug-repro",
        summary: "测试 agent 已根据复现步骤确认问题，并整理回归测试建议",
        durationMs: 1320
      };
    }

    if (workItem.sourceBugId) {
      return {
        id: `test_${randomUUID()}`,
        ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
        ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
        status: "passed",
        command: "pnpm test -- --bug-regression",
        summary: "开发修复后的回归检查通过，bug 不再复现",
        durationMs: 1760
      };
    }

    return {
      id: `test_${randomUUID()}`,
      ...(workItem.repositoryId ? { repositoryId: workItem.repositoryId } : {}),
      ...(workItem.repositoryFullName ? { repositoryFullName: workItem.repositoryFullName } : {}),
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
      const beforeStatus = bug.status;
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
        createdAt: now,
        beforeJson: { bug: { id: bug.id, status: beforeStatus } },
        afterJson: { bug: { id: bug.id, status: bug.status } }
      });
      return;
    }
    const beforeStatus = bug.status;
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
      createdAt: now,
      beforeJson: { bug: { id: bug.id, status: beforeStatus } },
      afterJson: { bug: { id: bug.id, status: bug.status } }
    });
    const verifyingStatus = bug.status;
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
      createdAt: now,
      beforeJson: { bug: { id: bug.id, status: verifyingStatus } },
      afterJson: { bug: { id: bug.id, status: bug.status } }
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

  private upsertExternalIssueLink(
    entity: WorkItem | BugReport,
    input: {
      provider: ExternalIssueProvider;
      externalIssueId: string;
      externalKey?: string;
      externalUrl?: string;
      statusName: string;
      statusCategory: ExternalIssueStatusCategory;
      summary?: string;
    },
    now: string
  ): ExternalIssueLink {
    if (!input.externalIssueId && !input.externalKey) {
      throw new DomainError("INVALID_STATE", "External issue id or key is required");
    }
    const links = entity.externalIssueLinks ??= [];
    const externalIssueId = input.externalIssueId || input.externalKey || "";
    let link = links.find((candidate) =>
      externalIssueMatches(candidate, input.provider, externalIssueId, input.externalKey)
    );
    if (!link) {
      link = {
        id: `ext_${randomUUID()}`,
        provider: input.provider,
        externalIssueId,
        statusName: input.statusName,
        statusCategory: input.statusCategory,
        createdAt: now,
        updatedAt: now
      };
      links.unshift(link);
    }
    link.externalIssueId = externalIssueId;
    if (input.externalKey) link.externalKey = input.externalKey;
    if (input.externalUrl) link.externalUrl = input.externalUrl;
    if (input.summary) link.summary = input.summary;
    link.statusName = input.statusName;
    link.statusCategory = input.statusCategory;
    link.updatedAt = now;
    return link;
  }

  private findExternalIssueTarget(
    provider: ExternalIssueProvider,
    externalIssueId: string | undefined,
    externalKey: string | undefined
  ): {
    entityType: "work_item" | "defect";
    entity: WorkItem | BugReport;
    link: ExternalIssueLink;
  } {
    for (const workItem of this.snapshot.workItems) {
      const link = (workItem.externalIssueLinks ?? []).find((candidate) =>
        externalIssueMatches(candidate, provider, externalIssueId, externalKey)
      );
      if (link) return { entityType: "work_item", entity: workItem, link };
    }
    for (const bug of this.snapshot.bugs) {
      const link = (bug.externalIssueLinks ?? []).find((candidate) =>
        externalIssueMatches(candidate, provider, externalIssueId, externalKey)
      );
      if (link) return { entityType: "defect", entity: bug, link };
    }
    throw new DomainError("NOT_FOUND", `External issue link not found for ${provider}:${externalIssueId || externalKey}`);
  }

  private appendExternalIssueEvidence(
    entity: WorkItem | BugReport,
    input: {
      link: ExternalIssueLink;
      direction: ExternalIssueSyncEvidence["direction"];
      action: ExternalIssueSyncAction;
      message: string;
      statusName?: string;
      statusCategory?: ExternalIssueStatusCategory;
      actor?: string;
      idempotencyKey?: string;
      observedAt: string;
      recordedAt: string;
      patchPilotStatusBefore?: ExternalIssueSyncEvidence["patchPilotStatusBefore"];
      patchPilotStatusAfter?: ExternalIssueSyncEvidence["patchPilotStatusAfter"];
    }
  ): ExternalIssueSyncEvidence {
    const evidence: ExternalIssueSyncEvidence = {
      id: `sync_${randomUUID()}`,
      provider: input.link.provider,
      externalIssueId: input.link.externalIssueId,
      ...(input.link.externalKey ? { externalKey: input.link.externalKey } : {}),
      direction: input.direction,
      action: input.action,
      statusName: input.statusName ?? input.link.statusName,
      statusCategory: input.statusCategory ?? input.link.statusCategory,
      message: input.message,
      ...(input.actor ? { actor: input.actor } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      observedAt: input.observedAt,
      recordedAt: input.recordedAt,
      ...(input.patchPilotStatusBefore ? { patchPilotStatusBefore: input.patchPilotStatusBefore } : {}),
      ...(input.patchPilotStatusAfter ? { patchPilotStatusAfter: input.patchPilotStatusAfter } : {})
    };
    entity.externalIssueSyncEvidence = [evidence, ...(entity.externalIssueSyncEvidence ?? [])].slice(0, 50);
    return evidence;
  }

  private applyExternalIssueBlocker(
    target: { entityType: "work_item" | "defect"; entity: WorkItem | BugReport; link: ExternalIssueLink },
    statusName: string,
    observedAt: string,
    now: string
  ) {
    const blocker: ExternalIssueBlocker = {
      provider: target.link.provider,
      externalIssueId: target.link.externalIssueId,
      ...(target.link.externalKey ? { externalKey: target.link.externalKey } : {}),
      statusName,
      statusCategory: "blocked",
      reason: `${target.link.provider} issue ${target.link.externalKey || target.link.externalIssueId} is blocked.`,
      blockedAt: observedAt
    };
    target.entity.externalBlocker = blocker;
    target.entity.updatedAt = now;
    if (target.entityType === "work_item") {
      this.blockWorkItemForExternalIssue(target.entity as WorkItem, blocker, now);
      return;
    }
    const bug = target.entity as BugReport;
    const workItem = this.snapshot.workItems.find((item) => item.id === bug.workItemId);
    if (workItem) this.blockWorkItemForExternalIssue(workItem, blocker, now);
  }

  private clearExternalIssueBlocker(
    target: { entityType: "work_item" | "defect"; entity: WorkItem | BugReport; link: ExternalIssueLink },
    now: string
  ) {
    if (target.entityType === "work_item") {
      return this.clearWorkItemExternalBlocker(target.entity as WorkItem, target.link, now);
    }
    let triggered = false;
    if (externalBlockerMatches(target.entity.externalBlocker, target.link)) {
      target.entity.externalBlocker = undefined;
      target.entity.updatedAt = now;
      triggered = true;
    }
    const bug = target.entity as BugReport;
    const workItem = this.snapshot.workItems.find((item) => item.id === bug.workItemId);
    return (workItem ? this.clearWorkItemExternalBlocker(workItem, target.link, now) : false) || triggered;
  }

  private blockWorkItemForExternalIssue(workItem: WorkItem, blocker: ExternalIssueBlocker, now: string) {
    workItem.externalBlocker = blocker;
    if (workItem.status === "ready" || workItem.status === "claimed" || workItem.status === "proposed") {
      if (workItem.assignedAgentId) this.releaseAgentAssignment(workItem.assignedAgentId, now);
      this.clearClaim(workItem);
      workItem.status = "blocked";
      workItem.version = (workItem.version ?? 0) + 1;
    }
    workItem.updatedAt = now;
  }

  private clearWorkItemExternalBlocker(workItem: WorkItem, link: ExternalIssueLink, now: string) {
    if (!externalBlockerMatches(workItem.externalBlocker, link)) return false;
    workItem.externalBlocker = undefined;
    if (workItem.status === "blocked") {
      workItem.status = "ready";
      this.clearClaim(workItem);
      workItem.version = (workItem.version ?? 0) + 1;
    }
    workItem.updatedAt = now;
    return true;
  }

  private requirementIdForExternalIssueEntity(entity: WorkItem | BugReport, entityType: "work_item" | "defect") {
    return entityType === "work_item"
      ? this.findPrd((entity as WorkItem).prdId).requirementId
      : (entity as BugReport).requirementId;
  }

  private externalIssueSyncResponse(
    entityType: "work_item" | "defect",
    link: ExternalIssueLink,
    evidence: ExternalIssueSyncEvidence,
    entity: WorkItem | BugReport
  ) {
    if (entityType === "work_item") {
      return {
        link: structuredClone(link),
        evidence: structuredClone(evidence),
        workItem: structuredClone(entity as WorkItem)
      };
    }
    const bug = entity as BugReport;
    const workItem = this.snapshot.workItems.find((item) => item.id === bug.workItemId);
    return {
      link: structuredClone(link),
      evidence: structuredClone(evidence),
      bug: structuredClone(bug),
      ...(workItem ? { workItem: structuredClone(workItem) } : {})
    };
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

function auditWorkItemState(workItem: WorkItem): Record<string, AuditJsonValue> {
  return {
    id: workItem.id,
    status: workItem.status,
    assignedAgentId: workItem.assignedAgentId || null,
    leaseExpiresAt: workItem.leaseExpiresAt || null,
    version: workItem.version ?? null,
    reworkCount: workItem.reworkCount ?? null,
    updatedAt: workItem.updatedAt || null
  };
}

function auditExternalIssueEntityState(
  entity: WorkItem | BugReport,
  entityType: "work_item" | "defect"
): Record<string, AuditJsonValue> {
  return {
    id: entity.id,
    entityType,
    status: entity.status,
    externalIssueLinkCount: entity.externalIssueLinks?.length ?? 0,
    externalSyncEvidenceCount: entity.externalIssueSyncEvidence?.length ?? 0,
    externalBlocker: entity.externalBlocker
      ? {
          provider: entity.externalBlocker.provider,
          externalIssueId: entity.externalBlocker.externalIssueId,
          externalKey: entity.externalBlocker.externalKey ?? null,
          statusName: entity.externalBlocker.statusName,
          blockedAt: entity.externalBlocker.blockedAt
        }
      : null,
    updatedAt: entity.updatedAt || null
  };
}

function auditExternalIssueLink(link: ExternalIssueLink): Record<string, AuditJsonValue> {
  return {
    id: link.id,
    provider: link.provider,
    externalIssueId: link.externalIssueId,
    externalKey: link.externalKey ?? null,
    externalUrl: link.externalUrl ?? null,
    statusName: link.statusName,
    statusCategory: link.statusCategory,
    summary: link.summary ?? null,
    lastSyncedAt: link.lastSyncedAt ?? null,
    updatedAt: link.updatedAt
  };
}

function auditExternalIssueEvidence(evidence: ExternalIssueSyncEvidence): Record<string, AuditJsonValue> {
  return {
    id: evidence.id,
    provider: evidence.provider,
    externalIssueId: evidence.externalIssueId,
    externalKey: evidence.externalKey ?? null,
    direction: evidence.direction,
    action: evidence.action,
    statusName: evidence.statusName,
    statusCategory: evidence.statusCategory,
    message: evidence.message,
    actor: evidence.actor ?? null,
    idempotencyKey: evidence.idempotencyKey ?? null,
    observedAt: evidence.observedAt,
    recordedAt: evidence.recordedAt,
    patchPilotStatusBefore: evidence.patchPilotStatusBefore ?? null,
    patchPilotStatusAfter: evidence.patchPilotStatusAfter ?? null
  };
}

function externalIssueMatches(
  link: ExternalIssueLink,
  provider: ExternalIssueProvider,
  externalIssueId: string | undefined,
  externalKey: string | undefined
) {
  if (link.provider !== provider) return false;
  if (externalIssueId && link.externalIssueId === externalIssueId) return true;
  if (externalKey && link.externalKey === externalKey) return true;
  return false;
}

function externalBlockerMatches(blocker: ExternalIssueBlocker | undefined, link: ExternalIssueLink) {
  if (!blocker) return false;
  if (blocker.provider !== link.provider) return false;
  if (blocker.externalIssueId === link.externalIssueId) return true;
  return Boolean(blocker.externalKey && link.externalKey && blocker.externalKey === link.externalKey);
}

function auditApprovalState(approval: ApprovalRecord): Record<string, AuditJsonValue> {
  return {
    id: approval.id,
    kind: approval.kind,
    status: approval.status,
    targetType: approval.targetType,
    targetId: approval.targetId,
    riskLevel: approval.riskLevel,
    decidedAt: approval.decidedAt || null,
    updatedAt: approval.updatedAt
  };
}

function auditInterfaceContractState(contract: InterfaceContract): Record<string, AuditJsonValue> {
  return {
    id: contract.id,
    name: contract.name,
    kind: contract.kind,
    status: contract.status,
    version: contract.version,
    providerRole: contract.providerRole,
    consumerRoles: contract.consumerRoles,
    registryRevisionId: contract.registry?.revisionId ?? null,
    approvalId: contract.registry?.approvalId ?? null,
    updatedAt: contract.updatedAt
  };
}

function auditContractRegistryState(registry: ContractRegistryMetadata): Record<string, AuditJsonValue> {
  return {
    artifactId: registry.artifactId,
    generatorVersion: registry.generatorVersion,
    revisionId: registry.revisionId,
    revision: registry.revision,
    contentHash: registry.contentHash,
    sourceRef: registry.sourceRef,
    providerRole: registry.providerRole,
    consumerRoles: registry.consumerRoles,
    status: registry.status,
    baselineRevisionId: registry.baselineRevisionId ?? null,
    approvedRevisionId: registry.approvedRevisionId ?? null,
    approvalId: registry.approvalId ?? null,
    diffId: registry.diff?.id ?? null,
    testRunIds: registry.testRunIds ?? []
  };
}

function auditContractDiffState(diff: ContractDiffSummary | undefined): Record<string, AuditJsonValue> | null {
  if (!diff) return null;
  return {
    id: diff.id,
    status: diff.status,
    hasBreakingChanges: diff.hasBreakingChanges,
    hasWarnings: diff.hasWarnings,
    baselineRevisionId: diff.baselineRevisionId ?? null,
    proposedRevisionId: diff.proposedRevisionId,
    impactedProviderRole: diff.impactedProviderRole,
    impactedConsumerRoles: diff.impactedConsumerRoles,
    changeCount: diff.changes.length,
    breakingChangeCount: diff.changes.filter((change) => change.severity === "breaking").length,
    warningChangeCount: diff.changes.filter((change) => change.severity === "warning").length
  };
}

function contractDiffMessage(contract: InterfaceContract, diff: ContractDiffSummary | undefined) {
  if (!diff) return `${contract.name} contract registry diff did not run.`;
  const breaking = diff.changes.filter((change) => change.severity === "breaking").length;
  const warnings = diff.changes.filter((change) => change.severity === "warning").length;
  const compatible = diff.changes.filter((change) => change.severity === "compatible").length;
  return `${contract.name} contract diff ${diff.status}: ${breaking} breaking, ${warnings} warning, ${compatible} compatible changes.`;
}

function breakingContractApprovalReason(contract: InterfaceContract, registry: ContractRegistryMetadata) {
  const diff = registry.diff;
  const breakingChanges = diff?.changes.filter((change) => change.severity === "breaking") ?? [];
  const summaries = breakingChanges.slice(0, 3).map((change) => change.summary).join(" ");
  return [
    `${contract.name} has ${breakingChanges.length} breaking contract change(s).`,
    `Impacted consumers: ${(diff?.impactedConsumerRoles ?? contract.consumerRoles).join(", ")}.`,
    `Revision: ${registry.revisionId}.`,
    summaries
  ].filter(Boolean).join(" ");
}

function contractRiskLevel(diff: ContractDiffSummary | undefined): ApprovalRecord["riskLevel"] {
  if (!diff?.hasBreakingChanges) return "low";
  if (diff.impactedConsumerRoles.includes("ops") && diff.impactedConsumerRoles.length >= 3) return "critical";
  if (diff.impactedConsumerRoles.length >= 2) return "high";
  return "medium";
}

function artifactIdFromContractId(contractId: string) {
  const match = /_([^_]+)$/.exec(contractId);
  return match?.[1];
}

function contractTestCaseId(contract: InterfaceContract, requirement: ContractTestRequirement) {
  return `tc_contract_${shortHash([
    contract.id,
    contract.registry?.revisionId ?? `r${contract.version}`,
    requirement.id
  ].join(":"))}`;
}

function contractTestRunId(
  contract: InterfaceContract,
  registry: ContractRegistryMetadata,
  requirement: ContractTestRequirement
) {
  return `test_contract_${shortHash([
    contract.id,
    registry.revisionId,
    registry.diff?.id ?? "none",
    requirement.id
  ].join(":"))}`;
}

function isGeneratedContractTestCase(testCase: TestCase) {
  return testCase.id.startsWith("tc_contract_");
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function auditEgressEntry(entry: EgressPolicyEvidence["recent"][number]): Record<string, AuditJsonValue> {
  return {
    at: entry.at,
    decision: entry.decision,
    reason: entry.reason,
    protocol: entry.protocol,
    host: entry.host,
    port: entry.port,
    target: entry.target,
    resolvedIps: entry.resolvedIps ?? []
  };
}

function auditCommandEvidence(event: CommandAuditEvidence): Record<string, AuditJsonValue> {
  return {
    id: event.id,
    action: event.action,
    kind: event.kind,
    command: event.command,
    cwd: event.cwd,
    manifestId: event.manifestId ?? null,
    policyDecision: event.policyDecision ? auditCommandPolicyDecision(event.policyDecision) : null,
    startedAt: event.startedAt ?? null,
    endedAt: event.endedAt ?? null,
    exitCode: event.exitCode ?? null,
    timedOut: event.timedOut ?? null,
    durationMs: event.durationMs ?? null,
    outputPreview: event.outputPreview ?? null,
    outputBytes: event.outputBytes ?? 0,
    maxOutputBytes: event.maxOutputBytes ?? null
  };
}

function auditCommandPolicyDecision(
  decision: NonNullable<CommandAuditEvidence["policyDecision"]>
): Record<string, AuditJsonValue> {
  return {
    decision: decision.decision,
    reason: decision.reason,
    target: decision.target,
    matchedPattern: decision.matchedPattern ?? null
  };
}

function auditSecretBrokerInjectedSecret(
  secret: SecretBrokerEvidence["injected"][number]
): Record<string, AuditJsonValue> {
  return {
    id: secret.id,
    envVar: secret.envVar,
    sourceEnv: secret.sourceEnv ?? null,
    environment: secret.environment,
    provider: secret.provider,
    leaseId: secret.leaseId ?? null,
    issuedAt: secret.issuedAt,
    expiresAt: secret.expiresAt ?? null,
    ttlSeconds: secret.ttlSeconds ?? null,
    renewable: secret.renewable,
    rotationSupported: secret.rotationSupported,
    revocationSupported: secret.revocationSupported,
    valueFingerprint: secret.valueFingerprint,
    providerAuditId: secret.providerAuditId ?? null
  };
}

function auditSecretBrokerDeniedSecret(
  secret: SecretBrokerEvidence["denied"][number]
): Record<string, AuditJsonValue> {
  return {
    id: secret.id,
    reason: secret.reason,
    provider: secret.provider ?? null
  };
}

function auditSecretBrokerGrantOperation(
  operation: SecretBrokerEvidence["revoked"][number]
): Record<string, AuditJsonValue> {
  return {
    id: operation.id,
    provider: operation.provider,
    action: operation.action,
    status: operation.status,
    occurredAt: operation.occurredAt,
    leaseId: operation.leaseId ?? null,
    rotationVersion: operation.rotationVersion ?? null,
    providerAuditId: operation.providerAuditId ?? null,
    reason: operation.reason ?? null
  };
}

function auditBudgetScope(scope: BudgetScopeCheck): Record<string, AuditJsonValue> {
  return {
    type: scope.type,
    limitUsd: scope.limitUsd,
    spentUsd: scope.spentUsd,
    nextSpendUsd: scope.nextSpendUsd
  };
}

function safeReferenceSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || `input_${randomUUID()}`;
}

function sanitizeReferenceMetadata(metadata: Record<string, string> | undefined) {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(redactRecordValues(metadata) ?? {})) {
    const normalizedKey = key.trim();
    const normalizedValue = value.trim();
    if (!normalizedKey || !normalizedValue) continue;
    output[normalizedKey] = normalizedValue;
  }
  return output;
}

function normalizeIntakeArtifactKind(kind: string): IntakeArtifactReference["kind"] {
  if (kind === "screenshot" || kind === "recording" || kind === "link") return kind;
  return "file";
}

function githubInstallationRecordId(installationId: number) {
  return `github_installation_${installationId}`;
}

function auditGitHubInstallation(installation: GitHubAppInstallationRecord): Record<string, AuditJsonValue> {
  return {
    id: installation.id,
    installationId: installation.installationId,
    accountLogin: installation.accountLogin,
    accountType: installation.accountType ?? null,
    repositorySelection: installation.repositorySelection,
    selectedRepositoryId: installation.selectedRepositoryId ?? null,
    permissions: installation.permissions,
    suspendedAt: installation.suspendedAt ?? null
  };
}

function auditRepository(repository: RepositoryRecord): Record<string, AuditJsonValue> {
  return {
    id: repository.id,
    provider: repository.provider,
    owner: repository.owner,
    name: repository.name,
    fullName: repository.fullName,
    remoteUrl: repository.remoteUrl,
    defaultBranch: repository.defaultBranch,
    githubInstallationId: repository.githubInstallationId ?? null,
    githubRepositoryId: repository.githubRepositoryId ?? null,
    selected: repository.selected ?? false,
    permissions: repository.permissions ?? {}
  };
}

function objectFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFromUnknown(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromUnknown(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}

function repositorySelectionFromUnknown(value: unknown): GitHubAppInstallationRecord["repositorySelection"] {
  return value === "all" ? "all" : "selected";
}

function githubInstallationPermissionsFromUnknown(value: unknown): GitHubAppInstallationRecord["permissions"] {
  const input = objectFromUnknown(value) ?? {};
  const permissionLevels = new Set(["none", "read", "write", "admin"]);
  return Object.fromEntries(Object.entries(input).flatMap(([key, permission]) => {
    const level = String(permission);
    return permissionLevels.has(level) ? [[key, level]] : [];
  }));
}

function githubRepositoryFromWebhook(value: unknown, installationId: number): GitHubAppRepository | undefined {
  const repository = objectFromUnknown(value);
  if (!repository) return undefined;
  const fullName = stringFromUnknown(repository.full_name) ??
    [objectFromUnknown(repository.owner)?.login, repository.name].map(stringFromUnknown).filter(Boolean).join("/");
  const fullNameParts = fullName.split("/");
  const owner = fullNameParts[0];
  const name = fullNameParts[1];
  if (!owner || !name) return undefined;
  const permissions = objectFromUnknown(repository.permissions) ?? {};
  return {
    id: `repo_github_${installationId}_${safeRepositorySegment(owner)}_${safeRepositorySegment(name)}`,
    githubRepositoryId: String(numberFromUnknown(repository.id) ?? stringFromUnknown(repository.id) ?? fullName),
    installationId,
    owner,
    name,
    fullName,
    private: Boolean(repository.private),
    htmlUrl: stringFromUnknown(repository.html_url) ?? `https://github.com/${fullName}`,
    cloneUrl: stringFromUnknown(repository.clone_url) ?? `https://github.com/${fullName}.git`,
    defaultBranch: stringFromUnknown(repository.default_branch) ?? "main",
    permissions: Object.fromEntries(
      Object.entries(permissions).map(([key, permission]) => [key, Boolean(permission)])
    )
  };
}

function safeRepositorySegment(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "") || "repo";
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
  return redactSecrets(tests.map((test) => {
    const failure = test.failureSummary ? ` Failure: ${test.failureSummary}` : "";
    return `${test.status}: ${test.command} (${test.durationMs}ms). ${test.summary}${failure}`;
  }).join("\n")).redacted;
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
    ...(test.failureSummary ? ["", "Failure:", test.failureSummary] : []),
    ...(test.egressPolicyEvidence
      ? [
          "",
          "Egress policy:",
          `Allowed: ${test.egressPolicyEvidence.allowedCount}`,
          `Denied: ${test.egressPolicyEvidence.deniedCount}`,
          ...test.egressPolicyEvidence.denied.map((entry) => `${entry.reason}: ${entry.target}`)
        ]
      : [])
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
  const failureSummary = redactSecrets(error instanceof Error ? error.message : String(error)).redacted;
  const record = asRecord(error);
  const rawFailureType =
    error instanceof CodexRunError
      ? error.failureType
      : record && isFailureType(record.failureType)
        ? record.failureType
        : undefined;
  const testRun = error instanceof CodexRunError
    ? redactJsonValue(error.testRun)
    : record
      ? redactJsonValue(asTestRun(record.testRun))
      : undefined;
  const egressPolicyEvidence = error instanceof CodexRunError
    ? error.egressPolicyEvidence
    : record
      ? asEgressPolicyEvidence(record.egressPolicyEvidence)
      : undefined;
  const secretBrokerEvidence = error instanceof CodexRunError
    ? error.secretBrokerEvidence
    : record
      ? asSecretBrokerEvidence(record.secretBrokerEvidence)
      : undefined;
  const commandAuditEvents = error instanceof CodexRunError
    ? error.commandAuditEvents
    : record
      ? asCommandAuditEvidenceList(record.commandAuditEvents)
      : [];
  const failureType = rawFailureType || (testRun?.status === "failed" ? "test_failed" : classifyFailureMessage(failureSummary));

  return {
    failureType,
    failureSummary,
    ...(testRun ? { testRun } : {}),
    ...(egressPolicyEvidence ? { egressPolicyEvidence } : {}),
    ...(secretBrokerEvidence ? { secretBrokerEvidence } : {}),
    ...(commandAuditEvents.length > 0 ? { commandAuditEvents } : {})
  };
}

function redactRunError(error: unknown, redactionOptions: SecretRedactionOptions) {
  if (error instanceof CodexRunError) {
    return new CodexRunError(
      redactSecrets(error.message, redactionOptions).redacted,
      error.failureType,
      error.testRun ? redactJsonValue(error.testRun, redactionOptions) : undefined,
      error.egressPolicyEvidence ? redactJsonValue(error.egressPolicyEvidence, redactionOptions) : undefined,
      error.secretBrokerEvidence ? redactJsonValue(error.secretBrokerEvidence, redactionOptions) : undefined,
      error.commandAuditEvents.length > 0 ? redactJsonValue(error.commandAuditEvents, redactionOptions) : []
    );
  }
  if (error instanceof Error) {
    const redacted = new Error(redactSecrets(error.message, redactionOptions).redacted) as Error & {
      failureType?: FailureType;
      testRun?: TestRun;
      egressPolicyEvidence?: EgressPolicyEvidence;
      secretBrokerEvidence?: SecretBrokerEvidence;
      commandAuditEvents?: CommandAuditEvidence[];
    };
    redacted.name = error.name;
    const record = asRecord(error);
    if (record && isFailureType(record.failureType)) redacted.failureType = record.failureType;
    const testRun = record ? asTestRun(record.testRun) : undefined;
    const egressPolicyEvidence = record ? asEgressPolicyEvidence(record.egressPolicyEvidence) : undefined;
    const secretBrokerEvidence = record ? asSecretBrokerEvidence(record.secretBrokerEvidence) : undefined;
    const commandAuditEvents = record ? asCommandAuditEvidenceList(record.commandAuditEvents) : [];
    if (testRun) redacted.testRun = redactJsonValue(testRun, redactionOptions);
    if (egressPolicyEvidence) redacted.egressPolicyEvidence = redactJsonValue(egressPolicyEvidence, redactionOptions);
    if (secretBrokerEvidence) redacted.secretBrokerEvidence = redactJsonValue(secretBrokerEvidence, redactionOptions);
    if (commandAuditEvents.length > 0) {
      redacted.commandAuditEvents = redactJsonValue(commandAuditEvents, redactionOptions);
    }
    return redacted;
  }
  return new Error(redactSecrets(String(error), redactionOptions).redacted);
}

function attachSecretBrokerEvidence(error: unknown, evidence: SecretBrokerEvidence) {
  if (evidence.requestedSecretIds.length === 0 || !error || typeof error !== "object") return error;
  const record = error as Error & { secretBrokerEvidence?: SecretBrokerEvidence };
  if (!record.secretBrokerEvidence) record.secretBrokerEvidence = redactJsonValue(evidence) as SecretBrokerEvidence;
  return error;
}

function createRunFailureError(
  message: string,
  failureType: FailureType,
  testRun?: TestRun,
  egressPolicyEvidence?: EgressPolicyEvidence,
  secretBrokerEvidence?: SecretBrokerEvidence
) {
  const error = new Error(message) as Error & {
    failureType: FailureType;
    testRun?: TestRun;
    egressPolicyEvidence?: EgressPolicyEvidence;
    secretBrokerEvidence?: SecretBrokerEvidence;
  };
  error.message = redactSecrets(error.message).redacted;
  error.failureType = failureType;
  if (testRun) error.testRun = redactJsonValue(testRun);
  if (egressPolicyEvidence) error.egressPolicyEvidence = redactJsonValue(egressPolicyEvidence);
  if (secretBrokerEvidence) error.secretBrokerEvidence = redactJsonValue(secretBrokerEvidence);
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

function asEgressPolicyEvidence(value: unknown): EgressPolicyEvidence | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (
    typeof record.enabled !== "boolean" ||
    typeof record.mode !== "string" ||
    !Array.isArray(record.allowedHosts) ||
    typeof record.auditLogPath !== "string" ||
    typeof record.allowedCount !== "number" ||
    typeof record.deniedCount !== "number" ||
    !Array.isArray(record.denied) ||
    !Array.isArray(record.recent)
  ) {
    return undefined;
  }
  return record as unknown as EgressPolicyEvidence;
}

function asSecretBrokerEvidence(value: unknown): SecretBrokerEvidence | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  if (
    typeof record.enabled !== "boolean" ||
    (record.mode !== "env" && record.mode !== "adapter") ||
    !Array.isArray(record.requestedSecretIds) ||
    !Array.isArray(record.injected) ||
    !Array.isArray(record.denied)
  ) {
    return undefined;
  }
  return {
    ...record,
    revoked: Array.isArray(record.revoked) ? record.revoked : []
  } as unknown as SecretBrokerEvidence;
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

function createDefaultRepository() {
  const databaseUrl =
    process.env.NODE_ENV === "test"
      ? process.env.PATCHPILOT_TEST_DATABASE_URL
      : process.env.PATCHPILOT_DATABASE_URL;
  if (databaseUrl) {
    return createPostgresPatchPilotRepository({ connectionString: databaseUrl });
  }
  if (process.env.NODE_ENV === "test") {
    return createPglitePatchPilotRepository();
  }
  return createPglitePatchPilotRepository({ dataDir: defaultPgliteDataDir });
}

function isProductSnapshotEmpty(snapshot: PatchPilotSnapshot) {
  return (
    snapshot.repositories.length === 0 &&
    snapshot.githubInstallations.length === 0 &&
    snapshot.requirements.length === 0 &&
    snapshot.prds.length === 0 &&
    snapshot.workItems.length === 0 &&
    snapshot.interfaceContracts.length === 0 &&
    snapshot.agentRuns.length === 0 &&
    snapshot.workspaceRuns.length === 0 &&
    snapshot.testCases.length === 0 &&
    snapshot.testRuns.length === 0 &&
    snapshot.artifacts.length === 0 &&
    snapshot.pullRequests.length === 0 &&
    snapshot.reviewRecords.length === 0 &&
    snapshot.auditEvents.length === 0 &&
    snapshot.acceptances.length === 0 &&
    snapshot.approvals.length === 0 &&
    snapshot.bugs.length === 0
  );
}

export class DomainError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "INVALID_STATE" | "STORE_CORRUPT",
    message: string
  ) {
    super(message);
  }
}
