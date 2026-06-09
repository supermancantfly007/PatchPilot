import type {
  AcceptanceDecision,
  AgentRun,
  BugReport,
  ClarificationQuestion,
  InterfaceContract,
  PatchPilotSnapshot,
  Prd,
  Requirement,
  RequirementTemplate,
  RuntimeConfig,
  WorkItem
} from "@patchpilot/domain";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
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
  createRequirement(rawInput: string, template: RequirementTemplate) {
    return request<Requirement>("/api/requirements", {
      method: "POST",
      body: JSON.stringify({ rawInput, template })
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
  }) {
    return request<{ bug: BugReport; requirement: Requirement; prd: Prd; workItem: WorkItem }>("/api/bugs", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getRequirement(id: string) {
    return request<{ requirement: Requirement; prd?: Prd; workItems: WorkItem[]; interfaceContracts: InterfaceContract[] }>(
      `/api/requirements/${id}`
    );
  },
  answerClarification(id: string, answers: Record<string, string>) {
    return request<{ requirement: Requirement; prd: Prd; interfaceContracts: InterfaceContract[] }>(
      `/api/requirements/${id}/clarification-answer`,
      {
        method: "POST",
        body: JSON.stringify({ answers })
      }
    );
  },
  addClarificationTurn(id: string, message: string) {
    return request<{ requirement: Requirement; nextQuestion: ClarificationQuestion }>(
      `/api/requirements/${id}/clarification-turn`,
      {
      method: "POST",
      body: JSON.stringify({ message })
      }
    );
  },
  createPrdFromClarification(id: string) {
    return request<{ requirement: Requirement; prd: Prd; interfaceContracts: InterfaceContract[] }>(
      `/api/requirements/${id}/prd`,
      {
        method: "POST"
      }
    );
  },
  approvePrd(id: string) {
    return request<{ prd: Prd; workItems: WorkItem[]; interfaceContracts: InterfaceContract[] }>(
      `/api/prds/${id}/approve`,
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
    }>(`/api/prds/${prdId}/start-team`, {
      method: "POST",
      body: JSON.stringify({ runner })
    });
  },
  startRun(workItemId: string, runner?: AgentRun["runner"]) {
    return request<AgentRun>(`/api/work-items/${workItemId}/start`, {
      method: "POST",
      body: JSON.stringify({ runner })
    });
  },
  getRun(id: string) {
    return request<AgentRun>(`/api/runs/${id}`);
  },
  acceptRun(runId: string, status: AcceptanceDecision["status"], reason?: string) {
    return request<AcceptanceDecision>(`/api/acceptance/${runId}`, {
      method: "POST",
      body: JSON.stringify({ status, reason })
    });
  },
  acceptTeam(prdId: string, status: AcceptanceDecision["status"], reason?: string) {
    return request<{ decisions: AcceptanceDecision[]; workItems: WorkItem[]; runs: AgentRun[] }>(
      `/api/prds/${prdId}/acceptance`,
      {
        method: "POST",
        body: JSON.stringify({ status, reason })
      }
    );
  },
  getSnapshot() {
    return request<PatchPilotSnapshot>("/api/snapshot");
  },
  getConfig() {
    return request<RuntimeConfig>("/api/config");
  },
  eventSourceUrl(runId: string) {
    return `${API_BASE}/api/runs/${runId}/events`;
  }
};
