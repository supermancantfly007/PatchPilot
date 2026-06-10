import { describe, expect, it } from "vitest";
import {
  apiPath,
  apiRoute,
  contractArtifacts,
  contractVersion,
  createInterfaceContracts,
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
    expect(runEventStreamContract.stream.payload).toBe("AgentRun");
    expect(sharedStateContract.rootSchema).toBe("PatchPilotSnapshot");
    expect(sharedStateContract.schemas).toContain("ApprovalRecord");
  });

  it("derives operation and schema types from the artifacts", () => {
    const operation: ApiOperationId = "approveApproval";
    const terminalStatus: RunEventTerminalStatus = "succeeded";
    const schema: SharedStateSchemaName = "ApprovalRecord";

    expect(apiRoute(operation)).toBe("/api/approvals/:id/approve");
    expect(terminalStatus).toBe("succeeded");
    expect(schema).toBe("ApprovalRecord");
  });

  it("builds concrete API paths from route artifacts", () => {
    expect(apiPath("claimWorkItem", { id: "wi backend/1" })).toBe("/api/work-items/wi%20backend%2F1/claim");
    expect(apiPath("denyApproval", { id: "approval budget/1" })).toBe("/api/approvals/approval%20budget%2F1/deny");
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
    expect(renderContractMarkdown(runEventStreamContract)).toContain("data: AgentRun");
    expect(renderContractMarkdown(sharedStateContract)).toContain("PatchPilotSnapshot");
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
