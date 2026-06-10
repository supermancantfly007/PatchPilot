import type { AgentRun, ApprovalRecord, FailureType } from "@patchpilot/domain";

export const approvalKindLabels: Record<ApprovalRecord["kind"], string> = {
  prd_approval: "PRD 批准",
  budget_exceeded: "预算超限",
  dangerous_operation: "危险操作",
  breaking_contract: "破坏性契约变更",
  network_allowlist_change: "网络放行",
  secret_grant: "密钥授权",
  production_data_access: "生产数据访问"
};

export const approvalStatusLabels: Record<ApprovalRecord["status"], string> = {
  pending: "待处理",
  approved: "已批准",
  denied: "已拒绝",
  expired: "已过期"
};

export const approvalRiskLabels: Record<ApprovalRecord["riskLevel"], string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
  critical: "关键风险"
};

export const approvalTargetLabels: Record<ApprovalRecord["targetType"], string> = {
  prd: "PRD",
  work_item: "工作项",
  agent_run: "Agent Run",
  interface_contract: "接口契约",
  budget: "预算",
  policy: "策略",
  secret: "密钥",
  network: "网络",
  repository: "仓库"
};

export const failureTypeLabels: Record<FailureType, string> = {
  transient: "暂时性失败",
  deterministic: "确定性失败",
  test_failed: "测试失败",
  policy_denied: "策略拒绝",
  budget_exhausted: "预算耗尽",
  environment_failed: "环境失败"
};

export type Tone = "green" | "blue" | "amber" | "red";

export function approvalStatusTone(status: ApprovalRecord["status"]): Tone {
  if (status === "approved") return "green";
  if (status === "denied" || status === "expired") return "red";
  return "amber";
}

export function approvalRiskTone(riskLevel: ApprovalRecord["riskLevel"]): Tone {
  if (riskLevel === "critical" || riskLevel === "high") return "red";
  if (riskLevel === "medium") return "amber";
  return "blue";
}

export function failureTypeTone(failureType?: FailureType): Tone {
  if (!failureType) return "blue";
  if (failureType === "transient") return "amber";
  if (failureType === "environment_failed") return "amber";
  return "red";
}

export function formatCurrency(value?: number) {
  if (value === undefined) return "未设置";
  return `$${value.toFixed(2)}`;
}

export function formatCost(run: Pick<AgentRun, "costActualUsd" | "costEstimateUsd">) {
  return formatCurrency(run.costActualUsd ?? run.costEstimateUsd);
}

export function formatCostMode(run: Pick<AgentRun, "costActualUsd">) {
  return run.costActualUsd === undefined ? "估算成本" : "实际成本";
}

export function runBudgetUsage(run: Pick<AgentRun, "budgetUsd" | "budgetSoftThresholdUsd" | "costActualUsd" | "costEstimateUsd">) {
  const spendUsd = run.costActualUsd ?? run.costEstimateUsd;
  if (run.budgetUsd === undefined || run.budgetUsd <= 0) {
    return {
      label: "未设置运行预算",
      percent: 0,
      spendUsd,
      tone: "blue" as Tone
    };
  }

  const percent = Math.min(100, Math.round((spendUsd / run.budgetUsd) * 100));
  if (spendUsd > run.budgetUsd) {
    return {
      label: "已超过预算",
      percent,
      spendUsd,
      tone: "red" as Tone
    };
  }
  if (run.budgetSoftThresholdUsd !== undefined && spendUsd >= run.budgetSoftThresholdUsd) {
    return {
      label: "已触发软阈值",
      percent,
      spendUsd,
      tone: "amber" as Tone
    };
  }
  return {
    label: "预算内",
    percent,
    spendUsd,
    tone: "green" as Tone
  };
}

export function relatedApprovalsForRun<T extends Pick<ApprovalRecord, "id" | "targetId"> & { runId?: string }>(
  approvals: T[],
  run: Pick<AgentRun, "id" | "budgetApprovalId">
) {
  return approvals.filter((approval) => approval.runId === run.id || approval.targetId === run.id || approval.id === run.budgetApprovalId);
}

export function approvalShortId(approvalId: string) {
  return approvalId.replace(/^approval_/, "").slice(0, 8);
}

export function runShortId(runId: string) {
  return runId.replace(/^run_/, "").slice(0, 8);
}
