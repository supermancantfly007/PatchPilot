import type {
  AcceptanceDecision,
  AgentRun,
  PatchPilotSnapshot,
  Prd,
  Requirement,
  RequirementTemplate,
  WorkItem
} from "@patchpilot/domain";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {})
    },
    cache: "no-store"
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
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
  getRequirement(id: string) {
    return request<{ requirement: Requirement; prd?: Prd; workItems: WorkItem[] }>(`/api/requirements/${id}`);
  },
  answerClarification(id: string, answers: Record<string, string>) {
    return request<{ requirement: Requirement; prd: Prd }>(`/api/requirements/${id}/clarification-answer`, {
      method: "POST",
      body: JSON.stringify({ answers })
    });
  },
  approvePrd(id: string) {
    return request<{ prd: Prd; workItems: WorkItem[] }>(`/api/prds/${id}/approve`, { method: "POST" });
  },
  startRun(workItemId: string) {
    return request<AgentRun>(`/api/work-items/${workItemId}/start`, { method: "POST" });
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
  getSnapshot() {
    return request<PatchPilotSnapshot>("/api/snapshot");
  },
  eventSourceUrl(runId: string) {
    return `${API_BASE}/api/runs/${runId}/events`;
  }
};
