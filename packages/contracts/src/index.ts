import type {
  AgentRole,
  AgentRun,
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

export const requirementInputSchema = z.object({
  rawInput: z.string().trim().min(3),
  template: z.enum(["feature", "bug", "ui", "document"])
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
  reporter: z.string().trim().optional()
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
    "AgentRun",
    "WorkspaceRun",
    "TestCase",
    "TestRun",
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
      tags: [operation.path.startsWith("/api/bugs") ? "Bugs" : operation.path.startsWith("/api/work-items") ? "Work Items" : "Control Plane"],
      summary: `${operation.method} ${operation.path}`,
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
        [responseStatusFor(operationId as ApiOperationId)]: responseFor(operation.response)
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

export function createInterfaceContracts(
  prd: Prd,
  status: InterfaceContractStatus = "approved",
  now = new Date().toISOString()
): InterfaceContract[] {
  return contractArtifacts.map((artifact) => ({
    id: `ic_${prd.requirementId}_${artifact.artifactId}`,
    prdId: prd.id,
    name: artifact.name,
    kind: artifact.kind,
    status,
    version: artifact.version,
    summary: artifact.summary,
    providerRole: artifact.providerRole as AgentRole,
    consumerRoles: [...artifact.consumerRoles] as AgentRole[],
    specMarkdown: renderContractMarkdown(artifact),
    testSuggestions: testSuggestionsFor(artifact.kind),
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

function hasRequestSchema(operation: (typeof httpApiContract.operations)[ApiOperationId]): operation is (typeof httpApiContract.operations)[ApiOperationId] & { request: string } {
  return "request" in operation;
}

function responseStatusFor(operationId: ApiOperationId) {
  return operationId === "createRequirement" ||
    operationId === "createBug" ||
    operationId === "createApproval" ||
    operationId === "startTeam" ||
    operationId === "startWorkItem"
    ? "201"
    : "200";
}

function isRequestBodyRequired(operationId: ApiOperationId) {
  return operationId !== "releaseWorkItem";
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
const approvalKind = enumSchema(approvalKinds);
const approvalStatus = enumSchema(["pending", "approved", "denied", "expired"]);
const approvalTargetType = enumSchema(approvalTargetTypes);
const approvalRiskLevel = enumSchema(approvalRiskLevels);

export const openApiSchemas = {
  HealthResponse: objectSchema({
    ok: { type: "boolean" },
    service: { type: "string" }
  }),
  RunEventError: objectSchema({
    message: { type: "string" }
  }),
  CreateRequirementRequest: objectSchema({
    rawInput: { type: "string", minLength: 3 },
    template: requirementTemplate
  }),
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
    reporter: { type: "string" }
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
    budget: schemaRef("RuntimeBudgetConfig")
  }, ["configuredRunner", "activeRunner", "codexAvailable", "gitWorkspaceAvailable", "testCommand", "workspaceRoot", "previewUrl", "configSource", "setup", "test", "smoke", "e2e", "dev", "security", "budget"]),
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
    codexBypass: { type: "boolean" }
  }),
  RuntimeBudgetConfig: objectSchema({
    codexTimeoutMs: { type: "number" },
    maxCostUsd: { type: "number" },
    prdUsd: { type: "number" },
    workItemUsd: { type: "number" },
    runUsd: { type: "number" },
    softThresholdRatio: { type: "number" }
  }),
  Requirement: looseObjectSchema({
    id,
    title: { type: "string" },
    rawInput: { type: "string" },
    template: requirementTemplate,
    status: enumSchema(["submitted", "clarifying", "prd_draft", "approved", "rejected"]),
    simpleSummary: { type: "string" },
    clarificationQuestions: arrayOf(schemaRef("ClarificationQuestion")),
    clarificationTurns: arrayOf(schemaRef("ClarificationTurn")),
    createdAt: isoDate,
    updatedAt: isoDate
  }),
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
    createdAt: isoDate,
    updatedAt: isoDate
  }),
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
    failureSummary: { type: "string" },
    budgetUsd: { type: "number", minimum: 0 },
    budgetSoftThresholdUsd: { type: "number", minimum: 0 },
    budgetApprovalId: id,
    costEstimateUsd: { type: "number" },
    costActualUsd: { type: "number" },
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
  AgentRunResult: looseObjectSchema({
    summary: { type: "string" },
    previewUrl: { type: "string" },
    riskLevel: enumSchema(["low", "medium", "high"]),
    changedFiles: arrayOf({ type: "string" }),
    tests: arrayOf(schemaRef("TestRun")),
    reviewerSummary: { type: "string" },
    runner: runnerKind,
    workspacePath: { type: "string" },
    branchName: { type: "string" },
    baseBranch: { type: "string" },
    baseCommit: { type: "string" },
    headCommit: { type: "string" },
    codexSessionId: { type: "string" }
  }, ["summary", "previewUrl", "riskLevel", "changedFiles", "tests", "reviewerSummary", "runner"]),
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
    flakySignal: { type: "boolean" }
  }, ["id", "status", "command", "summary", "durationMs"]),
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
    actor: { type: "string" },
    action: { type: "string" },
    targetType: { type: "string" },
    targetId: id,
    message: { type: "string" },
    createdAt: isoDate
  }),
  BugReport: looseObjectSchema({
    id,
    title: { type: "string" },
    description: { type: "string" },
    reproductionSteps: { type: "string" },
    expectedBehavior: { type: "string" },
    actualBehavior: { type: "string" },
    severity: enumSchema(["low", "medium", "high", "critical"]),
    status: enumSchema(["reported", "confirmed", "fixing", "fixed", "rejected"]),
    reporter: { type: "string" },
    requirementId: id,
    prdId: id,
    workItemId: id
  }),
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
  PatchPilotSnapshot: objectSchema({
    requirements: arrayOf(schemaRef("Requirement")),
    prds: arrayOf(schemaRef("Prd")),
    workItems: arrayOf(schemaRef("WorkItem")),
    interfaceContracts: arrayOf(schemaRef("InterfaceContract")),
    agentRuns: arrayOf(schemaRef("AgentRun")),
    workspaceRuns: arrayOf(schemaRef("WorkspaceRun")),
    testCases: arrayOf(schemaRef("TestCase")),
    testRuns: arrayOf(schemaRef("TestRun")),
    pullRequests: arrayOf(schemaRef("PullRequestRecord")),
    reviewRecords: arrayOf(schemaRef("ReviewRecord")),
    auditEvents: arrayOf(schemaRef("AuditEvent")),
    acceptances: arrayOf(schemaRef("AcceptanceDecision")),
    approvals: arrayOf(schemaRef("ApprovalRecord")),
    bugs: arrayOf(schemaRef("BugReport")),
    agents: arrayOf(schemaRef("AgentProfile"))
  })
} as const;
