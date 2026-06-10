import { describe, expect, it } from "vitest";
import {
  approvalRiskTone,
  approvalStatusLabels,
  approvalStatusTone,
  failureTypeLabels,
  formatCost,
  formatCostMode,
  relatedApprovalsForRun,
  runBudgetUsage
} from "./professionalMode";

describe("professional mode helpers", () => {
  it("formats actual and estimated costs distinctly", () => {
    expect(formatCost({ costActualUsd: 0.38, costEstimateUsd: 0.42 })).toBe("$0.38");
    expect(formatCostMode({ costActualUsd: 0.38 })).toBe("实际成本");
    expect(formatCost({ costEstimateUsd: 0.42 })).toBe("$0.42");
    expect(formatCostMode({})).toBe("估算成本");
  });

  it("classifies run budget usage", () => {
    expect(runBudgetUsage({ budgetUsd: 1, budgetSoftThresholdUsd: 0.8, costEstimateUsd: 0.42 })).toMatchObject({
      label: "预算内",
      percent: 42,
      tone: "green"
    });
    expect(runBudgetUsage({ budgetUsd: 1, budgetSoftThresholdUsd: 0.8, costEstimateUsd: 0.84 })).toMatchObject({
      label: "已触发软阈值",
      percent: 84,
      tone: "amber"
    });
    expect(runBudgetUsage({ budgetUsd: 0.2, budgetSoftThresholdUsd: 0.16, costEstimateUsd: 0.42 })).toMatchObject({
      label: "已超过预算",
      percent: 100,
      tone: "red"
    });
  });

  it("maps approval and failure states for professional views", () => {
    expect(approvalStatusLabels.pending).toBe("待处理");
    expect(approvalStatusTone("approved")).toBe("green");
    expect(approvalStatusTone("denied")).toBe("red");
    expect(approvalRiskTone("critical")).toBe("red");
    expect(failureTypeLabels.budget_exhausted).toBe("预算耗尽");
  });

  it("finds approvals linked directly or through a run budget approval id", () => {
    const approvals = [
      { id: "approval_direct", targetId: "other", runId: "run_1" },
      { id: "approval_target", targetId: "run_1" },
      { id: "approval_budget", targetId: "budget" },
      { id: "approval_other", targetId: "run_2", runId: "run_2" }
    ];

    expect(
      relatedApprovalsForRun(approvals, { id: "run_1", budgetApprovalId: "approval_budget" }).map((approval) => approval.id)
    ).toEqual(["approval_direct", "approval_target", "approval_budget"]);
  });
});
