import { describe, expect, it } from "vitest";
import {
  apiPath,
  apiRoute,
  buildContractRegistryArtifacts,
  buildContractTestRequirements,
  contractArtifacts,
  contractVersion,
  createContractRegistryMetadata,
  createInterfaceContracts,
  diffContractRegistryArtifacts,
  hashNormalizedContent,
  httpApiContract,
  renderContractMarkdown,
  runEventStreamContract,
  sharedStateContract,
  type ApiOperationId,
  type RunEventTerminalStatus,
  type SharedStateSchemaName
} from "./index";
import type { Prd } from "@patchpilot/domain";

describe("contract artifacts", () => {
  it("publishes versioned HTTP, event, and shared-state artifacts", () => {
    expect(contractVersion).toBe("patchpilot.mvp.v1");
    expect(contractArtifacts.map((artifact) => artifact.kind)).toEqual(["http", "event", "schema"]);
    expect(httpApiContract.operations.createRequirement.path).toBe("/api/requirements");
    expect(httpApiContract.operations.createApproval.path).toBe("/api/approvals");
    expect(httpApiContract.operations.exportPrdAuditPackage.path).toBe("/api/prds/:id/audit-export");
    expect(httpApiContract.operations.metrics.path).toBe("/metrics");
    expect(runEventStreamContract.stream.payload).toBe("AgentRun");
    expect(sharedStateContract.rootSchema).toBe("PatchPilotSnapshot");
    expect(sharedStateContract.schemas).toContain("IntakeArtifactReference");
    expect(sharedStateContract.schemas).toContain("ApprovalRecord");
  });

  it("derives operation and schema types from the artifacts", () => {
    const operation: ApiOperationId = "approveApproval";
    const terminalStatus: RunEventTerminalStatus = "succeeded";
    const schema: SharedStateSchemaName = "ApprovalRecord";

    expect(apiRoute(operation)).toBe("/api/approvals/:id/approve");
    expect(apiRoute("exportPrdAuditPackage")).toBe("/api/prds/:id/audit-export");
    expect(terminalStatus).toBe("succeeded");
    expect(schema).toBe("ApprovalRecord");
  });

  it("builds concrete API paths from route artifacts", () => {
    expect(apiPath("claimWorkItem", { id: "wi backend/1" })).toBe("/api/work-items/wi%20backend%2F1/claim");
    expect(apiPath("denyApproval", { id: "approval budget/1" })).toBe("/api/approvals/approval%20budget%2F1/deny");
    expect(apiPath("exportPrdAuditPackage", { id: "prd audit/1" })).toBe("/api/prds/prd%20audit%2F1/audit-export");
    expect(() => apiPath("claimWorkItem")).toThrow('Missing API path parameter "id"');
  });

  it("renders InterfaceContract records from artifacts", () => {
    const contracts = createInterfaceContracts(prd, "draft", "2026-06-10T00:00:00.000Z");

    expect(contracts).toHaveLength(3);
    expect(contracts.map((contract) => contract.kind)).toEqual(["http", "event", "schema"]);
    expect(contracts.every((contract) => contract.status === "draft")).toBe(true);
    expect(contracts.every((contract) => contract.prdId === prd.id)).toBe(true);
    expect(contracts[0]?.specMarkdown).toContain("Contract version: `patchpilot.mvp.v1`");
    expect(contracts[0]?.specMarkdown).toContain("POST /api/requirements");
    expect(contracts[1]?.specMarkdown).toContain("Terminal statuses");
  });

  it("renders markdown directly from each artifact", () => {
    expect(renderContractMarkdown(httpApiContract)).toContain("GET /api/snapshot");
    expect(renderContractMarkdown(httpApiContract)).toContain("GET /api/prds/:id/audit-export");
    expect(renderContractMarkdown(httpApiContract)).toContain("GET /metrics");
    expect(renderContractMarkdown(runEventStreamContract)).toContain("data: AgentRun");
    expect(renderContractMarkdown(sharedStateContract)).toContain("PatchPilotSnapshot");
  });

  it("builds registry artifacts with normalized hashes and provider-consumer ownership", () => {
    const registryArtifacts = buildContractRegistryArtifacts();

    expect(registryArtifacts).toHaveLength(3);
    expect(registryArtifacts[0]).toMatchObject({
      artifactId: "control-api",
      kind: "http",
      providerRole: "backend",
      consumerRoles: ["frontend", "test", "ops"],
      generatorVersion: contractVersion
    });
    expect(registryArtifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.contentHash))).toBe(true);
  });

  it("generates provider and consumer contract test requirements for every artifact", () => {
    const requirements = buildContractRegistryArtifacts().flatMap((artifact) => buildContractTestRequirements(artifact));

    expect(requirements.filter((requirement) => requirement.requirementKind === "registry_diff")).toHaveLength(3);
    expect(requirements.filter((requirement) => requirement.requirementKind === "provider_validation")).toHaveLength(3);
    expect(requirements.map((requirement) => requirement.command)).toEqual(
      expect.arrayContaining([
        "pnpm openapi:check && pnpm --filter @patchpilot/api test -- server.test.ts",
        "pnpm events:check && pnpm --filter @patchpilot/api test -- server.test.ts"
      ])
    );
    expect(requirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: "control-api",
          requirementKind: "consumer_compatibility",
          participantLabel: "frontend consumer",
          command: "pnpm --filter @patchpilot/web test"
        }),
        expect.objectContaining({
          artifactId: "control-api",
          requirementKind: "consumer_compatibility",
          participantLabel: "worker consumer",
          command: "pnpm --filter @patchpilot/worker test"
        }),
        expect.objectContaining({
          artifactId: "delivery-state",
          requirementKind: "consumer_compatibility",
          participantLabel: "worker consumer",
          command: "pnpm --filter @patchpilot/worker test"
        })
      ])
    );
  });

  it("classifies removed HTTP operations as breaking contract diffs", () => {
    const artifact = buildContractRegistryArtifacts().find((candidate) => candidate.kind === "http");
    if (!artifact) throw new Error("Expected HTTP registry artifact");
    const baseline = createContractRegistryMetadata({
      proposed: artifact,
      proposedRevisionId: "cr_control-api_r1",
      revision: 1,
      now: "2026-06-10T00:00:00.000Z"
    });
    const proposedContent = cloneRecord(artifact.normalizedContent);
    delete (proposedContent.paths as Record<string, unknown>)["/api/requirements"];
    const diff = diffContractRegistryArtifacts({
      baseline,
      proposed: {
        ...artifact,
        normalizedContent: proposedContent,
        contentHash: hashNormalizedContent(proposedContent)
      },
      proposedRevisionId: "cr_control-api_r2",
      now: "2026-06-10T00:01:00.000Z"
    });

    expect(diff.status).toBe("breaking");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "breaking",
          changeType: "http.operation_removed",
          path: "paths./api/requirements.post"
        })
      ])
    );
  });

  it("classifies event required field removals as breaking contract diffs", () => {
    const artifact = buildContractRegistryArtifacts().find((candidate) => candidate.kind === "event");
    if (!artifact) throw new Error("Expected event registry artifact");
    const baseline = createContractRegistryMetadata({
      proposed: artifact,
      proposedRevisionId: "cr_run-events_r1",
      revision: 1,
      now: "2026-06-10T00:00:00.000Z"
    });
    const proposedContent = cloneRecord(artifact.normalizedContent);
    const message = ((proposedContent.envelope as Record<string, unknown>).message ?? {}) as Record<string, unknown>;
    message.requiredFields = (message.requiredFields as string[]).filter((field) => field !== "events");
    const diff = diffContractRegistryArtifacts({
      baseline,
      proposed: {
        ...artifact,
        normalizedContent: proposedContent,
        contentHash: hashNormalizedContent(proposedContent)
      },
      proposedRevisionId: "cr_run-events_r2"
    });

    expect(diff.status).toBe("breaking");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "breaking",
          changeType: "event.required_field_removed",
          path: "event.requiredFields.events"
        })
      ])
    );
  });

  it("classifies removed shared schemas as breaking contract diffs", () => {
    const artifact = buildContractRegistryArtifacts().find((candidate) => candidate.kind === "schema");
    if (!artifact) throw new Error("Expected shared schema registry artifact");
    const baseline = createContractRegistryMetadata({
      proposed: artifact,
      proposedRevisionId: "cr_delivery-state_r1",
      revision: 1,
      now: "2026-06-10T00:00:00.000Z"
    });
    const proposedContent = cloneRecord(artifact.normalizedContent);
    const components = proposedContent.components as { schemas: Record<string, unknown> };
    delete components.schemas.AgentRun;
    const diff = diffContractRegistryArtifacts({
      baseline,
      proposed: {
        ...artifact,
        normalizedContent: proposedContent,
        contentHash: hashNormalizedContent(proposedContent)
      },
      proposedRevisionId: "cr_delivery-state_r2"
    });

    expect(diff.status).toBe("breaking");
    expect(diff.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "breaking",
          changeType: "schema.removed",
          path: "shared.components.schemas.AgentRun"
        })
      ])
    );
  });
});

const prd: Prd = {
  id: "prd_req_contract",
  requirementId: "req_contract",
  version: 1,
  status: "approved",
  title: "Contract package",
  bodyMarkdown: "# Contract package",
  acceptanceCriteria: ["Contracts are versioned"],
  approvedAt: "2026-06-10T00:00:00.000Z"
};

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
