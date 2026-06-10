import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductMetricsDashboard } from "./ProductMetricsDashboard";
import type { ProductMetricsDashboard as ProductMetrics } from "@/lib/productMetrics";

describe("ProductMetricsDashboard", () => {
  it("renders the metrics dashboard values and failure reasons", () => {
    const html = renderToStaticMarkup(createElement(ProductMetricsDashboard, { metrics: metricsFixture() }));

    expect(html).toContain("成本和产品指标");
    expect(html).toContain("需求到 PR 时间");
    expect(html).toContain("自主完成率");
    expect(html).toContain("成本 / 接受 PR");
    expect(html).toContain("$3.90");
    expect(html).toContain("测试失败");
    expect(html).toContain("审计完整率");
  });

  it("renders an empty state before snapshot data is available", () => {
    const html = renderToStaticMarkup(createElement(ProductMetricsDashboard, { metrics: null }));

    expect(html).toContain("正在等待 snapshot");
  });
});

function metricsFixture(): ProductMetrics {
  return {
    requirementToPr: {
      averageMs: 86_400_000,
      count: 1,
      samples: [{ requirementId: "req_1", pullRequestId: "pr_1", durationMs: 86_400_000 }]
    },
    autonomousCompletion: { numerator: 1, denominator: 2, rate: 50 },
    firstTestPass: { numerator: 2, denominator: 2, rate: 100 },
    humanInterventions: {
      total: 2,
      approvalCount: 1,
      acceptanceDecisionCount: 1,
      rejectionCount: 0
    },
    failureReasons: [{ key: "test_failed", count: 1, costUsd: 0.5 }],
    costPerAcceptedPr: {
      valueUsd: 3.9,
      totalCostUsd: 3.9,
      acceptedPrCount: 1
    },
    reproductionSuccess: { numerator: 1, denominator: 1, rate: 100 },
    auditCompleteness: {
      numerator: 9,
      denominator: 10,
      rate: 90,
      checkedEvents: 12,
      chainValid: true,
      missingTargets: [{ type: "agent_run", id: "run_missing" }]
    },
    reworkRounds: {
      total: 1,
      average: 0.5,
      max: 1,
      workItemCount: 2
    },
    finalAcceptance: { numerator: 1, denominator: 1, rate: 100 }
  };
}
