import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import type {
  AcceptanceDecision,
  AgentProfile,
  AgentRun,
  ApprovalRecord,
  ArtifactRecord,
  AuditEvent,
  BugReport,
  GitHubAppInstallationRecord,
  InterfaceContract,
  PatchPilotSnapshot,
  Prd,
  PullRequestRecord,
  Requirement,
  RepositoryRecord,
  ReviewRecord,
  TestCase,
  TestRun,
  WorkspaceRun,
  WorkItem
} from "@patchpilot/domain";
import { emptySnapshot } from "@patchpilot/domain";
import { asc, desc } from "drizzle-orm";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type postgres from "postgres";
import * as schema from "./schema";

const defaultOrganizationId = "org_patchpilot";
const defaultProjectId = "proj_patchpilot";
const defaultRepositoryId = "repo_patchpilot";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface MigrationExecutor {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  close?(): Promise<void>;
}

export interface PatchPilotRepositoryInfo {
  kind: "postgres";
  engine: "pglite" | "postgres";
  projectId: string;
}

export interface PatchPilotRepository {
  readonly info: PatchPilotRepositoryInfo;
  initialize(): Promise<void>;
  loadSnapshot(): Promise<PatchPilotSnapshot>;
  replaceSnapshot(snapshot: PatchPilotSnapshot): Promise<void>;
  close(): Promise<void>;
}

export interface PgliteRepositoryOptions {
  dataDir?: string;
  autoMigrate?: boolean;
}

export interface PostgresRepositoryOptions {
  connectionString: string;
  autoMigrate?: boolean;
}

export async function createPglitePatchPilotRepository(
  options: PgliteRepositoryOptions = {}
): Promise<PatchPilotRepository> {
  const client = options.dataDir ? new PGlite(options.dataDir) : new PGlite();
  const db = drizzlePglite(client, { schema });
  const repository = new DrizzlePatchPilotRepository(
    db,
    {
      query: async <T>(sql: string, params: unknown[] = []) => {
        const result = await client.query<T>(sql, params);
        return result.rows;
      },
      execute: async (sql: string, params: unknown[] = []) => {
        if (params.length > 0) await client.query(sql, params);
        else await client.exec(sql);
      },
      close: () => client.close()
    },
    { kind: "postgres", engine: "pglite", projectId: defaultProjectId },
    options.autoMigrate ?? true
  );
  await repository.initialize();
  return repository;
}

export async function createPostgresPatchPilotRepository(
  options: PostgresRepositoryOptions
): Promise<PatchPilotRepository> {
  const postgresModule = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const sql = postgresModule.default(options.connectionString, { max: 1 });
  const db = drizzle(sql, { schema });
  const executor = postgresExecutor(sql);
  const repository = new DrizzlePatchPilotRepository(
    db,
    executor,
    { kind: "postgres", engine: "postgres", projectId: defaultProjectId },
    options.autoMigrate ?? true
  );
  await repository.initialize();
  return repository;
}

class DrizzlePatchPilotRepository implements PatchPilotRepository {
  private initialized: Promise<void> | undefined;

  constructor(
    private readonly db: any,
    private readonly migrations: MigrationExecutor,
    public readonly info: PatchPilotRepositoryInfo,
    private readonly autoMigrate: boolean
  ) {}

  initialize(): Promise<void> {
    this.initialized ??= this.autoMigrate ? applyMigrations(this.migrations) : Promise.resolve();
    return this.initialized;
  }

  async close(): Promise<void> {
    await this.migrations.close?.();
  }

  async loadSnapshot(): Promise<PatchPilotSnapshot> {
    await this.initialize();
    const projectRows = await this.db.select().from(schema.projects).limit(1);
    if (projectRows.length === 0) return emptySnapshot();

    const repositoryRows = await this.db
      .select()
      .from(schema.repositories)
      .orderBy(desc(schema.repositories.updatedAt), asc(schema.repositories.id));
    const githubInstallationRows = await this.db
      .select()
      .from(schema.githubAppInstallations)
      .orderBy(desc(schema.githubAppInstallations.updatedAt), asc(schema.githubAppInstallations.id));
    const requirementRows = await this.db
      .select()
      .from(schema.requirements)
      .orderBy(desc(schema.requirements.createdAt), asc(schema.requirements.id));
    const prdRows = await this.db
      .select()
      .from(schema.prdVersions)
      .orderBy(desc(schema.prdVersions.updatedAt), asc(schema.prdVersions.id));
    const workItemRows = await this.db
      .select()
      .from(schema.workItems)
      .orderBy(desc(schema.workItems.updatedAt), asc(schema.workItems.id));
    const interfaceContractRows = await this.db
      .select()
      .from(schema.interfaceContracts)
      .orderBy(desc(schema.interfaceContracts.updatedAt), asc(schema.interfaceContracts.id));
    const agentRunRows = await this.db
      .select()
      .from(schema.agentRuns)
      .orderBy(desc(schema.agentRuns.startedAt), asc(schema.agentRuns.id));
    const workspaceRunRows = await this.db
      .select()
      .from(schema.workspaceRuns)
      .orderBy(desc(schema.workspaceRuns.updatedAt), asc(schema.workspaceRuns.id));
    const pullRequestRows = await this.db
      .select()
      .from(schema.pullRequests)
      .orderBy(desc(schema.pullRequests.updatedAt), asc(schema.pullRequests.id));
    const reviewRecordRows = await this.db
      .select()
      .from(schema.reviewRecords)
      .orderBy(desc(schema.reviewRecords.updatedAt), asc(schema.reviewRecords.id));
    const testCaseRows = await this.db
      .select()
      .from(schema.testCases)
      .orderBy(desc(schema.testCases.updatedAt), asc(schema.testCases.id));
    const testRunRows = await this.db
      .select()
      .from(schema.testRuns)
      .orderBy(desc(schema.testRuns.createdAt), asc(schema.testRuns.id));
    const defectRows = await this.db
      .select()
      .from(schema.defects)
      .orderBy(desc(schema.defects.updatedAt), asc(schema.defects.id));
    const artifactRows = await this.db
      .select()
      .from(schema.artifacts)
      .orderBy(desc(schema.artifacts.createdAt), asc(schema.artifacts.id));
    const approvalRows = await this.db
      .select()
      .from(schema.approvals)
      .orderBy(desc(schema.approvals.updatedAt), asc(schema.approvals.id));
    const acceptanceRows = await this.db
      .select()
      .from(schema.acceptanceDecisions)
      .orderBy(desc(schema.acceptanceDecisions.updatedAt), asc(schema.acceptanceDecisions.runId));
    const auditEventRows = await this.db
      .select()
      .from(schema.auditEvents)
      .orderBy(desc(schema.auditEvents.createdAt), asc(schema.auditEvents.id));
    const agentRows = await this.db
      .select()
      .from(schema.agents)
      .orderBy(asc(schema.agents.id));

    const auditEvents = orderAuditEvents(auditEventRows.map(mapAuditEventRow));
    return {
      repositories: repositoryRows.map(mapRepositoryRow),
      githubInstallations: githubInstallationRows.map(mapGitHubAppInstallationRow),
      requirements: requirementRows.map(mapRequirementRow),
      prds: prdRows.map(mapPrdRow),
      workItems: workItemRows.map(mapWorkItemRow),
      interfaceContracts: interfaceContractRows.map(mapInterfaceContractRow),
      agentRuns: agentRunRows.map(mapAgentRunRow),
      workspaceRuns: workspaceRunRows.map(mapWorkspaceRunRow),
      testCases: testCaseRows.map(mapTestCaseRow),
      testRuns: testRunRows.map(mapTestRunRow),
      artifacts: artifactRows.map(mapArtifactRow),
      pullRequests: pullRequestRows.map(mapPullRequestRow),
      reviewRecords: reviewRecordRows.map(mapReviewRecordRow),
      auditEvents,
      acceptances: acceptanceRows.map(mapAcceptanceDecisionRow),
      approvals: approvalRows.map(mapApprovalRow),
      bugs: defectRows.map(mapBugReportRow),
      agents: agentRows.map(mapAgentRow)
    };
  }

  async replaceSnapshot(snapshot: PatchPilotSnapshot): Promise<void> {
    await this.initialize();
    const rows = prepareRows(snapshot);
    await this.db.transaction(async (tx: any) => {
      await clearProductState(tx);
      await insertRows(tx, schema.organizations, rows.organizations);
      await insertRows(tx, schema.projects, rows.projects);
      await insertRows(tx, schema.githubAppInstallations, rows.githubAppInstallations);
      await insertRows(tx, schema.repositories, rows.repositories);
      await insertRows(tx, schema.agents, rows.agents);
      await insertRows(tx, schema.requirements, rows.requirements);
      await insertRows(tx, schema.prdVersions, rows.prdVersions);
      await insertRows(tx, schema.workItems, rows.workItems);
      await insertRows(tx, schema.interfaceContracts, rows.interfaceContracts);
      await insertRows(tx, schema.agentRuns, rows.agentRuns);
      await insertRows(tx, schema.workspaceRuns, rows.workspaceRuns);
      await insertRows(tx, schema.pullRequests, rows.pullRequests);
      await insertRows(tx, schema.reviewRecords, rows.reviewRecords);
      await insertRows(tx, schema.testCases, rows.testCases);
      await insertRows(tx, schema.testRuns, rows.testRuns);
      await insertRows(tx, schema.defects, rows.defects);
      await insertRows(tx, schema.acceptanceDecisions, rows.acceptanceDecisions);
      await insertRows(tx, schema.approvals, rows.approvals);
      await insertRows(tx, schema.artifacts, rows.artifacts);
      await insertRows(tx, schema.auditEvents, rows.auditEvents);
    });
  }
}

async function clearProductState(tx: any) {
  await tx.delete(schema.budgets);
  await tx.delete(schema.capabilityManifests);
  await tx.delete(schema.auditEvents);
  await tx.delete(schema.artifacts);
  await tx.delete(schema.approvals);
  await tx.delete(schema.acceptanceDecisions);
  await tx.delete(schema.reviewRecords);
  await tx.delete(schema.defects);
  await tx.delete(schema.testRuns);
  await tx.delete(schema.testCases);
  await tx.delete(schema.pullRequests);
  await tx.delete(schema.workspaceRuns);
  await tx.delete(schema.agentRuns);
  await tx.delete(schema.interfaceContracts);
  await tx.delete(schema.workItems);
  await tx.delete(schema.agents);
  await tx.delete(schema.prdVersions);
  await tx.delete(schema.requirements);
  await tx.delete(schema.repositories);
  await tx.delete(schema.githubAppInstallations);
  await tx.delete(schema.projects);
  await tx.delete(schema.organizations);
}

async function insertRows(tx: any, table: unknown, rows: unknown[]) {
  if (rows.length === 0) return;
  await tx.insert(table).values(rows);
}

function prepareRows(snapshot: PatchPilotSnapshot) {
  const now = new Date();
  const requirementsById = new Map(snapshot.requirements.map((requirement) => [requirement.id, requirement]));
  const prdsById = new Map(snapshot.prds.map((prd) => [prd.id, prd]));
  const workItemsById = new Map(snapshot.workItems.map((workItem) => [workItem.id, workItem]));
  const requirementIds = new Set(snapshot.requirements.map((requirement) => requirement.id));
  const prdIds = new Set(snapshot.prds.map((prd) => prd.id));
  const workItemIds = new Set(snapshot.workItems.map((workItem) => workItem.id));
  const agentRunIds = new Set(snapshot.agentRuns.map((run) => run.id));
  const testCaseIds = new Set(snapshot.testCases.map((testCase) => testCase.id));
  const testRunIds = new Set(snapshot.testRuns.map((testRun) => testRun.id));
  const pullRequestIds = new Set(snapshot.pullRequests.map((pullRequest) => pullRequest.id));
  const agentIds = new Set(snapshot.agents.map((agent) => agent.id));
  const repositoryIds = new Set((snapshot.repositories ?? []).map((repository) => repository.id));

  return {
    organizations: [
      {
        id: defaultOrganizationId,
        slug: "patchpilot",
        name: "PatchPilot",
        createdAt: now,
        updatedAt: now
      }
    ],
    projects: [
      {
        id: defaultProjectId,
        organizationId: defaultOrganizationId,
        slug: "default",
        name: "PatchPilot Default Project",
        createdAt: now,
        updatedAt: now
      }
    ],
    githubAppInstallations: (snapshot.githubInstallations ?? []).map((installation) => ({
      id: installation.id,
      projectId: defaultProjectId,
      installationId: String(installation.installationId),
      accountLogin: installation.accountLogin,
      accountType: installation.accountType ?? null,
      repositorySelection: installation.repositorySelection,
      permissions: installation.permissions,
      selectedRepositoryId: installation.selectedRepositoryId ?? null,
      suspendedAt: toDate(installation.suspendedAt),
      createdAt: toDate(installation.createdAt) ?? now,
      updatedAt: toDate(installation.updatedAt) ?? now
    })),
    repositories: (snapshot.repositories && snapshot.repositories.length > 0 ? snapshot.repositories : [defaultRepository(now)])
      .map((repository) => ({
        id: repository.id,
        projectId: defaultProjectId,
        provider: repository.provider,
        owner: repository.owner,
        name: repository.name,
        remoteUrl: repository.remoteUrl,
        htmlUrl: repository.htmlUrl ?? null,
        defaultBranch: repository.defaultBranch,
        githubInstallationId: repository.githubInstallationId ?? null,
        githubRepositoryId: repository.githubRepositoryId ?? null,
        private: repository.private ?? false,
        selected: repository.selected ?? false,
        permissions: repository.permissions ?? {},
        createdAt: toDate(repository.createdAt) ?? now,
        updatedAt: toDate(repository.updatedAt) ?? now
      })),
    requirements: snapshot.requirements.map((requirement) => ({
      id: requirement.id,
      projectId: defaultProjectId,
      title: requirement.title,
      rawInput: requirement.rawInput,
      inputType: requirement.template,
      status: requirement.status,
      simpleSummary: requirement.simpleSummary,
      createdBy: "human",
      artifactReferences: requirement.artifactReferences ?? [],
      clarificationQuestions: requirement.clarificationQuestions,
      clarificationTurns: requirement.clarificationTurns,
      createdAt: toDate(requirement.createdAt) ?? now,
      updatedAt: toDate(requirement.updatedAt) ?? now
    })),
    prdVersions: snapshot.prds.map((prd) => {
      const requirement = requirementsById.get(prd.requirementId);
      return {
        id: prd.id,
        projectId: defaultProjectId,
        requirementId: prd.requirementId,
        version: prd.version,
        status: prd.status,
        title: prd.title,
        bodyMarkdown: prd.bodyMarkdown,
        acceptanceCriteria: prd.acceptanceCriteria,
        budgetUsd: decimalOrNull(prd.budgetUsd),
        approvedAt: toDate(prd.approvedAt),
        createdAt: toDate(requirement?.createdAt) ?? now,
        updatedAt: toDate(prd.approvedAt || requirement?.updatedAt || requirement?.createdAt) ?? now
      };
    }),
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      projectId: defaultProjectId,
      name: agent.name,
      role: agent.role,
      status: agent.status,
      currentWorkItemId: agent.currentWorkItemId ?? null,
      capabilities: agent.capabilities ?? [],
      lastSeenAt: toDate(agent.lastSeenAt) ?? now,
      createdAt: now,
      updatedAt: toDate(agent.lastSeenAt) ?? now
    })),
    workItems: snapshot.workItems.map((workItem) => {
      const prd = prdsById.get(workItem.prdId);
      return {
        id: workItem.id,
        projectId: defaultProjectId,
        requirementId: prd?.requirementId ?? fallbackRequirementId(snapshot),
        prdVersionId: workItem.prdId,
        repositoryId: optionalReference(workItem.repositoryId, repositoryIds),
        repositoryFullName: workItem.repositoryFullName ?? null,
        title: workItem.title,
        status: workItem.status,
        role: workItem.role,
        scope: workItem.scope,
        nonGoals: workItem.nonGoals,
        acceptanceCriteria: workItem.acceptanceCriteria,
        testSuggestions: workItem.testSuggestions,
        dependsOn: workItem.dependsOn ?? [],
        requiredCapabilities: workItem.requiredCapabilities ?? [],
        budgetUsd: decimalOrNull(workItem.budgetUsd),
        concurrencyKey: workItem.concurrencyKey ?? null,
        maxConcurrent: workItem.maxConcurrent ?? null,
        assignedAgentId: optionalReference(workItem.assignedAgentId, agentIds),
        claimedAt: toDate(workItem.claimedAt),
        claimToken: workItem.claimToken ?? null,
        leaseExpiresAt: toDate(workItem.leaseExpiresAt),
        heartbeatAt: toDate(workItem.heartbeatAt),
        version: workItem.version ?? 1,
        sourceDefectId: workItem.sourceBugId ?? null,
        externalIssueLinks: workItem.externalIssueLinks ?? [],
        externalIssueSyncEvidence: workItem.externalIssueSyncEvidence ?? [],
        externalBlocker: workItem.externalBlocker ?? null,
        reworkCount: workItem.reworkCount ?? 0,
        lastRejectionReason: workItem.lastRejectionReason ?? null,
        createdAt: toDate(workItem.createdAt) ?? now,
        updatedAt: toDate(workItem.updatedAt) ?? now
      };
    }),
    interfaceContracts: snapshot.interfaceContracts.map((contract) => {
      const prd = prdsById.get(contract.prdId);
      return {
        id: contract.id,
        projectId: defaultProjectId,
        requirementId: prd?.requirementId ?? fallbackRequirementId(snapshot),
        prdVersionId: contract.prdId,
        repositoryId: optionalReference(contract.repositoryId, repositoryIds),
        repositoryFullName: contract.repositoryFullName ?? null,
        name: contract.name,
        kind: contract.kind,
        status: contract.status,
        version: contract.version,
        summary: contract.summary,
        providerRole: contract.providerRole,
        consumerRoles: contract.consumerRoles,
        specMarkdown: contract.specMarkdown,
        specJson: contract.registry ?? {},
        testSuggestions: contract.testSuggestions,
        createdAt: toDate(contract.createdAt) ?? now,
        updatedAt: toDate(contract.updatedAt) ?? now
      };
    }),
    agentRuns: snapshot.agentRuns.map((run) => {
      const workItem = workItemsById.get(run.workItemId);
      return {
        id: run.id,
        projectId: defaultProjectId,
        requirementId: run.requirementId,
        prdVersionId: run.prdId,
        workItemId: run.workItemId,
        agentId: optionalReference(workItem?.assignedAgentId, agentIds),
        runner: run.runner,
        status: run.status,
        currentStep: run.currentStep,
        timeline: run.timeline,
        events: run.events,
        result: run.result ?? null,
        failureType: run.failureType ?? null,
        failureSummary: run.failureSummary ?? null,
        budgetUsd: decimalOrNull(run.budgetUsd),
        budgetSoftThresholdUsd: decimalOrNull(run.budgetSoftThresholdUsd),
        budgetApprovalId: run.budgetApprovalId ?? null,
        costEstimateUsd: decimalOrNull(run.costEstimateUsd) ?? "0",
        costActualUsd: decimalOrNull(run.costActualUsd),
        artifactIds: run.artifactIds ?? [],
        startedAt: toDate(run.startedAt) ?? now,
        endedAt: toDate(run.endedAt),
        createdAt: toDate(run.startedAt) ?? now,
        updatedAt: toDate(run.endedAt || run.startedAt) ?? now
      };
    }),
    workspaceRuns: snapshot.workspaceRuns.map((workspace) => ({
      id: workspace.id,
      projectId: defaultProjectId,
      requirementId: workspace.requirementId,
      prdVersionId: workspace.prdId,
      workItemId: workspace.workItemId,
      agentRunId: workspace.runId,
      repositoryId: optionalReference(workspace.repositoryId, repositoryIds),
      repositoryFullName: workspace.repositoryFullName ?? null,
      runner: workspace.runner,
      status: workspace.status,
      isolation: workspace.isolation,
      path: workspace.path,
      createdAt: toDate(workspace.createdAt) ?? now,
      updatedAt: toDate(workspace.updatedAt) ?? now,
      archivedAt: toDate(workspace.archivedAt)
    })),
    pullRequests: snapshot.pullRequests.map((pullRequest) => ({
      id: pullRequest.id,
      projectId: defaultProjectId,
      provider: pullRequest.provider,
      status: pullRequest.status,
      title: pullRequest.title,
      requirementId: pullRequest.requirementId,
      prdVersionId: pullRequest.prdId,
      workItemId: pullRequest.workItemId,
      agentRunId: pullRequest.runId,
      repositoryId: optionalReference(pullRequest.repositoryId, repositoryIds),
      repositoryFullName: pullRequest.repositoryFullName ?? null,
      branchName: pullRequest.branchName,
      baseBranch: pullRequest.baseBranch,
      baseCommit: pullRequest.baseCommit ?? null,
      headCommit: pullRequest.headCommit ?? null,
      url: pullRequest.url,
      bodyMarkdown: pullRequest.bodyMarkdown,
      reviewerSummary: pullRequest.reviewerSummary,
      testSummary: pullRequest.testSummary,
      createdAt: toDate(pullRequest.createdAt) ?? now,
      updatedAt: toDate(pullRequest.updatedAt) ?? now
    })),
    reviewRecords: snapshot.reviewRecords.map((review) => ({
      id: review.id,
      projectId: defaultProjectId,
      status: review.status,
      requirementId: review.requirementId,
      prdVersionId: review.prdId,
      workItemId: review.workItemId,
      agentRunId: review.runId,
      linkedPullRequestId: review.linkedPullRequestId,
      reviewerAgentId: optionalReference(review.reviewerAgentId, agentIds),
      summary: review.summary,
      testSummary: review.testSummary,
      riskLevel: review.riskLevel,
      findings: review.findings,
      createdAt: toDate(review.createdAt) ?? now,
      updatedAt: toDate(review.updatedAt) ?? now
    })),
    testCases: snapshot.testCases.map((testCase) => ({
      id: testCase.id,
      projectId: defaultProjectId,
      requirementId: testCase.requirementId,
      prdVersionId: testCase.prdId,
      workItemId: testCase.workItemId,
      repositoryId: optionalReference(testCase.repositoryId, repositoryIds),
      repositoryFullName: testCase.repositoryFullName ?? null,
      sourceDefectId: testCase.sourceBugId ?? null,
      title: testCase.title,
      kind: testCase.kind,
      status: testCase.status,
      priority: testCase.priority,
      steps: testCase.steps,
      expectedResult: testCase.expectedResult,
      linkedAcceptanceCriteria: testCase.linkedAcceptanceCriteria,
      lastRunId: testCase.lastRunId ?? null,
      lastTestRunId: testCase.lastTestRunId ?? null,
      flaky: testCase.flaky ?? false,
      createdAt: toDate(testCase.createdAt) ?? now,
      updatedAt: toDate(testCase.updatedAt) ?? now
    })),
    testRuns: snapshot.testRuns.map((testRun) => ({
      id: testRun.id,
      projectId: defaultProjectId,
      requirementId: testRun.prdId ? prdsById.get(testRun.prdId)?.requirementId ?? null : null,
      prdVersionId: testRun.prdId ?? null,
      workItemId: testRun.workItemId ?? null,
      repositoryId: optionalReference(testRun.repositoryId, repositoryIds),
      repositoryFullName: testRun.repositoryFullName ?? null,
      testCaseId: optionalReference(testRun.testCaseId, testCaseIds),
      agentRunId: optionalReference(testRun.runId, agentRunIds),
      pullRequestId: optionalReference(testRun.pullRequestId, pullRequestIds),
      status: testRun.status,
      command: testRun.command,
      summary: testRun.summary,
      durationMs: testRun.durationMs,
      startedAt: toDate(testRun.startedAt),
      endedAt: toDate(testRun.endedAt),
      commit: testRun.commit ?? null,
      branch: testRun.branch ?? null,
      workspacePath: testRun.workspacePath ?? null,
      runner: testRun.runner ?? null,
      environmentImage: testRun.environmentImage ?? null,
      exitCode: testRun.exitCode ?? null,
      failureSummary: testRun.failureSummary ?? null,
      logArtifactId: testRun.logArtifactId ?? null,
      artifactIds: testRun.artifactIds ?? [],
      retryCount: testRun.retryCount ?? 0,
      attempt: testRun.attempt ?? null,
      maxAttempts: testRun.maxAttempts ?? null,
      flakySignal: testRun.flakySignal ?? false,
      createdAt: toDate(testRun.endedAt || testRun.startedAt) ?? now
    })),
    defects: snapshot.bugs.map((bug) => ({
      id: bug.id,
      projectId: defaultProjectId,
      requirementId: bug.requirementId,
      prdVersionId: bug.prdId,
      workItemId: bug.workItemId,
      sourceAgentRunId: optionalReference(bug.sourceRunId, agentRunIds),
      sourceTestRunId: optionalReference(bug.sourceTestRunId, testRunIds),
      title: bug.title,
      description: bug.description,
      reproductionSteps: bug.reproductionSteps,
      expectedBehavior: bug.expectedBehavior,
      actualBehavior: bug.actualBehavior,
      severity: bug.severity,
      status: bug.status,
      reporter: bug.reporter,
      artifactReferences: bug.artifactReferences ?? [],
      externalIssueLinks: bug.externalIssueLinks ?? [],
      externalIssueSyncEvidence: bug.externalIssueSyncEvidence ?? [],
      externalBlocker: bug.externalBlocker ?? null,
      sourceFailureType: bug.sourceFailureType ?? null,
      sourceCommit: bug.sourceCommit ?? null,
      sourceBranch: bug.sourceBranch ?? null,
      createdAt: toDate(bug.createdAt) ?? now,
      updatedAt: toDate(bug.updatedAt) ?? now
    })),
    acceptanceDecisions: snapshot.acceptances.map((acceptance) => ({
      runId: acceptance.runId,
      projectId: defaultProjectId,
      status: acceptance.status,
      reason: acceptance.reason ?? null,
      decidedAt: toDate(acceptance.decidedAt),
      createdAt: toDate(acceptance.decidedAt) ?? now,
      updatedAt: toDate(acceptance.decidedAt) ?? now
    })),
    approvals: snapshot.approvals.map((approval) => ({
      id: approval.id,
      projectId: defaultProjectId,
      kind: approval.kind,
      status: approval.status,
      targetType: approval.targetType,
      targetId: approval.targetId,
      requestedBy: approval.requestedBy,
      requestedReason: approval.requestedReason,
      riskLevel: approval.riskLevel,
      expiresAt: toDate(approval.expiresAt) ?? now,
      approvedBy: approval.approvedBy ?? null,
      deniedBy: approval.deniedBy ?? null,
      decisionReason: approval.decisionReason ?? null,
      decidedAt: toDate(approval.decidedAt),
      requirementId: optionalReference(approval.requirementId, requirementIds),
      prdVersionId: optionalReference(approval.prdId, prdIds),
      workItemId: optionalReference(approval.workItemId, workItemIds),
      agentRunId: optionalReference(approval.runId, agentRunIds),
      createdAt: toDate(approval.createdAt) ?? now,
      updatedAt: toDate(approval.updatedAt) ?? now
    })),
    artifacts: snapshot.artifacts.map((artifact) => ({
      id: artifact.id,
      projectId: defaultProjectId,
      kind: artifact.kind,
      storage: artifact.storage,
      uri: artifact.uri,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      checksumSha256: artifact.checksumSha256,
      metadata: artifact.metadata ?? {},
      requirementId: optionalReference(artifact.requirementId, requirementIds),
      prdVersionId: optionalReference(artifact.prdId, prdIds),
      workItemId: optionalReference(artifact.workItemId, workItemIds),
      agentRunId: optionalReference(artifact.runId, agentRunIds),
      testRunId: optionalReference(artifact.testRunId, testRunIds),
      createdAt: toDate(artifact.createdAt) ?? now
    })),
    auditEvents: snapshot.auditEvents.map((event) => ({
      id: event.id,
      projectId: defaultProjectId,
      traceId: event.traceId,
      actorType: event.actorType,
      actorId: event.actorId,
      actorDisplay: event.actor ?? null,
      action: event.action,
      targetType: event.targetType,
      targetId: event.targetId,
      message: event.message,
      beforeJson: event.beforeJson,
      afterJson: event.afterJson,
      metadataJson: event.metadataJson,
      hash: event.hash,
      previousHash: event.previousHash,
      requirementId: optionalReference(event.requirementId, requirementIds),
      prdVersionId: optionalReference(event.prdId, prdIds),
      workItemId: optionalReference(event.workItemId, workItemIds),
      agentRunId: optionalReference(event.runId, agentRunIds),
      createdAt: toDate(event.createdAt) ?? now
    }))
  };
}

function defaultRepository(now: Date): RepositoryRecord {
  return {
    id: defaultRepositoryId,
    provider: "git",
    owner: "local",
    name: "patchpilot",
    fullName: "local/patchpilot",
    remoteUrl: "local://patchpilot",
    defaultBranch: "main",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
}

async function applyMigrations(executor: MigrationExecutor) {
  await executor.execute(
    "create table if not exists __patchpilot_migrations (name text primary key, applied_at timestamptz not null default now())"
  );
  const migrationDir = resolve(packageRoot, "drizzle");
  const migrationFiles = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    const applied = await executor.query<{ name: string }>(
      "select name from __patchpilot_migrations where name = $1",
      [file]
    );
    if (applied.length > 0) continue;
    const migrationSql = await readFile(resolve(migrationDir, file), "utf8");
    for (const statement of splitMigrationStatements(migrationSql)) {
      await executor.execute(statement);
    }
    await executor.execute("insert into __patchpilot_migrations (name) values ($1)", [file]);
  }
}

function splitMigrationStatements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function postgresExecutor(sql: postgres.Sql): MigrationExecutor {
  return {
    query: async <T>(query: string, params: unknown[] = []) => {
      const rows = await sql.unsafe(query, params as never[]);
      return rows as unknown as T[];
    },
    execute: async (query: string, params: unknown[] = []) => {
      await sql.unsafe(query, params as never[]);
    },
    close: async () => {
      await sql.end({ timeout: 5 });
    }
  };
}

function mapRepositoryRow(row: any): RepositoryRecord {
  return removeUndefined({
    id: row.id,
    provider: row.provider,
    owner: row.owner,
    name: row.name,
    fullName: `${row.owner}/${row.name}`,
    remoteUrl: row.remoteUrl,
    htmlUrl: row.htmlUrl ?? undefined,
    defaultBranch: row.defaultBranch,
    githubInstallationId: row.githubInstallationId ?? undefined,
    githubRepositoryId: row.githubRepositoryId ?? undefined,
    private: row.private,
    selected: row.selected,
    permissions: jsonObject<Record<string, boolean>>(row.permissions),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapGitHubAppInstallationRow(row: any): GitHubAppInstallationRecord {
  return removeUndefined({
    id: row.id,
    installationId: Number(row.installationId),
    accountLogin: row.accountLogin,
    accountType: row.accountType ?? undefined,
    repositorySelection: row.repositorySelection,
    permissions: jsonObject<Record<string, GitHubAppInstallationRecord["permissions"][string]>>(row.permissions),
    selectedRepositoryId: row.selectedRepositoryId ?? undefined,
    suspendedAt: optionalIso(row.suspendedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapRequirementRow(row: any): Requirement {
  return {
    id: row.id,
    title: row.title,
    rawInput: row.rawInput,
    template: row.inputType,
    status: row.status,
    simpleSummary: row.simpleSummary,
    artifactReferences: jsonArray<NonNullable<Requirement["artifactReferences"]>[number]>(row.artifactReferences),
    clarificationQuestions: jsonArray<Requirement["clarificationQuestions"][number]>(row.clarificationQuestions),
    clarificationTurns: jsonArray<Requirement["clarificationTurns"][number]>(row.clarificationTurns),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapPrdRow(row: any): Prd {
  return removeUndefined({
    id: row.id,
    requirementId: row.requirementId,
    version: row.version,
    status: row.status,
    title: row.title,
    bodyMarkdown: row.bodyMarkdown,
    acceptanceCriteria: jsonArray(row.acceptanceCriteria),
    budgetUsd: optionalNumber(row.budgetUsd),
    approvedAt: optionalIso(row.approvedAt)
  });
}

function mapWorkItemRow(row: any): WorkItem {
  return removeUndefined({
    id: row.id,
    prdId: row.prdVersionId,
    repositoryId: row.repositoryId ?? undefined,
    repositoryFullName: row.repositoryFullName ?? undefined,
    title: row.title,
    status: row.status,
    role: row.role,
    scope: row.scope,
    nonGoals: jsonArray(row.nonGoals),
    acceptanceCriteria: jsonArray(row.acceptanceCriteria),
    testSuggestions: jsonArray(row.testSuggestions),
    dependsOn: jsonArray(row.dependsOn),
    requiredCapabilities: jsonArray(row.requiredCapabilities),
    budgetUsd: optionalNumber(row.budgetUsd),
    concurrencyKey: row.concurrencyKey ?? undefined,
    maxConcurrent: row.maxConcurrent ?? undefined,
    assignedAgentId: row.assignedAgentId ?? undefined,
    claimedAt: optionalIso(row.claimedAt),
    claimToken: row.claimToken ?? undefined,
    leaseExpiresAt: optionalIso(row.leaseExpiresAt),
    heartbeatAt: optionalIso(row.heartbeatAt),
    version: row.version,
    sourceBugId: row.sourceDefectId ?? undefined,
    externalIssueLinks: jsonArray<NonNullable<WorkItem["externalIssueLinks"]>[number]>(row.externalIssueLinks),
    externalIssueSyncEvidence: jsonArray<NonNullable<WorkItem["externalIssueSyncEvidence"]>[number]>(row.externalIssueSyncEvidence),
    externalBlocker: jsonOptional<WorkItem["externalBlocker"]>(row.externalBlocker),
    reworkCount: row.reworkCount,
    lastRejectionReason: row.lastRejectionReason ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapInterfaceContractRow(row: any): InterfaceContract {
  const registry = jsonOptional<InterfaceContract["registry"]>(row.specJson);
  return {
    id: row.id,
    prdId: row.prdVersionId,
    ...(row.repositoryId ? { repositoryId: row.repositoryId } : {}),
    ...(row.repositoryFullName ? { repositoryFullName: row.repositoryFullName } : {}),
    name: row.name,
    kind: row.kind,
    status: row.status,
    version: row.version,
    summary: row.summary,
    providerRole: row.providerRole,
    consumerRoles: jsonArray(row.consumerRoles),
    specMarkdown: row.specMarkdown,
    testSuggestions: jsonArray(row.testSuggestions),
    ...(registry?.artifactId ? { registry } : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapAgentRunRow(row: any): AgentRun {
  return removeUndefined({
    id: row.id,
    requirementId: row.requirementId,
    prdId: row.prdVersionId,
    workItemId: row.workItemId,
    runner: row.runner,
    status: row.status,
    currentStep: row.currentStep,
    timeline: jsonArray<AgentRun["timeline"][number]>(row.timeline),
    events: jsonArray<AgentRun["events"][number]>(row.events),
    result: jsonOptional<AgentRun["result"]>(row.result),
    failureType: row.failureType ?? undefined,
    failureSummary: row.failureSummary ?? undefined,
    budgetUsd: optionalNumber(row.budgetUsd),
    budgetSoftThresholdUsd: optionalNumber(row.budgetSoftThresholdUsd),
    budgetApprovalId: row.budgetApprovalId ?? undefined,
    costEstimateUsd: numberFromDb(row.costEstimateUsd),
    costActualUsd: optionalNumber(row.costActualUsd),
    artifactIds: jsonArray(row.artifactIds),
    startedAt: iso(row.startedAt),
    endedAt: optionalIso(row.endedAt)
  });
}

function mapWorkspaceRunRow(row: any): WorkspaceRun {
  return removeUndefined({
    id: row.id,
    runId: row.agentRunId,
    requirementId: row.requirementId,
    prdId: row.prdVersionId,
    workItemId: row.workItemId,
    repositoryId: row.repositoryId ?? undefined,
    repositoryFullName: row.repositoryFullName ?? undefined,
    runner: row.runner,
    status: row.status,
    isolation: row.isolation,
    path: row.path,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    archivedAt: optionalIso(row.archivedAt)
  });
}

function mapPullRequestRow(row: any): PullRequestRecord {
  return removeUndefined({
    id: row.id,
    provider: row.provider,
    status: row.status,
    title: row.title,
    requirementId: row.requirementId,
    prdId: row.prdVersionId,
    workItemId: row.workItemId,
    runId: row.agentRunId,
    repositoryId: row.repositoryId ?? undefined,
    repositoryFullName: row.repositoryFullName ?? undefined,
    branchName: row.branchName,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit ?? undefined,
    headCommit: row.headCommit ?? undefined,
    url: row.url,
    bodyMarkdown: row.bodyMarkdown,
    reviewerSummary: row.reviewerSummary,
    testSummary: row.testSummary,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapReviewRecordRow(row: any): ReviewRecord {
  return {
    id: row.id,
    status: row.status,
    requirementId: row.requirementId,
    prdId: row.prdVersionId,
    workItemId: row.workItemId,
    runId: row.agentRunId,
    linkedPullRequestId: row.linkedPullRequestId,
    reviewerAgentId: row.reviewerAgentId ?? "agent_reviewer",
    summary: row.summary,
    testSummary: row.testSummary,
    riskLevel: row.riskLevel,
    findings: jsonArray(row.findings),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  };
}

function mapTestCaseRow(row: any): TestCase {
  return removeUndefined({
    id: row.id,
    requirementId: row.requirementId,
    prdId: row.prdVersionId,
    workItemId: row.workItemId,
    repositoryId: row.repositoryId ?? undefined,
    repositoryFullName: row.repositoryFullName ?? undefined,
    sourceBugId: row.sourceDefectId ?? undefined,
    title: row.title,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    steps: jsonArray(row.steps),
    expectedResult: row.expectedResult,
    linkedAcceptanceCriteria: jsonArray(row.linkedAcceptanceCriteria),
    lastRunId: row.lastRunId ?? undefined,
    lastTestRunId: row.lastTestRunId ?? undefined,
    flaky: row.flaky,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapTestRunRow(row: any): TestRun {
  return removeUndefined({
    id: row.id,
    testCaseId: row.testCaseId ?? undefined,
    runId: row.agentRunId ?? undefined,
    prdId: row.prdVersionId ?? undefined,
    workItemId: row.workItemId ?? undefined,
    repositoryId: row.repositoryId ?? undefined,
    repositoryFullName: row.repositoryFullName ?? undefined,
    status: row.status,
    command: row.command,
    summary: row.summary,
    durationMs: row.durationMs,
    startedAt: optionalIso(row.startedAt),
    endedAt: optionalIso(row.endedAt),
    commit: row.commit ?? undefined,
    branch: row.branch ?? undefined,
    pullRequestId: row.pullRequestId ?? undefined,
    workspacePath: row.workspacePath ?? undefined,
    runner: row.runner ?? undefined,
    environmentImage: row.environmentImage ?? undefined,
    exitCode: row.exitCode ?? undefined,
    failureSummary: row.failureSummary ?? undefined,
    logArtifactId: row.logArtifactId ?? undefined,
    artifactIds: jsonArray(row.artifactIds),
    retryCount: row.retryCount,
    attempt: row.attempt ?? undefined,
    maxAttempts: row.maxAttempts ?? undefined,
    flakySignal: row.flakySignal
  });
}

function mapBugReportRow(row: any): BugReport {
  return removeUndefined({
    id: row.id,
    title: row.title,
    description: row.description,
    reproductionSteps: row.reproductionSteps,
    expectedBehavior: row.expectedBehavior,
    actualBehavior: row.actualBehavior,
    severity: row.severity,
    status: row.status,
    reporter: row.reporter,
    requirementId: row.requirementId,
    prdId: row.prdVersionId,
    workItemId: row.workItemId,
    artifactReferences: jsonArray<NonNullable<BugReport["artifactReferences"]>[number]>(row.artifactReferences),
    externalIssueLinks: jsonArray<NonNullable<BugReport["externalIssueLinks"]>[number]>(row.externalIssueLinks),
    externalIssueSyncEvidence: jsonArray<NonNullable<BugReport["externalIssueSyncEvidence"]>[number]>(row.externalIssueSyncEvidence),
    externalBlocker: jsonOptional<BugReport["externalBlocker"]>(row.externalBlocker),
    sourceRunId: row.sourceAgentRunId ?? undefined,
    sourceTestRunId: row.sourceTestRunId ?? undefined,
    sourceFailureType: row.sourceFailureType ?? undefined,
    sourceCommit: row.sourceCommit ?? undefined,
    sourceBranch: row.sourceBranch ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapArtifactRow(row: any): ArtifactRecord {
  return removeUndefined({
    id: row.id,
    kind: row.kind,
    storage: row.storage,
    uri: row.uri,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256,
    metadata: jsonObject<Record<string, string>>(row.metadata),
    requirementId: row.requirementId ?? undefined,
    prdId: row.prdVersionId ?? undefined,
    workItemId: row.workItemId ?? undefined,
    runId: row.agentRunId ?? undefined,
    testRunId: row.testRunId ?? undefined,
    createdAt: iso(row.createdAt)
  });
}

function mapApprovalRow(row: any): ApprovalRecord {
  return removeUndefined({
    id: row.id,
    kind: row.kind,
    status: row.status,
    targetType: row.targetType,
    targetId: row.targetId,
    requestedBy: row.requestedBy,
    requestedReason: row.requestedReason,
    riskLevel: row.riskLevel,
    expiresAt: iso(row.expiresAt),
    approvedBy: row.approvedBy ?? undefined,
    deniedBy: row.deniedBy ?? undefined,
    decisionReason: row.decisionReason ?? undefined,
    decidedAt: optionalIso(row.decidedAt),
    requirementId: row.requirementId ?? undefined,
    prdId: row.prdVersionId ?? undefined,
    workItemId: row.workItemId ?? undefined,
    runId: row.agentRunId ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt)
  });
}

function mapAcceptanceDecisionRow(row: any): AcceptanceDecision {
  return removeUndefined({
    runId: row.runId,
    status: row.status,
    reason: row.reason ?? undefined,
    decidedAt: optionalIso(row.decidedAt)
  });
}

function mapAuditEventRow(row: any): AuditEvent {
  return removeUndefined({
    id: row.id,
    traceId: row.traceId,
    actorType: row.actorType,
    actorId: row.actorId,
    actor: row.actorDisplay ?? row.actorId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    message: row.message,
    beforeJson: jsonNullable(row.beforeJson) as AuditEvent["beforeJson"],
    afterJson: jsonNullable(row.afterJson) as AuditEvent["afterJson"],
    metadataJson: (jsonNullable(row.metadataJson) ?? {}) as AuditEvent["metadataJson"],
    hash: row.hash,
    previousHash: row.previousHash ?? null,
    requirementId: row.requirementId ?? undefined,
    prdId: row.prdVersionId ?? undefined,
    workItemId: row.workItemId ?? undefined,
    runId: row.agentRunId ?? undefined,
    createdAt: iso(row.createdAt)
  });
}

function mapAgentRow(row: any): AgentProfile {
  return removeUndefined({
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    currentWorkItemId: row.currentWorkItemId ?? undefined,
    capabilities: jsonArray(row.capabilities),
    lastSeenAt: iso(row.lastSeenAt)
  });
}

function orderAuditEvents(events: AuditEvent[]): AuditEvent[] {
  if (events.length < 2) return events;
  const byHash = new Map(events.map((event) => [event.hash, event]));
  const referencedHashes = new Set(events.map((event) => event.previousHash).filter((hash): hash is string => Boolean(hash)));
  const head = events.find((event) => !referencedHashes.has(event.hash));
  if (head) {
    const ordered: AuditEvent[] = [];
    let current: AuditEvent | undefined = head;
    while (current && !ordered.some((event) => event.id === current?.id)) {
      ordered.push(current);
      current = current.previousHash ? byHash.get(current.previousHash) : undefined;
    }
    if (ordered.length === events.length) return ordered;
  }
  return [...events].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

function fallbackRequirementId(snapshot: PatchPilotSnapshot) {
  const requirement = snapshot.requirements[0];
  if (!requirement) throw new Error("Cannot persist product state without a requirement row");
  return requirement.id;
}

function optionalReference(value: string | undefined | null, validIds: Set<string>) {
  return value && validIds.has(value) ? value : null;
}

function toDate(value: string | undefined | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function optionalIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return iso(value);
}

function decimalOrNull(value: number | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

function numberFromDb(value: unknown): number {
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  return numberFromDb(value);
}

function jsonArray<T = string>(value: unknown): T[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function jsonObject<T extends Record<string, unknown>>(value: unknown): T {
  const parsed = parseJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T;
}

function jsonOptional<T>(value: unknown): T | undefined {
  return value === null || value === undefined ? undefined : parseJson(value) as T;
}

function jsonNullable(value: unknown) {
  return value === null || value === undefined ? null : parseJson(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
