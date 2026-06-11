import type {
  AcceptanceDecision,
  AgentRun,
  ApprovalRecord,
  AuditChainVerification,
  BugReport,
  ClarificationQuestion,
  IntakeArtifactReference,
  InterfaceContract,
  PatchPilotSnapshot,
  Prd,
  Requirement,
  RequirementTemplate,
  RuntimeConfig,
  WorkItem
} from "@patchpilot/domain";
import { apiPath, authRoleHeader, authUserHeader } from "@patchpilot/contracts";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";
const AUTH_USER = process.env.NEXT_PUBLIC_PATCHPILOT_USER_ID?.trim();
const AUTH_ROLE = process.env.NEXT_PUBLIC_PATCHPILOT_ROLE?.trim();

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (AUTH_USER && AUTH_ROLE) {
    headers.set(authUserHeader, AUTH_USER);
    headers.set(authRoleHeader, AUTH_ROLE);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    cache: "no-store"
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text || `Request failed: ${response.status}`;
    try {
      const payload = JSON.parse(text) as { message?: string; error?: string };
      message = payload.message || payload.error || message;
    } catch {
      // Keep the raw response text when the server did not return JSON.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  createRequirement(rawInput: string, template: RequirementTemplate, artifactReferences: IntakeArtifactReference[] = []) {
    return request<Requirement>(apiPath("createRequirement"), {
      method: "POST",
      body: JSON.stringify({ rawInput, template, artifactReferences })
    });
  },
  createBug(input: {
    title: string;
    description: string;
    reproductionSteps: string;
    expectedBehavior: string;
    actualBehavior: string;
    severity?: BugReport["severity"];
    reporter?: string;
    artifactReferences?: IntakeArtifactReference[];
  }) {
    return request<{ bug: BugReport; requirement: Requirement; prd: Prd; workItem: WorkItem }>(apiPath("createBug"), {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getRequirement(id: string) {
    return request<{ requirement: Requirement; prd?: Prd; workItems: WorkItem[]; interfaceContracts: InterfaceContract[] }>(
      apiPath("getRequirement", { id })
    );
  },
  answerClarification(id: string, answers: Record<string, string>) {
    return request<{ requirement: Requirement; prd: Prd; interfaceContracts: InterfaceContract[] }>(
      apiPath("answerClarification", { id }),
      {
        method: "POST",
        body: JSON.stringify({ answers })
      }
    );
  },
  addClarificationTurn(id: string, message: string) {
    return request<{ requirement: Requirement; nextQuestion: ClarificationQuestion }>(
      apiPath("addClarificationTurn", { id }),
      {
        method: "POST",
        body: JSON.stringify({ message })
      }
    );
  },
  createPrdFromClarification(id: string) {
    return request<{ requirement: Requirement; prd: Prd; interfaceContracts: InterfaceContract[] }>(
      apiPath("createPrd", { id }),
      {
        method: "POST"
      }
    );
  },
  approvePrd(id: string) {
    return request<{ prd: Prd; workItems: WorkItem[]; interfaceContracts: InterfaceContract[] }>(
      apiPath("approvePrd", { id }),
      { method: "POST" }
    );
  },
  startTeam(prdId: string, runner?: AgentRun["runner"]) {
    return request<{
      prd: Prd;
      workItems: WorkItem[];
      interfaceContracts: InterfaceContract[];
      runs: AgentRun[];
      skippedWorkItems: WorkItem[];
    }>(apiPath("startTeam", { id: prdId }), {
      method: "POST",
      body: JSON.stringify({ runner })
    });
  },
  startRun(workItemId: string, runner?: AgentRun["runner"]) {
    return request<AgentRun>(apiPath("startWorkItem", { id: workItemId }), {
      method: "POST",
      body: JSON.stringify({ runner })
    });
  },
  getRun(id: string) {
    return request<AgentRun>(apiPath("getRun", { id }));
  },
  approveApproval(id: string, decisionReason = "Approved from PatchPilot professional mode.") {
    return request<ApprovalRecord>(apiPath("approveApproval", { id }), {
      method: "POST",
      body: JSON.stringify({ decidedBy: "professional-mode-ui", decisionReason })
    });
  },
  denyApproval(id: string, decisionReason = "Denied from PatchPilot professional mode.") {
    return request<ApprovalRecord>(apiPath("denyApproval", { id }), {
      method: "POST",
      body: JSON.stringify({ decidedBy: "professional-mode-ui", decisionReason })
    });
  },
  acceptRun(runId: string, status: AcceptanceDecision["status"], reason?: string) {
    return request<AcceptanceDecision>(apiPath("acceptRun", { runId }), {
      method: "POST",
      body: JSON.stringify({ status, reason })
    });
  },
  acceptTeam(prdId: string, status: AcceptanceDecision["status"], reason?: string) {
    return request<{ decisions: AcceptanceDecision[]; workItems: WorkItem[]; runs: AgentRun[] }>(
      apiPath("acceptTeam", { id: prdId }),
      {
        method: "POST",
        body: JSON.stringify({ status, reason })
      }
    );
  },
  getSnapshot() {
    return request<PatchPilotSnapshot>(apiPath("snapshot"));
  },
  verifyAudit() {
    return request<AuditChainVerification>(apiPath("verifyAudit"));
  },
  getConfig() {
    return request<RuntimeConfig>(apiPath("getConfig"));
  },
  eventSourceUrl(runId: string) {
    return `${API_BASE}${apiPath("streamRunEvents", { id: runId })}`;
  }
};
