import { createHash } from "node:crypto";
import type {
  AgentRole,
  AgentRun,
  AuditJsonValue,
  ContractDiffChange,
  ContractDiffSeverity,
  ContractDiffSummary,
  ContractRegistryMetadata,
  ExternalIssueProvider,
  ExternalIssueStatusCategory,
  FailureType,
  InterfaceContract,
  InterfaceContractStatus,
  PatchPilotSnapshot,
  Prd
} from "@patchpilot/domain";
import { z } from "zod";

export const contractVersion = "patchpilot.mvp.v1";

export const approvalKinds = [
  "prd_approval",
  "budget_exceeded",
  "dangerous_operation",
  "breaking_contract",
  "network_allowlist_change",
  "secret_grant",
  "production_data_access"
] as const;

export const approvalTargetTypes = [
  "prd",
  "work_item",
  "agent_run",
  "interface_contract",
  "budget",
  "policy",
  "secret",
  "network",
  "repository"
] as const;

export const approvalRiskLevels = ["low", "medium", "high", "critical"] as const;
export const authUserHeader = "x-patchpilot-user";
export const authRoleHeader = "x-patchpilot-role";
export const authRoles = ["submitter", "maintainer", "reviewer", "admin"] as const;
export const failureTypes = [
  "transient",
  "deterministic",
  "test_failed",
  "policy_denied",
  "budget_exhausted",
  "environment_failed"
] as const satisfies readonly FailureType[];
export const bugStatuses = [
  "reported",
  "needs_repro",
  "reproduced",
  "unreproducible",
  "fixing",
  "verifying",
  "closed"
] as const;
export const intakeArtifactKinds = ["file", "screenshot", "recording", "link"] as const;
export const externalIssueProviders = ["linear", "jira"] as const satisfies readonly ExternalIssueProvider[];
export const externalIssueStatusCategories = [
  "todo",
  "ready",
  "in_progress",
  "blocked",
  "done",
  "cancelled"
] as const satisfies readonly ExternalIssueStatusCategory[];

export const intakeArtifactReferenceSchema = z.object({
  id: z.string().trim().min(1).optional(),
  kind: z.enum(intakeArtifactKinds),
  label: z.string().trim().min(1).max(160),
  uri: z.string().trim().min(1).max(2000).optional(),
  contentType: z.string().trim().min(1).max(160).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  artifactId: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  createdAt: z.string().datetime().optional()
}).superRefine((reference, ctx) => {
  if (reference.kind !== "link") return;
  if (!reference.uri) {
    ctx.addIssue({
      code: "custom",
      message: "Link references require a URL",
      path: ["uri"]
    });
    return;
  }
  try {
    new URL(reference.uri);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Link references require a valid URL",
      path: ["uri"]
    });
  }
});

export const requirementInputSchema = z.object({
  rawInput: z.string().trim().min(3),
  template: z.enum(["feature", "bug", "ui", "document"]),
  artifactReferences: z.array(intakeArtifactReferenceSchema).max(12).default([])
});

export const clarificationSchema = z.object({
  answers: z.record(z.string(), z.string()).default({})
});

export const clarificationTurnSchema = z.object({
  message: z.string().trim().min(1)
});

export const acceptanceSchema = z.object({
  status: z.enum(["accepted", "rejected"]),
  reason: z.string().optional()
}).superRefine((input, ctx) => {
  if (input.status === "rejected" && !input.reason?.trim()) {
    ctx.addIssue({
      code: "custom",
      message: "Reason is required when rejecting a run",
      path: ["reason"]
    });
  }
});

export const bugInputSchema = z.object({
  title: z.string().trim().min(3),
  description: z.string().trim().min(3),
  reproductionSteps: z.string().trim().min(3),
  expectedBehavior: z.string().trim().min(3),
  actualBehavior: z.string().trim().min(3),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  reporter: z.string().trim().optional(),
  artifactReferences: z.array(intakeArtifactReferenceSchema).max(12).default([])
});

export const claimSchema = z.object({
  agentId: z.string().trim().min(1),
  leaseDurationMs: z.number().int().positive().max(60 * 60 * 1000).optional()
});

export const startRunSchema = z.object({
  runner: z.enum(["simulated", "codex"]).optional(),
  claimToken: z.string().trim().min(1).optional()
}).default({});

export const releaseWorkItemSchema = z.object({
  claimToken: z.string().trim().min(1).optional()
}).default({});

export const externalIssueLinkSchema = z.object({
  provider: z.enum(externalIssueProviders),
  entityType: z.enum(["work_item", "defect"]),
  entityId: z.string().trim().min(1),
  externalIssueId: z.string().trim().min(1).optional(),
  externalKey: z.string().trim().min(1).optional(),
  externalUrl: z.string().trim().url().optional(),
  statusName: z.string().trim().min(1).default("Todo"),
  statusCategory: z.enum(externalIssueStatusCategories).optional(),
  summary: z.string().trim().min(1).max(500).optional()
}).superRefine((input, ctx) => {
  if (input.externalIssueId || input.externalKey) return;
  ctx.addIssue({
    code: "custom",
    message: "externalIssueId or externalKey is required",
    path: ["externalIssueId"]
  });
});

export const externalIssueStatusUpdateSchema = z.object({
  provider: z.enum(externalIssueProviders),
  externalIssueId: z.string().trim().min(1).optional(),
  externalKey: z.string().trim().min(1).optional(),
  statusName: z.string().trim().min(1),
  statusCategory: z.enum(externalIssueStatusCategories).optional(),
  actor: z.string().trim().min(1).optional(),
  observedAt: z.string().datetime().optional(),
  idempotencyKey: z.string().trim().min(1).optional()
}).superRefine((input, ctx) => {
  if (input.externalIssueId || input.externalKey) return;
  ctx.addIssue({
    code: "custom",
    message: "externalIssueId or externalKey is required",
    path: ["externalIssueId"]
  });
});

export const createApprovalSchema = z.object({
  kind: z.enum(approvalKinds),
  targetType: z.enum(approvalTargetTypes),
  targetId: z.string().trim().min(1),
  requestedBy: z.string().trim().min(1),
  requestedReason: z.string().trim().min(1),
  riskLevel: z.enum(approvalRiskLevels),
  expiresAt: z.string().datetime(),
  requirementId: z.string().trim().min(1).optional(),
  prdId: z.string().trim().min(1).optional(),
  workItemId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional()
});

export const approvalDecisionSchema = z.object({
  decidedBy: z.string().trim().min(1),
  decisionReason: z.string().trim().min(1)
});

export const httpApiContract = {
  artifactId: "control-api",
  kind: "http",
  version: 1,
  name: "交付控制 HTTP API",
  summary: "前端、worker、CLI 和测试 agent 通过这些接口提交需求、启动团队任务、读取运行状态和提交验收。",
  providerRole: "backend",
  consumerRoles: ["frontend", "test", "ops"] as const,
  operations: {
    health: {
      method: "GET",
      path: "/health",
      response: "HealthResponse"
    },
    metrics: {
      method: "GET",
      path: "/metrics",
      response: "text/plain; version=0.0.4"
    },
    getConfig: {
      method: "GET",
      path: "/api/config",
      response: "RuntimeConfig"
    },
    snapshot: {
      method: "GET",
      path: "/api/snapshot",
      response: "PatchPilotSnapshot"
    },
    verifyAudit: {
      method: "GET",
      path: "/api/audit/verify",
      response: "AuditChainVerification"
    },
    exportPrdAuditPackage: {
      method: "GET",
      path: "/api/prds/:id/audit-export",
      response: "AuditExportPackage"
    },
    agents: {
      method: "GET",
      path: "/api/agents",
      response: "AgentProfile[]"
    },
    createRequirement: {
      method: "POST",
      path: "/api/requirements",
      request: "CreateRequirementRequest",
      response: "Requirement"
    },
    getRequirement: {
      method: "GET",
      path: "/api/requirements/:id",
      response: "RequirementBundle"
    },
    answerClarification: {
      method: "POST",
      path: "/api/requirements/:id/clarification-answer",
      request: "ClarificationAnswerRequest",
      response: "RequirementPrdBundle"
    },
    addClarificationTurn: {
      method: "POST",
      path: "/api/requirements/:id/clarification-turn",
      request: "ClarificationTurnRequest",
      response: "ClarificationTurnResponse"
    },
    createPrd: {
      method: "POST",
      path: "/api/requirements/:id/prd",
      response: "RequirementPrdBundle"
    },
    approvePrd: {
      method: "POST",
      path: "/api/prds/:id/approve",
      response: "ApprovePrdResponse"
    },
    startTeam: {
      method: "POST",
      path: "/api/prds/:id/start-team",
      request: "StartRunRequest",
      response: "StartTeamResponse"
    },
    acceptTeam: {
      method: "POST",
      path: "/api/prds/:id/acceptance",
      request: "AcceptanceRequest",
      response: "TeamAcceptanceResponse"
    },
    createApproval: {
      method: "POST",
      path: "/api/approvals",
      request: "CreateApprovalRequest",
      response: "ApprovalRecord"
    },
    approveApproval: {
      method: "POST",
      path: "/api/approvals/:id/approve",
      request: "ApprovalDecisionRequest",
      response: "ApprovalRecord"
    },
    denyApproval: {
      method: "POST",
      path: "/api/approvals/:id/deny",
      request: "ApprovalDecisionRequest",
      response: "ApprovalRecord"
    },
    startWorkItem: {
      method: "POST",
      path: "/api/work-items/:id/start",
      request: "StartRunRequest",
      response: "AgentRun"
    },
    claimWorkItem: {
      method: "POST",
      path: "/api/work-items/:id/claim",
      request: "ClaimWorkItemRequest",
      response: "ClaimWorkItemResponse"
    },
    releaseWorkItem: {
      method: "POST",
      path: "/api/work-items/:id/release",
      request: "ReleaseWorkItemRequest",
      response: "ReleaseWorkItemResponse"
    },
    createBug: {
      method: "POST",
      path: "/api/bugs",
      request: "CreateBugRequest",
      response: "CreateBugResponse"
    },
    linkExternalIssue: {
      method: "POST",
      path: "/api/integrations/issues/link",
      request: "ExternalIssueLinkRequest",
      response: "ExternalIssueSyncResponse"
    },
    updateExternalIssueStatus: {
      method: "POST",
      path: "/api/integrations/issues/status",
      request: "ExternalIssueStatusUpdateRequest",
      response: "ExternalIssueSyncResponse"
    },
    getRun: {
      method: "GET",
      path: "/api/runs/:id",
      response: "AgentRun"
    },
    streamRunEvents: {
      method: "GET",
      path: "/api/runs/:id/events",
      response: "text/event-stream<AgentRun>"
    },
    acceptRun: {
      method: "POST",
      path: "/api/acceptance/:runId",
      request: "AcceptanceRequest",
      response: "AcceptanceDecision"
    }
  }
} as const;

export const runEventStreamContract = {
  artifactId: "run-events",
  kind: "event",
  version: 1,
  name: "AgentRun 事件流",
  summary: "运行页和测试 agent 依赖事件流判断理解、计划、开发、测试、审查和等待验收阶段。",
  providerRole: "backend",
  consumerRoles: ["frontend", "test", "reviewer"] as const,
  stream: {
    operationId: "streamRunEvents",
    envelope: "data",
    payload: "AgentRun",
    requiredFields: [
      "id",
      "requirementId",
      "prdId",
      "workItemId",
      "runner",
      "status",
      "currentStep",
      "timeline",
      "events",
      "costEstimateUsd",
      "startedAt"
    ] as const,
    optionalFields: [
      "result",
      "failureType",
      "failureSummary",
      "budgetUsd",
      "budgetSoftThresholdUsd",
      "budgetApprovalId",
      "costActualUsd",
      "endedAt"
    ] as const,
    terminalStatuses: ["succeeded", "failed", "cancelled"] satisfies AgentRun["status"][],
    compatibilityRules: [
      "Consumers must ignore unknown AgentRun fields.",
      "Consumers must fall back to snapshot polling if SSE disconnects.",
      "Providers close the stream after a terminal run status is sent."
    ] as const
  }
} as const;

export const sharedStateContract = {
  artifactId: "delivery-state",
  kind: "schema",
  version: 1,
  name: "交付状态共享 Schema",
  summary: "前端、后端、worker、CLI 和测试共享 PatchPilot delivery state 结构。",
  providerRole: "backend",
  consumerRoles: ["frontend", "test", "ops", "reviewer"] as const,
  rootSchema: "PatchPilotSnapshot",
  schemas: [
    "Requirement",
    "Prd",
    "WorkItem",
    "InterfaceContract",
    "ContractRegistryMetadata",
    "ContractDiffSummary",
    "ContractDiffChange",
    "AgentRun",
    "WorkspaceRun",
    "TestCase",
    "TestRun",
    "IntakeArtifactReference",
    "ArtifactRecord",
    "ExternalIssueLink",
    "ExternalIssueBlocker",
    "ExternalIssueSyncEvidence",
    "PullRequestRecord",
    "ReviewRecord",
    "ApprovalRecord",
    "AuditEvent",
    "BugReport",
    "AcceptanceDecision"
  ] as const
} as const;

export const contractArtifacts = [httpApiContract, runEventStreamContract, sharedStateContract] as const;

export type ContractArtifact = (typeof contractArtifacts)[number];
export type ContractArtifactKind = ContractArtifact["kind"];
export type ApiOperationId = keyof typeof httpApiContract.operations;
export type ApiMethod = (typeof httpApiContract.operations)[ApiOperationId]["method"];
export type ApiRoute = (typeof httpApiContract.operations)[ApiOperationId]["path"];
export type RunEventTerminalStatus = (typeof runEventStreamContract.stream.terminalStatuses)[number];
export type SharedStateSchemaName = typeof sharedStateContract.rootSchema | (typeof sharedStateContract.schemas)[number];
export type SharedStateSnapshot = Pick<PatchPilotSnapshot, keyof PatchPilotSnapshot>;
type OpenApiSchema = Record<string, unknown>;

export type ContractNormalizedContent = Record<string, AuditJsonValue | undefined>;

export interface ContractRegistryArtifact {
  artifactId: string;
  kind: ContractArtifactKind;
  version: number;
  name: string;
  summary: string;
  providerRole: AgentRole;
  consumerRoles: AgentRole[];
  generatorVersion: string;
  sourceRef: string;
  normalizedContent: ContractNormalizedContent;
  contentHash: string;
  specMarkdown: string;
  testSuggestions: string[];
}

export type ContractTestRequirementKind = "registry_diff" | "provider_validation" | "consumer_compatibility";

export interface ContractTestRequirement {
  id: string;
  artifactId: string;
  kind: ContractArtifactKind;
  requirementKind: ContractTestRequirementKind;
  participantRole: AgentRole;
  participantLabel: string;
  command: string;
  runner: "patchpilot-contract-registry" | "patchpilot-contract-tests";
  title: string;
  summary: string;
  steps: string[];
  expectedResult: string;
}

export interface ContractRegistryDiffInput {
  baseline?: ContractRegistryMetadata;
  proposed: ContractRegistryArtifact;
  proposedRevisionId: string;
  revision: number;
  now?: string;
}

export function buildContractTestRequirements(artifact: ContractRegistryArtifact): ContractTestRequirement[] {
  return [
    registryDiffRequirement(artifact),
    providerValidationRequirement(artifact),
    ...consumerCompatibilityRequirements(artifact)
  ];
}

export function apiRoute(operationId: ApiOperationId): ApiRoute {
  return httpApiContract.operations[operationId].path;
}

export function apiPath(operationId: ApiOperationId, params: Record<string, string> = {}): string {
  return apiRoute(operationId).replace(/:([A-Za-z][A-Za-z0-9_]*)/g, (_match, key: string) => {
    const value = params[key];
    if (!value) throw new Error(`Missing API path parameter "${key}" for ${operationId}`);
    return encodeURIComponent(value);
  });
}

export function buildOpenApiDocument() {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [operationId, operation] of Object.entries(httpApiContract.operations)) {
    const method = operation.method.toLowerCase();
    const pathItem = (paths[operation.path] ??= {});
    pathItem[method] = {
      operationId,
      tags: [
        operation.path.startsWith("/api/integrations")
          ? "Integrations"
          : operation.path.startsWith("/api/bugs")
            ? "Bugs"
            : operation.path.startsWith("/api/work-items")
              ? "Work Items"
              : "Control Plane"
      ],
      summary: `${operation.method} ${operation.path}`,
      ...(requiresAuth(operationId as ApiOperationId) ? { security: [{ PatchPilotUser: [], PatchPilotRole: [] }] } : {}),
      ...(hasRequestSchema(operation) ? {
        requestBody: {
          required: isRequestBodyRequired(operationId as ApiOperationId),
          content: {
            "application/json": {
              schema: schemaRef(operation.request)
            }
          }
        }
      } : {}),
      responses: {
        [responseStatusFor(operationId as ApiOperationId)]: responseFor(operation.response),
        ...(requiresAuth(operationId as ApiOperationId) ? authErrorResponses() : {})
      }
    };
  }

  return {
    openapi: "3.1.0",
    info: {
      title: "PatchPilot Control Plane API",
      version: contractVersion,
      description: "Generated from @patchpilot/contracts artifacts used by API, Web, and Worker packages."
    },
    paths,
    components: {
      securitySchemes: {
        PatchPilotUser: {
          type: "apiKey",
          in: "header",
          name: authUserHeader,
          description: "PatchPilot authenticated actor id for protected control-plane actions."
        },
        PatchPilotRole: {
          type: "apiKey",
          in: "header",
          name: authRoleHeader,
          description: `PatchPilot actor role. Allowed values: ${authRoles.join(", ")}.`
        }
      },
      schemas: openApiSchemas
    }
  };
}

export function buildRunEventSchemaDocument() {
  return {
    schemaVersion: contractVersion,
    kind: "patchpilot.sse.v1",
    id: "run-events",
    channel: apiRoute(runEventStreamContract.stream.operationId),
    mediaType: "text/event-stream",
    producer: runEventStreamContract.providerRole,
    consumers: [...runEventStreamContract.consumerRoles],
    envelope: {
      message: {
        event: "message",
        frame: "data: <AgentRun JSON>\\n\\n",
        payloadSchema: "AgentRun",
        requiredFields: [...runEventStreamContract.stream.requiredFields],
        optionalFields: [...runEventStreamContract.stream.optionalFields]
      },
      error: {
        event: "error",
        frame: "event: error\\ndata: <RunEventError JSON>\\n\\n",
        payloadSchema: "RunEventError"
      }
    },
    terminalStatuses: [...runEventStreamContract.stream.terminalStatuses],
    closePolicy: "Provider closes the SSE response after sending an AgentRun whose status is succeeded, failed, or cancelled.",
    compatibilityRules: [...runEventStreamContract.stream.compatibilityRules],
    components: {
      schemas: openApiSchemas
    }
  };
}

export function buildSharedStateSchemaDocument() {
  const schemaNames = uniqueStrings([sharedStateContract.rootSchema, ...sharedStateContract.schemas]);
  const schemas = Object.fromEntries(
    schemaNames.map((schemaName) => [schemaName, openApiSchemas[schemaName as keyof typeof openApiSchemas]])
      .filter(([, schema]) => schema !== undefined)
  );

  return {
    schemaVersion: contractVersion,
    kind: "patchpilot.shared-state.v1",
    id: sharedStateContract.artifactId,
    rootSchema: sharedStateContract.rootSchema,
    provider: sharedStateContract.providerRole,
    consumers: [...sharedStateContract.consumerRoles],
    schemas: schemaNames,
    components: {
      schemas
    },
    compatibilityRules: [
      "Consumers must ignore unknown optional object fields.",
      "Consumers must tolerate additive fields when their code path has an explicit fallback.",
      "Removing schema fields or enum members requires breaking-contract approval."
    ]
  };
}

export function buildContractRegistryArtifacts(): ContractRegistryArtifact[] {
  return contractArtifacts.map((artifact) => {
    const normalizedContent = normalizeContractArtifact(artifact);
    return {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      version: artifact.version,
      name: artifact.name,
      summary: artifact.summary,
      providerRole: artifact.providerRole as AgentRole,
      consumerRoles: [...artifact.consumerRoles] as AgentRole[],
      generatorVersion: contractVersion,
      sourceRef: sourceRefFor(artifact),
      normalizedContent,
      contentHash: hashNormalizedContent(normalizedContent),
      specMarkdown: renderContractMarkdown(artifact),
      testSuggestions: testSuggestionsFor(artifact.kind)
    };
  });
}

export function normalizeContractArtifact(artifact: ContractArtifact): ContractNormalizedContent {
  switch (artifact.kind) {
    case "http":
      return buildOpenApiDocument() as ContractNormalizedContent;
    case "event":
      return buildRunEventSchemaDocument() as ContractNormalizedContent;
    case "schema":
      return buildSharedStateSchemaDocument() as ContractNormalizedContent;
  }
}

export function hashNormalizedContent(content: unknown): string {
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

export function createContractRegistryMetadata(input: ContractRegistryDiffInput): ContractRegistryMetadata {
  const now = input.now ?? new Date().toISOString();
  const diff = diffContractRegistryArtifacts({
    baseline: input.baseline,
    proposed: input.proposed,
    proposedRevisionId: input.proposedRevisionId,
    now
  });
  const status: InterfaceContractStatus = diff.hasBreakingChanges ? "breaking_change_pending" : "approved";
  return {
    artifactId: input.proposed.artifactId,
    generatorVersion: input.proposed.generatorVersion,
    revisionId: input.proposedRevisionId,
    revision: input.revision,
    contentHash: input.proposed.contentHash,
    sourceRef: input.proposed.sourceRef,
    providerRole: input.proposed.providerRole,
    consumerRoles: input.proposed.consumerRoles,
    status,
    normalizedContent: input.proposed.normalizedContent,
    ...(input.baseline ? {
      baselineRevisionId: input.baseline.revisionId,
      approvedRevisionId: input.baseline.approvedRevisionId ?? input.baseline.revisionId
    } : {
      approvedRevisionId: input.proposedRevisionId,
      approvedAt: now
    }),
    diff,
    testRunIds: []
  };
}

export function diffContractRegistryArtifacts(input: {
  baseline?: ContractRegistryMetadata;
  proposed: ContractRegistryArtifact;
  proposedRevisionId: string;
  now?: string;
}): ContractDiffSummary {
  const now = input.now ?? new Date().toISOString();
  const changes = input.baseline
    ? diffNormalizedContent(input.baseline, input.proposed)
    : [
        makeChange(
          "compatible",
          "contract",
          "contract.registered",
          `Registered initial ${input.proposed.kind} contract baseline for ${input.proposed.artifactId}.`,
          input.proposed.providerRole,
          input.proposed.consumerRoles
        )
      ];
  const status = summarizeDiffStatus(changes);
  const impactedConsumerRoles = uniqueRoles(
    changes.flatMap((change) => change.consumerRoles.length > 0 ? change.consumerRoles : input.proposed.consumerRoles)
  );
  return {
    id: `diff_${input.proposed.artifactId}_${shortHash([
      input.baseline?.contentHash ?? "none",
      input.proposed.contentHash,
      input.proposedRevisionId
    ].join(":"))}`,
    status,
    hasBreakingChanges: status === "breaking",
    hasWarnings: changes.some((change) => change.severity === "warning"),
    ...(input.baseline ? {
      baselineRevisionId: input.baseline.revisionId,
      baselineContentHash: input.baseline.contentHash
    } : {}),
    proposedRevisionId: input.proposedRevisionId,
    proposedContentHash: input.proposed.contentHash,
    impactedProviderRole: input.proposed.providerRole,
    impactedConsumerRoles,
    changes,
    createdAt: now
  };
}

export function createInterfaceContracts(
  prd: Prd,
  status: InterfaceContractStatus = "approved",
  now = new Date().toISOString()
): InterfaceContract[] {
  return buildContractRegistryArtifacts().map((artifact) => ({
      id: `ic_${prd.requirementId}_${artifact.artifactId}`,
      prdId: prd.id,
      name: artifact.name,
      kind: artifact.kind,
      status,
      version: artifact.version,
      summary: artifact.summary,
      providerRole: artifact.providerRole,
      consumerRoles: artifact.consumerRoles,
      specMarkdown: artifact.specMarkdown,
      testSuggestions: artifact.testSuggestions,
      registry: {
        artifactId: artifact.artifactId,
        generatorVersion: artifact.generatorVersion,
        revisionId: `cr_${prd.requirementId}_${artifact.artifactId}_r${artifact.version}`,
        revision: artifact.version,
        contentHash: artifact.contentHash,
        sourceRef: artifact.sourceRef,
        providerRole: artifact.providerRole,
        consumerRoles: artifact.consumerRoles,
        status,
        normalizedContent: artifact.normalizedContent,
        ...(status === "approved" ? {
          approvedRevisionId: `cr_${prd.requirementId}_${artifact.artifactId}_r${artifact.version}`,
          approvedAt: now
        } : {}),
        testRunIds: []
      },
      createdAt: now,
      updatedAt: now
    }));
}

export function renderContractMarkdown(artifact: ContractArtifact): string {
  switch (artifact.kind) {
    case "http":
      return [
        "## HTTP Contract",
        `- Artifact: \`${artifact.artifactId}\``,
        `- Contract version: \`${contractVersion}\``,
        `- Artifact version: ${artifact.version}`,
        ...Object.entries(artifact.operations).map(([operationId, operation]) => {
          const request = "request" in operation ? ` request=${operation.request}` : "";
          return `- \`${operation.method} ${operation.path}\` (${operationId}) -> ${operation.response}${request}`;
        })
      ].join("\n");
    case "event":
      return [
        "## Event Contract",
        `- Artifact: \`${artifact.artifactId}\``,
        `- Contract version: \`${contractVersion}\``,
        `- Artifact version: ${artifact.version}`,
        `- Stream: \`${apiRoute(artifact.stream.operationId)}\``,
        `- Envelope: \`${artifact.stream.envelope}: ${artifact.stream.payload}\``,
        `- Required fields: ${artifact.stream.requiredFields.map((field) => `\`${field}\``).join(", ")}`,
        `- Optional fields: ${artifact.stream.optionalFields.map((field) => `\`${field}\``).join(", ")}`,
        `- Terminal statuses: ${artifact.stream.terminalStatuses.map((status) => `\`${status}\``).join(", ")}`,
        ...artifact.stream.compatibilityRules.map((rule) => `- ${rule}`)
      ].join("\n");
    case "schema":
      return [
        "## Schema Contract",
        `- Artifact: \`${artifact.artifactId}\``,
        `- Contract version: \`${contractVersion}\``,
        `- Artifact version: ${artifact.version}`,
        `- Root schema: \`${artifact.rootSchema}\``,
        ...artifact.schemas.map((schema) => `- \`${schema}\``)
      ].join("\n");
  }
}

function testSuggestionsFor(kind: ContractArtifactKind): string[] {
  if (kind === "http") {
    return ["API lifecycle tests cover all public endpoints", "Web and CLI smoke tests use contract API paths", "Worker e2e verifies claim/start protocol"];
  }
  if (kind === "event") {
    return ["SSE first packet contains the current AgentRun", "Terminal statuses close the stream", "Consumers fall back to snapshot polling"];
  }
  return ["Domain type tests cover snapshot schema", "Store migration normalizes missing arrays", "Professional UI displays contract summaries"];
}

function registryDiffRequirement(artifact: ContractRegistryArtifact): ContractTestRequirement {
  return {
    id: `${artifact.artifactId}:registry-diff`,
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    requirementKind: "registry_diff",
    participantRole: artifact.providerRole,
    participantLabel: "contract registry",
    command: `patchpilot contract-registry diff --artifact ${artifact.artifactId}`,
    runner: "patchpilot-contract-registry",
    title: `${artifact.name} registry diff`,
    summary: `Diff ${artifact.artifactId} against the latest approved contract baseline.`,
    steps: [
      "Load the latest approved registry baseline for this artifact.",
      "Diff the proposed normalized artifact against the baseline.",
      "Classify compatible, warning, and breaking changes with impacted consumers."
    ],
    expectedResult: "The registry diff is recorded and any breaking change is blocked until approval."
  };
}

function providerValidationRequirement(artifact: ContractRegistryArtifact): ContractTestRequirement {
  const commandByKind: Record<ContractArtifactKind, string> = {
    http: "pnpm openapi:check && pnpm --filter @patchpilot/api test -- server.test.ts",
    event: "pnpm events:check && pnpm --filter @patchpilot/api test -- server.test.ts",
    schema: "pnpm --filter @patchpilot/contracts test -- contracts.test.ts events.test.ts openapi.test.ts"
  };
  return {
    id: `${artifact.artifactId}:provider:${artifact.providerRole}`,
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    requirementKind: "provider_validation",
    participantRole: artifact.providerRole,
    participantLabel: `${artifact.providerRole} provider`,
    command: commandByKind[artifact.kind],
    runner: "patchpilot-contract-tests",
    title: `${artifact.name} provider validation`,
    summary: `Validate the ${artifact.providerRole} provider publishes the generated ${artifact.kind} contract artifact.`,
    steps: providerValidationSteps(artifact.kind),
    expectedResult: "Generated provider artifacts are current and provider behavior matches the registered contract."
  };
}

function consumerCompatibilityRequirements(artifact: ContractRegistryArtifact): ContractTestRequirement[] {
  return artifact.consumerRoles.map((role) => {
    const participantLabel = consumerParticipantLabel(artifact.kind, role);
    return {
      id: `${artifact.artifactId}:consumer:${participantLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      requirementKind: "consumer_compatibility",
      participantRole: role,
      participantLabel,
      command: consumerCommand(artifact.kind, role),
      runner: "patchpilot-contract-tests",
      title: `${artifact.name} ${participantLabel} compatibility`,
      summary: `Verify the ${participantLabel} code path remains compatible with ${artifact.artifactId}.`,
      steps: consumerCompatibilitySteps(artifact.kind, participantLabel),
      expectedResult: `${participantLabel} handles the proposed contract revision without missing fields, routes, events, or state fallbacks.`
    };
  });
}

function providerValidationSteps(kind: ContractArtifactKind) {
  if (kind === "http") {
    return [
      "Regenerate and compare the OpenAPI artifact.",
      "Run API route tests for public request and response shapes.",
      "Confirm generated routes stay aligned with Fastify handlers."
    ];
  }
  if (kind === "event") {
    return [
      "Regenerate and compare the event schema artifact.",
      "Run SSE tests for first payload, terminal payload, and stream close behavior.",
      "Confirm event payload fields match the registered AgentRun schema."
    ];
  }
  return [
    "Validate the shared-state schema generated from domain types.",
    "Check registry metadata, diff summaries, TestCase, and TestRun schemas.",
    "Confirm schema artifacts remain reproducible from @patchpilot/contracts."
  ];
}

function consumerCompatibilitySteps(kind: ContractArtifactKind, participantLabel: string) {
  if (kind === "http") {
    return [
      `Run ${participantLabel} checks that build URLs through apiPath.`,
      "Verify required request payloads and response fields are still tolerated.",
      "Confirm unknown compatible additions do not break the consumer path."
    ];
  }
  if (kind === "event") {
    return [
      `Run ${participantLabel} checks for AgentRun SSE payload handling.`,
      "Verify terminal statuses and disconnect fallback behavior.",
      "Confirm unknown optional event fields are ignored."
    ];
  }
  return [
    `Run ${participantLabel} checks against PatchPilotSnapshot and related state types.`,
    "Verify optional fields, enum additions, and registry metadata are tolerated.",
    "Confirm state consumers continue to render, dispatch, or report from shared schema data."
  ];
}

function consumerParticipantLabel(kind: ContractArtifactKind, role: AgentRole) {
  if (role === "ops" && (kind === "http" || kind === "schema")) return "worker consumer";
  if (role === "frontend") return "frontend consumer";
  if (role === "test") return "test agent consumer";
  if (role === "reviewer") return "reviewer consumer";
  return `${role} consumer`;
}

function consumerCommand(kind: ContractArtifactKind, role: AgentRole) {
  if (role === "frontend") {
    return kind === "event"
      ? "pnpm --filter @patchpilot/web typecheck"
      : "pnpm --filter @patchpilot/web test";
  }
  if (role === "ops") {
    return kind === "http" || kind === "schema"
      ? "pnpm --filter @patchpilot/worker test"
      : "pnpm --filter @patchpilot/worker typecheck";
  }
  if (role === "reviewer") return "pnpm --filter @patchpilot/contracts test -- contracts.test.ts";
  if (role === "test") return kind === "http" || kind === "event"
    ? "pnpm --filter @patchpilot/api test -- server.test.ts"
    : "pnpm test";
  return `pnpm --filter @patchpilot/${role} test`;
}

function sourceRefFor(artifact: ContractArtifact) {
  if (artifact.kind === "http") return "packages/contracts/openapi/patchpilot.openapi.json";
  if (artifact.kind === "event") return "packages/contracts/events/run-events.schema.json";
  return "packages/contracts/src/index.ts#sharedStateContract";
}

function diffNormalizedContent(
  baseline: ContractRegistryMetadata,
  proposed: ContractRegistryArtifact
): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  if (baseline.artifactId !== proposed.artifactId || baseline.providerRole !== proposed.providerRole) {
    changes.push(
      makeChange(
        "breaking",
        "contract.identity",
        "contract.identity_changed",
        `Contract identity changed from ${baseline.artifactId}/${baseline.providerRole} to ${proposed.artifactId}/${proposed.providerRole}.`,
        proposed.providerRole,
        uniqueRoles([...baseline.consumerRoles, ...proposed.consumerRoles])
      )
    );
    return changes;
  }

  const removedConsumers = baseline.consumerRoles.filter((role) => !proposed.consumerRoles.includes(role));
  const addedConsumers = proposed.consumerRoles.filter((role) => !baseline.consumerRoles.includes(role));
  if (removedConsumers.length > 0) {
    changes.push(
      makeChange(
        "warning",
        "contract.consumers",
        "contract.consumers_removed",
        `Consumer mapping removed roles: ${removedConsumers.join(", ")}.`,
        proposed.providerRole,
        removedConsumers
      )
    );
  }
  if (addedConsumers.length > 0) {
    changes.push(
      makeChange(
        "compatible",
        "contract.consumers",
        "contract.consumers_added",
        `Consumer mapping added roles: ${addedConsumers.join(", ")}.`,
        proposed.providerRole,
        addedConsumers
      )
    );
  }

  if (baseline.contentHash === proposed.contentHash && changes.length === 0) {
    return [
      makeChange(
        "compatible",
        "contract",
        "contract.unchanged",
        `No normalized ${proposed.kind} contract changes detected for ${proposed.artifactId}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    ];
  }

  if (proposed.kind === "http") {
    changes.push(...diffHttpContract(baseline.normalizedContent, proposed));
  } else if (proposed.kind === "event") {
    changes.push(...diffEventContract(baseline.normalizedContent, proposed));
  } else {
    changes.push(...diffSharedSchemaContract(baseline.normalizedContent, proposed));
  }

  if (changes.length === 0) {
    changes.push(
      makeChange(
        "compatible",
        "contract.contentHash",
        "contract.normalized_change",
        `Normalized ${proposed.kind} content changed without a known breaking rule match.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  return changes;
}

function diffHttpContract(baselineContent: unknown, proposed: ContractRegistryArtifact): ContractDiffChange[] {
  const baselinePaths = objectRecord(readPath(baselineContent, ["paths"]));
  const proposedPaths = objectRecord(readPath(proposed.normalizedContent, ["paths"]));
  const baselineOperations = flattenOpenApiOperations(baselinePaths);
  const proposedOperations = flattenOpenApiOperations(proposedPaths);
  const changes: ContractDiffChange[] = [];

  for (const [key, baselineOperation] of baselineOperations) {
    const proposedOperation = proposedOperations.get(key);
    if (!proposedOperation) {
      changes.push(
        makeChange(
          "breaking",
          `paths.${baselineOperation.path}.${baselineOperation.method}`,
          "http.operation_removed",
          `Removed ${baselineOperation.method.toUpperCase()} ${baselineOperation.path}.`,
          proposed.providerRole,
          proposed.consumerRoles
        )
      );
      continue;
    }
    const baselineOperationId = readString(baselineOperation.operation, ["operationId"]);
    const proposedOperationId = readString(proposedOperation.operation, ["operationId"]);
    if (baselineOperationId && proposedOperationId && baselineOperationId !== proposedOperationId) {
      changes.push(
        makeChange(
          "breaking",
          `paths.${baselineOperation.path}.${baselineOperation.method}.operationId`,
          "http.operation_id_changed",
          `Changed operationId for ${baselineOperation.method.toUpperCase()} ${baselineOperation.path} from ${baselineOperationId} to ${proposedOperationId}.`,
          proposed.providerRole,
          proposed.consumerRoles
        )
      );
    }
    changes.push(
      ...diffResponseStatuses(baselineOperation.operation, proposedOperation.operation, proposed, baselineOperation)
    );
  }

  for (const [key, proposedOperation] of proposedOperations) {
    if (baselineOperations.has(key)) continue;
    changes.push(
      makeChange(
        "compatible",
        `paths.${proposedOperation.path}.${proposedOperation.method}`,
        "http.operation_added",
        `Added ${proposedOperation.method.toUpperCase()} ${proposedOperation.path}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }

  changes.push(
    ...diffSchemaComponents(
      objectRecord(readPath(baselineContent, ["components", "schemas"])),
      objectRecord(readPath(proposed.normalizedContent, ["components", "schemas"])),
      proposed,
      "components.schemas"
    )
  );
  return changes;
}

function diffResponseStatuses(
  baselineOperation: Record<string, unknown>,
  proposedOperation: Record<string, unknown>,
  proposed: ContractRegistryArtifact,
  operation: { method: string; path: string }
) {
  const changes: ContractDiffChange[] = [];
  const baselineResponses = objectRecord(readPath(baselineOperation, ["responses"]));
  const proposedResponses = objectRecord(readPath(proposedOperation, ["responses"]));
  for (const statusCode of Object.keys(baselineResponses)) {
    if (statusCode in proposedResponses) continue;
    changes.push(
      makeChange(
        "breaking",
        `paths.${operation.path}.${operation.method}.responses.${statusCode}`,
        "http.response_status_removed",
        `Removed ${statusCode} response from ${operation.method.toUpperCase()} ${operation.path}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const statusCode of Object.keys(proposedResponses)) {
    if (statusCode in baselineResponses) continue;
    changes.push(
      makeChange(
        "compatible",
        `paths.${operation.path}.${operation.method}.responses.${statusCode}`,
        "http.response_status_added",
        `Added ${statusCode} response to ${operation.method.toUpperCase()} ${operation.path}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  return changes;
}

function flattenOpenApiOperations(paths: Record<string, unknown>) {
  const operations = new Map<string, { path: string; method: string; operation: Record<string, unknown> }>();
  for (const [path, pathItem] of Object.entries(paths)) {
    const methods = objectRecord(pathItem);
    for (const [method, operation] of Object.entries(methods)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
      operations.set(`${method.toUpperCase()} ${path}`, {
        path,
        method,
        operation: objectRecord(operation)
      });
    }
  }
  return operations;
}

function diffEventContract(baselineContent: unknown, proposed: ContractRegistryArtifact): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  const baselineRequired = readStringArray(baselineContent, ["envelope", "message", "requiredFields"]);
  const proposedRequired = readStringArray(proposed.normalizedContent, ["envelope", "message", "requiredFields"]);
  const baselineOptional = readStringArray(baselineContent, ["envelope", "message", "optionalFields"]);
  const proposedOptional = readStringArray(proposed.normalizedContent, ["envelope", "message", "optionalFields"]);
  const baselineTerminalStatuses = readStringArray(baselineContent, ["terminalStatuses"]);
  const proposedTerminalStatuses = readStringArray(proposed.normalizedContent, ["terminalStatuses"]);

  for (const field of baselineRequired) {
    if (proposedRequired.includes(field)) continue;
    changes.push(
      makeChange(
        "breaking",
        `event.requiredFields.${field}`,
        "event.required_field_removed",
        `Removed required event payload field ${field}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const field of proposedRequired) {
    if (baselineRequired.includes(field)) continue;
    changes.push(
      makeChange(
        baselineOptional.includes(field) ? "breaking" : "warning",
        `event.requiredFields.${field}`,
        "event.required_field_added",
        `Added required event payload field ${field}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const field of baselineOptional) {
    if (proposedOptional.includes(field) || proposedRequired.includes(field)) continue;
    changes.push(
      makeChange(
        "breaking",
        `event.optionalFields.${field}`,
        "event.payload_field_removed",
        `Removed optional event payload field ${field}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const field of proposedOptional) {
    if (baselineOptional.includes(field) || baselineRequired.includes(field)) continue;
    changes.push(
      makeChange(
        "compatible",
        `event.optionalFields.${field}`,
        "event.optional_field_added",
        `Added optional event payload field ${field}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const status of baselineTerminalStatuses) {
    if (proposedTerminalStatuses.includes(status)) continue;
    changes.push(
      makeChange(
        "breaking",
        `event.terminalStatuses.${status}`,
        "event.terminal_status_removed",
        `Removed terminal event status ${status}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const status of proposedTerminalStatuses) {
    if (baselineTerminalStatuses.includes(status)) continue;
    changes.push(
      makeChange(
        "warning",
        `event.terminalStatuses.${status}`,
        "event.terminal_status_added",
        `Added terminal event status ${status}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }

  changes.push(
    ...diffSchemaComponents(
      objectRecord(readPath(baselineContent, ["components", "schemas"])),
      objectRecord(readPath(proposed.normalizedContent, ["components", "schemas"])),
      proposed,
      "event.components.schemas"
    )
  );
  return changes;
}

function diffSharedSchemaContract(baselineContent: unknown, proposed: ContractRegistryArtifact): ContractDiffChange[] {
  return diffSchemaComponents(
    objectRecord(readPath(baselineContent, ["components", "schemas"])),
    objectRecord(readPath(proposed.normalizedContent, ["components", "schemas"])),
    proposed,
    "shared.components.schemas"
  );
}

function diffSchemaComponents(
  baselineSchemas: Record<string, unknown>,
  proposedSchemas: Record<string, unknown>,
  proposed: ContractRegistryArtifact,
  basePath: string
) {
  const changes: ContractDiffChange[] = [];
  for (const [schemaName, baselineSchema] of Object.entries(baselineSchemas)) {
    if (!(schemaName in proposedSchemas)) {
      changes.push(
        makeChange(
          "breaking",
          `${basePath}.${schemaName}`,
          "schema.removed",
          `Removed schema ${schemaName}.`,
          proposed.providerRole,
          proposed.consumerRoles
        )
      );
      continue;
    }
    changes.push(
      ...diffJsonSchema(
        baselineSchema,
        proposedSchemas[schemaName],
        `${basePath}.${schemaName}`,
        proposed
      )
    );
  }
  for (const schemaName of Object.keys(proposedSchemas)) {
    if (schemaName in baselineSchemas) continue;
    changes.push(
      makeChange(
        "compatible",
        `${basePath}.${schemaName}`,
        "schema.added",
        `Added schema ${schemaName}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  return changes;
}

function diffJsonSchema(
  baselineSchema: unknown,
  proposedSchema: unknown,
  path: string,
  proposed: ContractRegistryArtifact
): ContractDiffChange[] {
  const changes: ContractDiffChange[] = [];
  const baseline = objectRecord(baselineSchema);
  const next = objectRecord(proposedSchema);
  const baselineType = readSchemaType(baseline);
  const proposedType = readSchemaType(next);
  if (baselineType && proposedType && baselineType !== proposedType) {
    changes.push(
      makeChange(
        "breaking",
        `${path}.type`,
        "schema.type_changed",
        `Changed schema type from ${baselineType} to ${proposedType}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }

  const baselineEnum = readStringArray(baseline, ["enum"]);
  const proposedEnum = readStringArray(next, ["enum"]);
  for (const value of baselineEnum) {
    if (proposedEnum.includes(value)) continue;
    changes.push(
      makeChange(
        "breaking",
        `${path}.enum.${value}`,
        "schema.enum_removed",
        `Removed enum value ${value}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const value of proposedEnum) {
    if (baselineEnum.includes(value)) continue;
    changes.push(
      makeChange(
        "warning",
        `${path}.enum.${value}`,
        "schema.enum_added",
        `Added enum value ${value}; consumers may need exhaustive handling updates.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }

  const baselineRequired = readStringArray(baseline, ["required"]);
  const proposedRequired = readStringArray(next, ["required"]);
  for (const field of baselineRequired) {
    if (proposedRequired.includes(field)) continue;
    changes.push(
      makeChange(
        "breaking",
        `${path}.required.${field}`,
        "schema.required_field_removed",
        `Removed required schema field ${field}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  for (const field of proposedRequired) {
    if (baselineRequired.includes(field)) continue;
    changes.push(
      makeChange(
        "breaking",
        `${path}.required.${field}`,
        "schema.required_field_added",
        `Made schema field ${field} required.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }

  const baselineProperties = objectRecord(baseline.properties);
  const proposedProperties = objectRecord(next.properties);
  for (const [field, baselineProperty] of Object.entries(baselineProperties)) {
    if (!(field in proposedProperties)) {
      changes.push(
        makeChange(
          "breaking",
          `${path}.properties.${field}`,
          "schema.field_removed",
          `Removed schema field ${field}.`,
          proposed.providerRole,
          proposed.consumerRoles
        )
      );
      continue;
    }
    const baselinePropertyType = readSchemaType(objectRecord(baselineProperty));
    const proposedPropertyType = readSchemaType(objectRecord(proposedProperties[field]));
    if (baselinePropertyType && proposedPropertyType && baselinePropertyType !== proposedPropertyType) {
      changes.push(
        makeChange(
          "breaking",
          `${path}.properties.${field}.type`,
          "schema.field_type_changed",
          `Changed schema field ${field} type from ${baselinePropertyType} to ${proposedPropertyType}.`,
          proposed.providerRole,
          proposed.consumerRoles
        )
      );
    }
  }
  for (const field of Object.keys(proposedProperties)) {
    if (field in baselineProperties) continue;
    changes.push(
      makeChange(
        proposedRequired.includes(field) ? "breaking" : "compatible",
        `${path}.properties.${field}`,
        proposedRequired.includes(field) ? "schema.required_field_added" : "schema.optional_field_added",
        proposedRequired.includes(field)
          ? `Added required schema field ${field}.`
          : `Added optional schema field ${field}.`,
        proposed.providerRole,
        proposed.consumerRoles
      )
    );
  }
  return changes;
}

function makeChange(
  severity: ContractDiffSeverity,
  path: string,
  changeType: string,
  summary: string,
  providerRole: AgentRole,
  consumerRoles: AgentRole[]
): ContractDiffChange {
  return {
    severity,
    path,
    changeType,
    summary,
    providerRole,
    consumerRoles
  };
}

function summarizeDiffStatus(changes: ContractDiffChange[]): ContractDiffSeverity {
  if (changes.some((change) => change.severity === "breaking")) return "breaking";
  if (changes.some((change) => change.severity === "warning")) return "warning";
  return "compatible";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readPath(value: unknown, path: string[]): unknown {
  let cursor: unknown = value;
  for (const segment of path) {
    cursor = objectRecord(cursor)[segment];
  }
  return cursor;
}

function readString(value: unknown, path: string[]): string | undefined {
  const result = readPath(value, path);
  return typeof result === "string" ? result : undefined;
}

function readStringArray(value: unknown, path: string[]): string[] {
  const result = readPath(value, path);
  return Array.isArray(result) ? result.filter((item): item is string => typeof item === "string") : [];
}

function readSchemaType(schema: Record<string, unknown>): string | undefined {
  const type = schema.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.filter((item): item is string => typeof item === "string").sort().join("|");
  return undefined;
}

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values)];
}

function uniqueRoles(values: readonly AgentRole[]) {
  return [...new Set(values)];
}

function shortHash(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function hasRequestSchema(operation: (typeof httpApiContract.operations)[ApiOperationId]): operation is (typeof httpApiContract.operations)[ApiOperationId] & { request: string } {
  return "request" in operation;
}

function responseStatusFor(operationId: ApiOperationId) {
  return operationId === "createRequirement" ||
    operationId === "createBug" ||
    operationId === "linkExternalIssue" ||
    operationId === "createApproval" ||
    operationId === "startTeam" ||
    operationId === "startWorkItem"
    ? "201"
    : "200";
}

function isRequestBodyRequired(operationId: ApiOperationId) {
  return operationId !== "releaseWorkItem";
}

function requiresAuth(operationId: ApiOperationId) {
  return operationId === "exportPrdAuditPackage" ||
    operationId === "approvePrd" ||
    operationId === "startTeam" ||
    operationId === "createApproval" ||
    operationId === "approveApproval" ||
    operationId === "denyApproval" ||
    operationId === "startWorkItem";
}

function authErrorResponses() {
  return {
    "401": responseFor("ErrorResponse"),
    "403": responseFor("ErrorResponse")
  };
}

function responseFor(schemaName: string) {
  if (schemaName.startsWith("text/event-stream")) {
    return {
      description: "Server-sent event stream. Each data frame contains an AgentRun JSON payload.",
      content: {
        "text/event-stream": {
          schema: {
            type: "string"
          }
        }
      }
    };
  }
  if (schemaName.startsWith("text/plain")) {
    return {
      description: "Plain text response.",
      content: {
        "text/plain": {
          schema: {
            type: "string"
          }
        }
      }
    };
  }
  return {
    description: "Success",
    content: {
      "application/json": {
        schema: schemaRef(schemaName)
      }
    }
  };
}

function schemaRef(schemaName: string): OpenApiSchema {
  if (schemaName.endsWith("[]")) {
    return arrayOf(schemaRef(schemaName.slice(0, -2)));
  }
  return { $ref: `#/components/schemas/${schemaName}` };
}

function objectSchema(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return {
    type: "object",
    additionalProperties: false,
    required,
    properties
  };
}

function looseObjectSchema(properties: Record<string, unknown>, required = Object.keys(properties)) {
  return {
    type: "object",
    additionalProperties: true,
    required,
    properties
  };
}

function arrayOf(schema: unknown) {
  return {
    type: "array",
    items: schema
  };
}

function enumSchema(values: readonly string[]) {
  return {
    type: "string",
    enum: [...values]
  };
}

const id = { type: "string", minLength: 1 };
const isoDate = { type: "string", format: "date-time" };
const markdown = { type: "string" };
const requirementTemplate = enumSchema(["feature", "bug", "ui", "document"]);
const acceptanceStatus = enumSchema(["accepted", "rejected"]);
const runnerKind = enumSchema(["simulated", "codex"]);
const agentRole = enumSchema(["product", "frontend", "backend", "test", "ops", "reviewer"]);
const runStatus = enumSchema(["queued", "running", "needs_approval", "succeeded", "failed", "cancelled"]);
const workItemStatus = enumSchema(["proposed", "ready", "claimed", "running", "review", "blocked", "done", "cancelled"]);
const externalIssueProvider = enumSchema(externalIssueProviders);
const externalIssueStatusCategory = enumSchema(externalIssueStatusCategories);
const approvalKind = enumSchema(approvalKinds);
const approvalStatus = enumSchema(["pending", "approved", "denied", "expired"]);
const approvalTargetType = enumSchema(approvalTargetTypes);
const approvalRiskLevel = enumSchema(approvalRiskLevels);
const contractDiffSeverity = enumSchema(["compatible", "warning", "breaking"]);
const failureType = enumSchema(failureTypes);
const jsonValue = {
  anyOf: [
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" }
  ]
};
const intakeArtifactKind = enumSchema(intakeArtifactKinds);

export const openApiSchemas = {
  HealthResponse: objectSchema({
    ok: { type: "boolean" },
    service: { type: "string" }
  }),
  RunEventError: objectSchema({
    message: { type: "string" }
  }),
  ErrorResponse: objectSchema({
    error: { type: "string" },
    message: { type: "string" },
    code: { type: "string" },
    requiredHeaders: arrayOf({ type: "string" })
  }, ["error", "message"]),
  AuditChainVerification: objectSchema({
    valid: { type: "boolean" },
    checkedEvents: { type: "integer", minimum: 0 },
    headHash: {
      anyOf: [
        { type: "string" },
        { type: "null" }
      ]
    },
    errors: arrayOf({ type: "string" })
  }),
  AuditExportPackage: objectSchema({
    manifest: schemaRef("AuditExportManifest"),
    verification: schemaRef("AuditExportVerification"),
    records: schemaRef("AuditExportRecords"),
    artifactManifest: arrayOf(schemaRef("AuditExportArtifactManifestEntry")),
    auditEvents: arrayOf(schemaRef("AuditEvent")),
    auditEventsJsonl: { type: "string" },
    readme: { type: "string" }
  }),
  AuditExportManifest: looseObjectSchema({
    formatVersion: enumSchema(["patchpilot.audit.prd.v1"]),
    contractVersion: { type: "string" },
    createdAt: isoDate,
    createdBy: looseObjectSchema({
      actorType: { type: "string" },
      actorId: id,
      adminIntent: { type: "boolean" },
      authEnforcement: enumSchema(["td_222_rbac_enforced"])
    }, ["actorType", "actorId", "adminIntent", "authEnforcement"]),
    scope: looseObjectSchema({
      type: enumSchema(["prd"]),
      prdId: id,
      requirementId: id,
      filters: {
        type: "object",
        additionalProperties: { type: "boolean" }
      }
    }, ["type", "prdId", "requirementId", "filters"]),
    exportAuditEventId: id,
    counts: {
      type: "object",
      additionalProperties: { type: "number" }
    },
    redaction: looseObjectSchema({
      redacted: { type: "boolean" },
      finalPass: { type: "boolean" },
      policyVersion: { type: "string" },
      piiMarkers: arrayOf({ type: "string" })
    }, ["redacted", "finalPass", "policyVersion", "piiMarkers"]),
    retention: schemaRef("AuditExportRetentionPolicy"),
    integrity: looseObjectSchema({
      payloadSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      auditEventJsonlSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
      artifactManifestSha256: { type: "string", pattern: "^[a-f0-9]{64}$" }
    }, ["payloadSha256", "auditEventJsonlSha256", "artifactManifestSha256"])
  }, [
    "formatVersion",
    "contractVersion",
    "createdAt",
    "createdBy",
    "scope",
    "exportAuditEventId",
    "counts",
    "redaction",
    "retention",
    "integrity"
  ]),
  AuditExportVerification: objectSchema({
    chainOrder: enumSchema(["oldest_to_newest"]),
    ledgerScope: enumSchema(["project_ledger_full"]),
    valid: { type: "boolean" },
    checkedEvents: { type: "integer", minimum: 0 },
    firstHash: {
      anyOf: [
        { type: "string", pattern: "^[a-f0-9]{64}$" },
        { type: "null" }
      ]
    },
    headHash: {
      anyOf: [
        { type: "string", pattern: "^[a-f0-9]{64}$" },
        { type: "null" }
      ]
    },
    errors: arrayOf({ type: "string" }),
    scopeEventIds: arrayOf(id),
    interleavedEventCount: { type: "integer", minimum: 0 }
  }),
  AuditExportRetentionPolicy: objectSchema({
    policyVersion: { type: "string" },
    legalHold: { type: "boolean" },
    worm: looseObjectSchema({
      enabled: { type: "boolean" },
      mode: enumSchema(["metadata_only"]),
      semantics: { type: "string" },
      futureStorage: enumSchema(["s3_object_lock_or_equivalent"])
    }, ["enabled", "mode", "semantics", "futureStorage"]),
    tiers: arrayOf(looseObjectSchema({
      tier: enumSchema([
        "tier_0_audit_ledger",
        "tier_1_product_evidence",
        "tier_2_decision_artifacts",
        "tier_3_raw_run_artifacts"
      ]),
      defaultRetention: { type: "string" },
      appliesTo: arrayOf({ type: "string" })
    }, ["tier", "defaultRetention", "appliesTo"]))
  }),
  AuditExportArtifactManifestEntry: looseObjectSchema({
    artifactId: id,
    kind: enumSchema(["log", "trace", "diff", "test_report", "screenshot", "preview_metadata", "intake_attachment"]),
    checksumSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
    sizeBytes: { type: "number" },
    contentType: { type: "string" },
    storage: enumSchema(["local_fs", "s3"]),
    uri: { type: "string" },
    retentionTier: enumSchema([
      "tier_0_audit_ledger",
      "tier_1_product_evidence",
      "tier_2_decision_artifacts",
      "tier_3_raw_run_artifacts"
    ]),
    redactionStatus: enumSchema(["redacted", "not_marked", "metadata_only"]),
    includedBytes: { type: "boolean" },
    tombstone: { type: "boolean" },
    createdAt: isoDate,
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id,
    testRunId: id
  }, [
    "artifactId",
    "kind",
    "checksumSha256",
    "sizeBytes",
    "contentType",
    "storage",
    "uri",
    "retentionTier",
    "redactionStatus",
    "includedBytes",
    "tombstone",
    "createdAt"
  ]),
  AuditExportRecords: objectSchema({
    requirement: {
      anyOf: [
        schemaRef("Requirement"),
        { type: "null" }
      ]
    },
    prd: schemaRef("Prd"),
    workItems: arrayOf(schemaRef("WorkItem")),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract")),
    agentRuns: arrayOf(schemaRef("AgentRun")),
    workspaceRuns: arrayOf(schemaRef("WorkspaceRun")),
    testCases: arrayOf(schemaRef("TestCase")),
    testRuns: arrayOf(schemaRef("TestRun")),
    artifacts: arrayOf(schemaRef("ArtifactRecord")),
    pullRequests: arrayOf(schemaRef("PullRequestRecord")),
    reviewRecords: arrayOf(schemaRef("ReviewRecord")),
    approvals: arrayOf(schemaRef("ApprovalRecord")),
    bugs: arrayOf(schemaRef("BugReport")),
    acceptances: arrayOf(schemaRef("AcceptanceDecision"))
  }),
  CreateRequirementRequest: objectSchema({
    rawInput: { type: "string", minLength: 3 },
    template: requirementTemplate,
    artifactReferences: arrayOf(schemaRef("IntakeArtifactReferenceInput"))
  }, ["rawInput", "template"]),
  ClarificationAnswerRequest: objectSchema({
    answers: {
      type: "object",
      additionalProperties: { type: "string" },
      default: {}
    }
  }),
  ClarificationTurnRequest: objectSchema({
    message: { type: "string", minLength: 1 }
  }),
  StartRunRequest: objectSchema({
    runner: runnerKind,
    claimToken: { type: "string", minLength: 1 }
  }, []),
  AcceptanceRequest: objectSchema({
    status: acceptanceStatus,
    reason: { type: "string" }
  }, ["status"]),
  ClaimWorkItemRequest: objectSchema({
    agentId: { type: "string", minLength: 1 },
    leaseDurationMs: { type: "integer", minimum: 1, maximum: 60 * 60 * 1000 }
  }, ["agentId"]),
  ReleaseWorkItemRequest: objectSchema({
    claimToken: { type: "string", minLength: 1 }
  }, []),
  ExternalIssueLinkRequest: objectSchema({
    provider: externalIssueProvider,
    entityType: enumSchema(["work_item", "defect"]),
    entityId: id,
    externalIssueId: { type: "string", minLength: 1 },
    externalKey: { type: "string", minLength: 1 },
    externalUrl: { type: "string", format: "uri" },
    statusName: { type: "string", minLength: 1 },
    statusCategory: externalIssueStatusCategory,
    summary: { type: "string", minLength: 1, maxLength: 500 }
  }, ["provider", "entityType", "entityId"]),
  ExternalIssueStatusUpdateRequest: objectSchema({
    provider: externalIssueProvider,
    externalIssueId: { type: "string", minLength: 1 },
    externalKey: { type: "string", minLength: 1 },
    statusName: { type: "string", minLength: 1 },
    statusCategory: externalIssueStatusCategory,
    actor: { type: "string", minLength: 1 },
    observedAt: isoDate,
    idempotencyKey: { type: "string", minLength: 1 }
  }, ["provider", "statusName"]),
  CreateApprovalRequest: objectSchema({
    kind: approvalKind,
    targetType: approvalTargetType,
    targetId: id,
    requestedBy: { type: "string", minLength: 1 },
    requestedReason: { type: "string", minLength: 1 },
    riskLevel: approvalRiskLevel,
    expiresAt: isoDate,
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id
  }, ["kind", "targetType", "targetId", "requestedBy", "requestedReason", "riskLevel", "expiresAt"]),
  ApprovalDecisionRequest: objectSchema({
    decidedBy: { type: "string", minLength: 1 },
    decisionReason: { type: "string", minLength: 1 }
  }),
  CreateBugRequest: objectSchema({
    title: { type: "string", minLength: 3 },
    description: { type: "string", minLength: 3 },
    reproductionSteps: { type: "string", minLength: 3 },
    expectedBehavior: { type: "string", minLength: 3 },
    actualBehavior: { type: "string", minLength: 3 },
    severity: enumSchema(["low", "medium", "high", "critical"]),
    reporter: { type: "string" },
    artifactReferences: arrayOf(schemaRef("IntakeArtifactReferenceInput"))
  }, ["title", "description", "reproductionSteps", "expectedBehavior", "actualBehavior"]),
  RuntimeConfig: objectSchema({
    configuredRunner: enumSchema(["auto", "simulated", "codex"]),
    activeRunner: runnerKind,
    codexAvailable: { type: "boolean" },
    gitWorkspaceAvailable: { type: "boolean" },
    testCommand: { type: "string" },
    workspaceRoot: { type: "string" },
    previewUrl: { type: "string" },
    configSource: enumSchema(["defaults", "file"]),
    configPath: { type: "string" },
    setup: schemaRef("RuntimeSetupConfig"),
    test: schemaRef("RuntimeTestConfig"),
    smoke: schemaRef("RuntimeSmokeConfig"),
    e2e: schemaRef("RuntimeE2eConfig"),
    dev: schemaRef("RuntimeDevConfig"),
    security: schemaRef("RuntimeSecurityConfig"),
    budget: schemaRef("RuntimeBudgetConfig"),
    artifacts: schemaRef("RuntimeArtifactsConfig")
  }, ["configuredRunner", "activeRunner", "codexAvailable", "gitWorkspaceAvailable", "testCommand", "workspaceRoot", "previewUrl", "configSource", "setup", "test", "smoke", "e2e", "dev", "security", "budget", "artifacts"]),
  RuntimeSetupConfig: objectSchema({
    commands: arrayOf({ type: "string" })
  }),
  RuntimeTestConfig: objectSchema({
    command: { type: "string" },
    timeoutMs: { type: "number" },
    maxRepairAttempts: { type: "number" }
  }),
  RuntimeSmokeConfig: objectSchema({
    command: { type: "string" },
    timeoutMs: { type: "number" },
    previewUrl: { type: "string" }
  }),
  RuntimeE2eConfig: objectSchema({
    command: { type: "string" },
    timeoutMs: { type: "number" },
    baseUrl: { type: "string" }
  }),
  RuntimeDevConfig: objectSchema({
    runner: enumSchema(["auto", "simulated", "codex"]),
    simulationDelayFactor: { type: "number" },
    workspaceRoot: { type: "string" },
    previewUrl: { type: "string" }
  }),
  RuntimeSecurityConfig: objectSchema({
    codexSandbox: { type: "string" },
    codexBypass: { type: "boolean" },
    containerSandbox: schemaRef("RuntimeContainerSandboxConfig"),
    egressPolicy: schemaRef("RuntimeEgressPolicyConfig"),
    secretBroker: schemaRef("RuntimeSecretBrokerConfig")
  }),
  RuntimeContainerSandboxConfig: objectSchema({
    enabled: { type: "boolean" },
    runtime: enumSchema(["auto", "docker", "podman"]),
    image: { type: "string" },
    cpus: { type: "number" },
    memoryMb: { type: "number" },
    workspaceDiskMb: { type: "number" },
    tmpfsMb: { type: "number" },
    pidsLimit: { type: "number" },
    uid: { type: "number" },
    gid: { type: "number" }
  }),
  RuntimeEgressPolicyConfig: objectSchema({
    enabled: { type: "boolean" },
    allowedHosts: arrayOf({ type: "string" }),
    allowGitRemotes: { type: "boolean" },
    proxyImage: { type: "string" },
    proxyPort: { type: "number" },
    auditLogPath: { type: "string" },
    denyPrivateNetworks: { const: true },
    denyMetadataEndpoints: { const: true }
  }),
  RuntimeSecretBrokerConfig: objectSchema({
    enabled: { type: "boolean" },
    allowedSecrets: arrayOf(schemaRef("RuntimeSecretBrokerSecretConfig")),
    allowProductionSecrets: { const: false }
  }),
  RuntimeSecretBrokerSecretConfig: objectSchema({
    id: { type: "string" },
    envVar: { type: "string" },
    sourceEnv: { type: "string" },
    environment: enumSchema(["dev", "ci"]),
    description: { type: "string" },
    ttlSeconds: { type: "number" },
    provider: schemaRef("RuntimeSecretBrokerProviderConfig")
  }, ["id", "envVar", "environment"]),
  RuntimeSecretBrokerProviderConfig: objectSchema({
    kind: enumSchema(["env", "local_fake", "vault"]),
    sourceEnv: { type: "string" },
    address: { type: "string" },
    tokenEnv: { type: "string" },
    mount: { type: "string" },
    path: { type: "string" },
    key: { type: "string" },
    kvVersion: { type: "number", enum: [1, 2] },
    namespaceEnv: { type: "string" },
    ttlSeconds: { type: "number" },
    seedEnv: { type: "string" },
    rotatePath: { type: "string" },
    revokePath: { type: "string" }
  }, ["kind"]),
  RuntimeBudgetConfig: objectSchema({
    codexTimeoutMs: { type: "number" },
    maxCostUsd: { type: "number" },
    prdUsd: { type: "number" },
    workItemUsd: { type: "number" },
    runUsd: { type: "number" },
    softThresholdRatio: { type: "number" }
  }),
  RuntimeArtifactsConfig: objectSchema({
    provider: enumSchema(["local_fs", "s3"]),
    localRoot: { type: "string" },
    s3: schemaRef("RuntimeS3ArtifactConfig")
  }, ["provider"]),
  RuntimeS3ArtifactConfig: objectSchema({
    endpoint: { type: "string" },
    region: { type: "string" },
    bucket: { type: "string" },
    forcePathStyle: { type: "boolean" },
    prefix: { type: "string" }
  }, ["region", "bucket", "forcePathStyle", "prefix"]),
  Requirement: looseObjectSchema({
    id,
    title: { type: "string" },
    rawInput: { type: "string" },
    template: requirementTemplate,
    status: enumSchema(["submitted", "clarifying", "prd_draft", "approved", "rejected"]),
    simpleSummary: { type: "string" },
    artifactReferences: arrayOf(schemaRef("IntakeArtifactReference")),
    clarificationQuestions: arrayOf(schemaRef("ClarificationQuestion")),
    clarificationTurns: arrayOf(schemaRef("ClarificationTurn")),
    createdAt: isoDate,
    updatedAt: isoDate
  }),
  IntakeArtifactReferenceInput: objectSchema({
    id,
    kind: intakeArtifactKind,
    label: { type: "string", minLength: 1, maxLength: 160 },
    uri: { type: "string", minLength: 1, maxLength: 2000 },
    contentType: { type: "string", minLength: 1, maxLength: 160 },
    sizeBytes: { type: "integer", minimum: 0 },
    artifactId: id,
    metadata: { type: "object", additionalProperties: { type: "string" } },
    createdAt: isoDate
  }, ["kind", "label"]),
  IntakeArtifactReference: objectSchema({
    id,
    kind: intakeArtifactKind,
    label: { type: "string" },
    uri: { type: "string" },
    contentType: { type: "string" },
    sizeBytes: { type: "number" },
    artifactId: id,
    metadata: { type: "object", additionalProperties: { type: "string" } },
    createdAt: isoDate
  }, ["id", "kind", "label", "createdAt"]),
  ClarificationQuestion: objectSchema({
    id,
    question: { type: "string" },
    recommendedAnswer: { type: "string" },
    answer: { type: "string" }
  }, ["id", "question", "recommendedAnswer"]),
  ClarificationTurn: objectSchema({
    id,
    speaker: enumSchema(["agent", "user"]),
    message: { type: "string" },
    recommendedAnswer: { type: "string" },
    createdAt: isoDate
  }, ["id", "speaker", "message", "createdAt"]),
  Prd: objectSchema({
    id,
    requirementId: id,
    version: { type: "integer", minimum: 1 },
    status: enumSchema(["draft", "approved"]),
    title: { type: "string" },
    bodyMarkdown: markdown,
    acceptanceCriteria: arrayOf({ type: "string" }),
    budgetUsd: { type: "number", minimum: 0 },
    approvedAt: isoDate
  }, ["id", "requirementId", "version", "status", "title", "bodyMarkdown", "acceptanceCriteria"]),
  WorkItem: looseObjectSchema({
    id,
    prdId: id,
    title: { type: "string" },
    status: workItemStatus,
    role: agentRole,
    scope: { type: "string" },
    nonGoals: arrayOf({ type: "string" }),
    acceptanceCriteria: arrayOf({ type: "string" }),
    testSuggestions: arrayOf({ type: "string" }),
    dependsOn: arrayOf(id),
    requiredCapabilities: arrayOf({ type: "string" }),
    budgetUsd: { type: "number", minimum: 0 },
    concurrencyKey: { type: "string" },
    maxConcurrent: { type: "integer", minimum: 0 },
    assignedAgentId: id,
    claimedAt: isoDate,
    claimToken: { type: "string" },
    leaseExpiresAt: isoDate,
    heartbeatAt: isoDate,
    version: { type: "integer", minimum: 1 },
    sourceBugId: id,
    externalIssueLinks: arrayOf(schemaRef("ExternalIssueLink")),
    externalIssueSyncEvidence: arrayOf(schemaRef("ExternalIssueSyncEvidence")),
    externalBlocker: schemaRef("ExternalIssueBlocker"),
    reworkCount: { type: "integer", minimum: 0 },
    lastRejectionReason: { type: "string" }
  }, ["id", "prdId", "title", "status", "role", "scope", "nonGoals", "acceptanceCriteria", "testSuggestions"]),
  InterfaceContract: objectSchema({
    id,
    prdId: id,
    name: { type: "string" },
    kind: enumSchema(["http", "event", "schema"]),
    status: enumSchema(["draft", "approved", "breaking_change_pending", "deprecated"]),
    version: { type: "integer", minimum: 1 },
    summary: { type: "string" },
    providerRole: agentRole,
    consumerRoles: arrayOf(agentRole),
    specMarkdown: markdown,
    testSuggestions: arrayOf({ type: "string" }),
    registry: schemaRef("ContractRegistryMetadata"),
    createdAt: isoDate,
    updatedAt: isoDate
  }),
  ContractDiffChange: objectSchema({
    severity: contractDiffSeverity,
    path: { type: "string" },
    changeType: { type: "string" },
    summary: { type: "string" },
    providerRole: agentRole,
    consumerRoles: arrayOf(agentRole)
  }),
  ContractDiffSummary: objectSchema({
    id,
    status: contractDiffSeverity,
    hasBreakingChanges: { type: "boolean" },
    hasWarnings: { type: "boolean" },
    baselineRevisionId: id,
    proposedRevisionId: id,
    baselineContentHash: { type: "string" },
    proposedContentHash: { type: "string" },
    impactedProviderRole: agentRole,
    impactedConsumerRoles: arrayOf(agentRole),
    changes: arrayOf(schemaRef("ContractDiffChange")),
    createdAt: isoDate
  }, [
    "id",
    "status",
    "hasBreakingChanges",
    "hasWarnings",
    "proposedRevisionId",
    "proposedContentHash",
    "impactedProviderRole",
    "impactedConsumerRoles",
    "changes",
    "createdAt"
  ]),
  ContractRegistryMetadata: objectSchema({
    artifactId: id,
    generatorVersion: { type: "string" },
    revisionId: id,
    revision: { type: "integer", minimum: 1 },
    contentHash: { type: "string" },
    sourceRef: { type: "string" },
    providerRole: agentRole,
    consumerRoles: arrayOf(agentRole),
    status: enumSchema(["draft", "approved", "breaking_change_pending", "deprecated"]),
    normalizedContent: jsonValue,
    baselineRevisionId: id,
    approvedRevisionId: id,
    approvedAt: isoDate,
    diff: schemaRef("ContractDiffSummary"),
    approvalId: id,
    testRunIds: arrayOf(id)
  }, [
    "artifactId",
    "generatorVersion",
    "revisionId",
    "revision",
    "contentHash",
    "sourceRef",
    "providerRole",
    "consumerRoles",
    "status",
    "normalizedContent"
  ]),
  AgentProfile: objectSchema({
    id,
    name: { type: "string" },
    role: agentRole,
    status: enumSchema(["idle", "busy", "offline"]),
    currentWorkItemId: id,
    capabilities: arrayOf({ type: "string" }),
    lastSeenAt: isoDate
  }, ["id", "name", "role", "status", "lastSeenAt"]),
  AgentRun: looseObjectSchema({
    id,
    requirementId: id,
    prdId: id,
    workItemId: id,
    runner: runnerKind,
    status: runStatus,
    currentStep: enumSchema(["understanding", "planning", "developing", "testing", "confirming"]),
    timeline: arrayOf(schemaRef("TimelineStep")),
    events: arrayOf(schemaRef("AgentRunEvent")),
    result: schemaRef("AgentRunResult"),
    failureType,
    failureSummary: { type: "string" },
    budgetUsd: { type: "number", minimum: 0 },
    budgetSoftThresholdUsd: { type: "number", minimum: 0 },
    budgetApprovalId: id,
    costEstimateUsd: { type: "number" },
    costActualUsd: { type: "number" },
    artifactIds: arrayOf(id),
    startedAt: isoDate,
    endedAt: isoDate
  }, ["id", "requirementId", "prdId", "workItemId", "runner", "status", "currentStep", "timeline", "events", "costEstimateUsd", "startedAt"]),
  TimelineStep: objectSchema({
    key: enumSchema(["understanding", "planning", "developing", "testing", "confirming"]),
    label: { type: "string" },
    status: enumSchema(["waiting", "active", "done", "failed"]),
    detail: { type: "string" }
  }),
  AgentRunEvent: objectSchema({
    id,
    at: isoDate,
    type: { type: "string" },
    message: { type: "string" }
  }),
  AgentRunToolCall: looseObjectSchema({
    id,
    name: { type: "string" },
    status: enumSchema(["started", "completed", "failed", "unknown"]),
    summary: { type: "string" },
    command: { type: "string" },
    exitCode: { type: ["number", "null"] },
    startedAt: isoDate,
    endedAt: isoDate,
    durationMs: { type: "number", minimum: 0 }
  }, ["id", "name", "status", "summary"]),
  AgentRunDiffSummary: looseObjectSchema({
    changedFileCount: { type: "number", minimum: 0 },
    changedFiles: arrayOf({ type: "string" }),
    hasChanges: { type: "boolean" },
    branchName: { type: "string" },
    baseBranch: { type: "string" },
    baseCommit: { type: "string" },
    headCommit: { type: "string" }
  }, ["changedFileCount", "changedFiles", "hasChanges"]),
  AgentRunResult: looseObjectSchema({
    summary: { type: "string" },
    previewUrl: { type: "string" },
    riskLevel: enumSchema(["low", "medium", "high"]),
    changedFiles: arrayOf({ type: "string" }),
    tests: arrayOf(schemaRef("TestRun")),
    reviewerSummary: { type: "string" },
    runner: runnerKind,
    agentMessages: arrayOf({ type: "string" }),
    reasoningSummaries: arrayOf({ type: "string" }),
    toolCalls: arrayOf(schemaRef("AgentRunToolCall")),
    diffSummary: schemaRef("AgentRunDiffSummary"),
    testOutputSummary: { type: "string" },
    workspacePath: { type: "string" },
    branchName: { type: "string" },
    baseBranch: { type: "string" },
    baseCommit: { type: "string" },
    headCommit: { type: "string" },
    codexSessionId: { type: "string" },
    artifactIds: arrayOf(id),
    egressPolicyEvidence: schemaRef("EgressPolicyEvidence"),
    secretBrokerEvidence: schemaRef("SecretBrokerEvidence")
  }, ["summary", "previewUrl", "riskLevel", "changedFiles", "tests", "reviewerSummary", "runner"]),
  EgressPolicyEvidence: looseObjectSchema({
    enabled: { type: "boolean" },
    mode: enumSchema(["proxy_sidecar", "disabled"]),
    allowedHosts: arrayOf({ type: "string" }),
    auditLogPath: { type: "string" },
    allowedCount: { type: "number" },
    deniedCount: { type: "number" },
    denied: arrayOf(schemaRef("EgressPolicyAuditEntry")),
    recent: arrayOf(schemaRef("EgressPolicyAuditEntry"))
  }, ["enabled", "mode", "allowedHosts", "auditLogPath", "allowedCount", "deniedCount", "denied", "recent"]),
  EgressPolicyAuditEntry: looseObjectSchema({
    at: isoDate,
    decision: enumSchema(["allowed", "denied"]),
    reason: { type: "string" },
    protocol: { type: "string" },
    host: { type: "string" },
    port: { type: "number" },
    target: { type: "string" },
    resolvedIps: arrayOf({ type: "string" })
  }, ["at", "decision", "reason", "protocol", "host", "port", "target"]),
  SecretBrokerEvidence: looseObjectSchema({
    enabled: { type: "boolean" },
    mode: enumSchema(["env", "adapter"]),
    requestedSecretIds: arrayOf({ type: "string" }),
    injected: arrayOf(schemaRef("SecretBrokerInjectedSecretEvidence")),
    denied: arrayOf(schemaRef("SecretBrokerDeniedSecretEvidence")),
    revoked: arrayOf(schemaRef("SecretBrokerGrantOperationEvidence"))
  }, ["enabled", "mode", "requestedSecretIds", "injected", "denied", "revoked"]),
  SecretBrokerInjectedSecretEvidence: looseObjectSchema({
    id: { type: "string" },
    envVar: { type: "string" },
    sourceEnv: { type: "string" },
    environment: enumSchema(["dev", "ci"]),
    provider: enumSchema(["env", "local_fake", "vault"]),
    leaseId: { type: "string" },
    issuedAt: isoDate,
    expiresAt: isoDate,
    ttlSeconds: { type: "number" },
    renewable: { type: "boolean" },
    rotationSupported: { type: "boolean" },
    revocationSupported: { type: "boolean" },
    valueFingerprint: { type: "string" },
    providerAuditId: { type: "string" }
  }, [
    "id",
    "envVar",
    "environment",
    "provider",
    "issuedAt",
    "renewable",
    "rotationSupported",
    "revocationSupported",
    "valueFingerprint"
  ]),
  SecretBrokerDeniedSecretEvidence: looseObjectSchema({
    id: { type: "string" },
    reason: enumSchema([
      "broker_disabled",
      "not_configured",
      "source_env_missing",
      "production_secret_denied",
      "provider_auth_missing",
      "provider_read_failed",
      "provider_revoked"
    ]),
    provider: enumSchema(["env", "local_fake", "vault"])
  }, ["id", "reason"]),
  SecretBrokerGrantOperationEvidence: looseObjectSchema({
    id: { type: "string" },
    provider: enumSchema(["env", "local_fake", "vault"]),
    action: enumSchema(["rotate", "revoke"]),
    status: enumSchema(["succeeded", "unsupported", "failed"]),
    occurredAt: isoDate,
    leaseId: { type: "string" },
    rotationVersion: { type: "string" },
    providerAuditId: { type: "string" },
    reason: { type: "string" }
  }, ["id", "provider", "action", "status", "occurredAt"]),
  WorkspaceRun: looseObjectSchema({
    id,
    runId: id,
    requirementId: id,
    prdId: id,
    workItemId: id,
    runner: runnerKind,
    status: enumSchema(["preparing", "ready", "active", "archived", "failed", "destroyed"]),
    isolation: enumSchema(["simulated", "git_worktree"]),
    path: { type: "string" },
    createdAt: isoDate,
    updatedAt: isoDate
  }),
  TestCase: looseObjectSchema({
    id,
    requirementId: id,
    prdId: id,
    workItemId: id,
    title: { type: "string" },
    kind: enumSchema(["acceptance", "regression", "contract", "smoke"]),
    status: enumSchema(["draft", "ready", "passed", "failed", "blocked"]),
    priority: enumSchema(["low", "medium", "high"]),
    steps: arrayOf({ type: "string" }),
    expectedResult: { type: "string" },
    linkedAcceptanceCriteria: arrayOf({ type: "string" }),
    lastRunId: id,
    lastTestRunId: id,
    flaky: { type: "boolean" }
  }, ["id", "requirementId", "prdId", "workItemId", "title", "kind", "status", "priority", "steps", "expectedResult", "linkedAcceptanceCriteria"]),
  TestRun: looseObjectSchema({
    id,
    testCaseId: id,
    runId: id,
    prdId: id,
    workItemId: id,
    status: enumSchema(["queued", "running", "passed", "failed", "blocked", "skipped"]),
    command: { type: "string" },
    summary: { type: "string" },
    durationMs: { type: "number" },
    startedAt: isoDate,
    endedAt: isoDate,
    commit: { type: "string" },
    branch: { type: "string" },
    pullRequestId: id,
    workspacePath: { type: "string" },
    runner: { type: "string" },
    environmentImage: { type: "string" },
    exitCode: { type: ["number", "null"] },
    failureSummary: { type: "string" },
    logArtifactId: id,
    artifactIds: arrayOf(id),
    retryCount: { type: "number" },
    attempt: { type: "number" },
    maxAttempts: { type: "number" },
    flakySignal: { type: "boolean" },
    egressPolicyEvidence: schemaRef("EgressPolicyEvidence")
  }, ["id", "status", "command", "summary", "durationMs"]),
  ArtifactRecord: objectSchema({
    id,
    kind: enumSchema(["log", "trace", "diff", "test_report", "screenshot", "preview_metadata", "intake_attachment"]),
    storage: enumSchema(["local_fs", "s3"]),
    uri: { type: "string" },
    contentType: { type: "string" },
    sizeBytes: { type: "number" },
    checksumSha256: { type: "string" },
    metadata: { type: "object", additionalProperties: { type: "string" } },
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id,
    testRunId: id,
    createdAt: isoDate
  }, ["id", "kind", "storage", "uri", "contentType", "sizeBytes", "checksumSha256", "createdAt"]),
  ExternalIssueLink: objectSchema({
    id,
    provider: externalIssueProvider,
    externalIssueId: { type: "string" },
    externalKey: { type: "string" },
    externalUrl: { type: "string", format: "uri" },
    statusName: { type: "string" },
    statusCategory: externalIssueStatusCategory,
    summary: { type: "string" },
    createdAt: isoDate,
    updatedAt: isoDate,
    lastSyncedAt: isoDate
  }, ["id", "provider", "externalIssueId", "statusName", "statusCategory", "createdAt", "updatedAt"]),
  ExternalIssueBlocker: objectSchema({
    provider: externalIssueProvider,
    externalIssueId: { type: "string" },
    externalKey: { type: "string" },
    statusName: { type: "string" },
    statusCategory: enumSchema(["blocked"]),
    reason: { type: "string" },
    blockedAt: isoDate
  }, ["provider", "externalIssueId", "statusName", "statusCategory", "reason", "blockedAt"]),
  ExternalIssueSyncEvidence: objectSchema({
    id,
    provider: externalIssueProvider,
    externalIssueId: { type: "string" },
    externalKey: { type: "string" },
    direction: enumSchema(["patchpilot_to_external", "external_to_patchpilot"]),
    action: enumSchema(["linked", "mirrored", "triggered", "blocked", "observed", "ignored"]),
    statusName: { type: "string" },
    statusCategory: externalIssueStatusCategory,
    message: { type: "string" },
    actor: { type: "string" },
    idempotencyKey: { type: "string" },
    observedAt: isoDate,
    recordedAt: isoDate,
    patchPilotStatusBefore: { type: "string" },
    patchPilotStatusAfter: { type: "string" }
  }, [
    "id",
    "provider",
    "externalIssueId",
    "direction",
    "action",
    "statusName",
    "statusCategory",
    "message",
    "observedAt",
    "recordedAt"
  ]),
  PullRequestRecord: looseObjectSchema({
    id,
    provider: enumSchema(["local", "github"]),
    status: enumSchema(["draft", "ready_for_review", "changes_requested", "approved", "merged", "closed"]),
    title: { type: "string" },
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id,
    branchName: { type: "string" },
    baseBranch: { type: "string" },
    baseCommit: { type: "string" },
    headCommit: { type: "string" },
    url: { type: "string" },
    bodyMarkdown: markdown
  }, ["id", "provider", "status", "title", "requirementId", "prdId", "workItemId", "runId", "branchName", "baseBranch", "url", "bodyMarkdown"]),
  ReviewRecord: looseObjectSchema({
    id,
    status: enumSchema(["approved", "changes_requested", "blocked"]),
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id,
    linkedPullRequestId: id,
    summary: { type: "string" }
  }),
  ApprovalRecord: objectSchema({
    id,
    kind: approvalKind,
    status: approvalStatus,
    targetType: approvalTargetType,
    targetId: id,
    requestedBy: { type: "string" },
    requestedReason: { type: "string" },
    riskLevel: approvalRiskLevel,
    expiresAt: isoDate,
    approvedBy: { type: "string" },
    deniedBy: { type: "string" },
    decisionReason: { type: "string" },
    decidedAt: isoDate,
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id,
    createdAt: isoDate,
    updatedAt: isoDate
  }, ["id", "kind", "status", "targetType", "targetId", "requestedBy", "requestedReason", "riskLevel", "expiresAt", "createdAt", "updatedAt"]),
  AuditEvent: looseObjectSchema({
    id,
    traceId: id,
    actorType: { type: "string" },
    actorId: id,
    actor: { type: "string" },
    action: { type: "string" },
    targetType: { type: "string" },
    targetId: id,
    message: { type: "string" },
    beforeJson: jsonValue,
    afterJson: jsonValue,
    metadataJson: jsonValue,
    hash: { type: "string", pattern: "^[a-f0-9]{64}$" },
    previousHash: {
      anyOf: [
        { type: "string", pattern: "^[a-f0-9]{64}$" },
        { type: "null" }
      ]
    },
    requirementId: id,
    prdId: id,
    workItemId: id,
    runId: id,
    createdAt: isoDate
  }, [
    "id",
    "traceId",
    "actorType",
    "actorId",
    "action",
    "targetType",
    "targetId",
    "message",
    "beforeJson",
    "afterJson",
    "metadataJson",
    "hash",
    "previousHash",
    "createdAt"
  ]),
  BugReport: looseObjectSchema({
    id,
    title: { type: "string" },
    description: { type: "string" },
    reproductionSteps: { type: "string" },
    expectedBehavior: { type: "string" },
    actualBehavior: { type: "string" },
    severity: enumSchema(["low", "medium", "high", "critical"]),
    status: enumSchema(bugStatuses),
    reporter: { type: "string" },
    requirementId: id,
    prdId: id,
    workItemId: id,
    artifactReferences: arrayOf(schemaRef("IntakeArtifactReference")),
    externalIssueLinks: arrayOf(schemaRef("ExternalIssueLink")),
    externalIssueSyncEvidence: arrayOf(schemaRef("ExternalIssueSyncEvidence")),
    externalBlocker: schemaRef("ExternalIssueBlocker"),
    sourceRunId: id,
    sourceTestRunId: id,
    sourceFailureType: failureType,
    sourceCommit: { type: "string" },
    sourceBranch: { type: "string" }
  }, [
    "id",
    "title",
    "description",
    "reproductionSteps",
    "expectedBehavior",
    "actualBehavior",
    "severity",
    "status",
    "reporter",
    "requirementId",
    "prdId",
    "workItemId"
  ]),
  AcceptanceDecision: objectSchema({
    runId: id,
    status: enumSchema(["pending", "accepted", "rejected"]),
    reason: { type: "string" },
    decidedAt: isoDate
  }, ["runId", "status"]),
  RequirementBundle: objectSchema({
    requirement: schemaRef("Requirement"),
    prd: schemaRef("Prd"),
    workItems: arrayOf(schemaRef("WorkItem")),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract"))
  }, ["requirement", "workItems", "interfaceContracts"]),
  RequirementPrdBundle: objectSchema({
    requirement: schemaRef("Requirement"),
    prd: schemaRef("Prd"),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract"))
  }),
  ClarificationTurnResponse: objectSchema({
    requirement: schemaRef("Requirement"),
    nextQuestion: schemaRef("ClarificationQuestion")
  }),
  ApprovePrdResponse: objectSchema({
    prd: schemaRef("Prd"),
    workItems: arrayOf(schemaRef("WorkItem")),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract")),
    testCases: arrayOf(schemaRef("TestCase"))
  }, ["prd", "workItems", "interfaceContracts"]),
  StartTeamResponse: objectSchema({
    prd: schemaRef("Prd"),
    workItems: arrayOf(schemaRef("WorkItem")),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract")),
    runs: arrayOf(schemaRef("AgentRun")),
    skippedWorkItems: arrayOf(schemaRef("WorkItem"))
  }),
  TeamAcceptanceResponse: objectSchema({
    decisions: arrayOf(schemaRef("AcceptanceDecision")),
    workItems: arrayOf(schemaRef("WorkItem")),
    runs: arrayOf(schemaRef("AgentRun"))
  }),
  ClaimWorkItemResponse: objectSchema({
    workItem: schemaRef("WorkItem"),
    agent: schemaRef("AgentProfile"),
    bug: schemaRef("BugReport"),
    claimToken: { type: "string" },
    leaseExpiresAt: isoDate
  }, ["workItem", "agent", "claimToken", "leaseExpiresAt"]),
  ReleaseWorkItemResponse: objectSchema({
    workItem: schemaRef("WorkItem"),
    agent: schemaRef("AgentProfile")
  }, ["workItem"]),
  CreateBugResponse: objectSchema({
    bug: schemaRef("BugReport"),
    requirement: schemaRef("Requirement"),
    prd: schemaRef("Prd"),
    workItem: schemaRef("WorkItem")
  }),
  ExternalIssueSyncResponse: looseObjectSchema({
    link: schemaRef("ExternalIssueLink"),
    evidence: schemaRef("ExternalIssueSyncEvidence"),
    workItem: schemaRef("WorkItem"),
    bug: schemaRef("BugReport")
  }, ["link", "evidence"]),
  PatchPilotSnapshot: objectSchema({
    requirements: arrayOf(schemaRef("Requirement")),
    prds: arrayOf(schemaRef("Prd")),
    workItems: arrayOf(schemaRef("WorkItem")),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract")),
    agentRuns: arrayOf(schemaRef("AgentRun")),
    workspaceRuns: arrayOf(schemaRef("WorkspaceRun")),
    testCases: arrayOf(schemaRef("TestCase")),
    testRuns: arrayOf(schemaRef("TestRun")),
    artifacts: arrayOf(schemaRef("ArtifactRecord")),
    pullRequests: arrayOf(schemaRef("PullRequestRecord")),
    reviewRecords: arrayOf(schemaRef("ReviewRecord")),
    auditEvents: arrayOf(schemaRef("AuditEvent")),
    acceptances: arrayOf(schemaRef("AcceptanceDecision")),
    approvals: arrayOf(schemaRef("ApprovalRecord")),
    bugs: arrayOf(schemaRef("BugReport")),
    agents: arrayOf(schemaRef("AgentProfile"))
  })
} as const;
