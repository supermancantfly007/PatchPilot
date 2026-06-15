import { describe, expect, it } from "vitest";
import { prometheusMetricNames, renderPrometheusMetrics, type PrometheusMetricsSnapshot } from "./prometheus";

describe("Prometheus metrics renderer", () => {
  it("renders stable Prometheus-compatible names and low-cardinality labels", () => {
    const snapshot: PrometheusMetricsSnapshot = {
      agentRuns: [
        {
          runner: "codex",
          status: "succeeded",
          startedAt: "2026-06-10T00:00:00.000Z",
          endedAt: "2026-06-10T00:00:04.000Z",
          costEstimateUsd: 0.42,
          costActualUsd: 0.38
        },
        {
          runner: "codex",
          status: "failed",
          failureType: "test_failed",
          startedAt: "2026-06-10T00:01:00.000Z",
          endedAt: "2026-06-10T00:01:12.000Z",
          costEstimateUsd: 0.55
        },
        {
          runner: "codex",
          status: "running",
          startedAt: "2026-06-10T00:02:00.000Z",
          costEstimateUsd: 0.42
        }
      ],
      workItems: [
        { role: "backend", status: "ready" },
        { role: "test", status: "blocked" }
      ],
      testRuns: [
        { status: "passed" },
        { status: "failed" },
        { status: "running" }
      ],
      acceptances: [
        { status: "accepted" },
        { status: "rejected" }
      ]
    };

    const text = renderPrometheusMetrics(snapshot);

    expect(text).toContain(`# HELP ${prometheusMetricNames.runDurationSeconds}`);
    expect(text).toContain(`# TYPE ${prometheusMetricNames.runDurationSeconds} histogram`);
    expect(text).toContain(
      'patchpilot_agent_run_duration_seconds_bucket{runner="codex",status="succeeded",le="5"} 1'
    );
    expect(text).toContain('patchpilot_agent_run_duration_seconds_count{runner="codex",status="failed"} 1');
    expect(text).toContain('patchpilot_agent_run_failures_total{runner="codex",failure_type="test_failed"} 1');
    expect(text).toContain('patchpilot_work_item_queue_depth{role="backend",status="ready"} 1');
    expect(text).toContain('patchpilot_agent_run_cost_estimate_usd{runner="codex",status="failed"} 0.55');
    expect(text).toContain('patchpilot_agent_run_cost_actual_usd{runner="codex",status="succeeded"} 0.38');
    expect(text).toContain('patchpilot_test_runs_total{status="passed"} 1');
    expect(text).toContain("patchpilot_test_pass_rate_ratio 0.5");
    expect(text).toContain('patchpilot_acceptance_decisions_total{status="accepted"} 1');
    expect(text).toContain("patchpilot_acceptance_rate_ratio 0.5");
    expect(text).not.toMatch(/run_id="/);
  });

  it("keeps zero-valued metric series available before any runs exist", () => {
    const text = renderPrometheusMetrics({
      agentRuns: [],
      workItems: [],
      testRuns: [],
      acceptances: []
    });

    expect(text).toContain('patchpilot_agent_run_duration_seconds_count{runner="codex",status="succeeded"} 0');
    expect(text).toContain('patchpilot_agent_run_failures_total{runner="codex",failure_type="test_failed"} 0');
    expect(text).toContain('patchpilot_work_item_queue_depth{role="backend",status="ready"} 0');
    expect(text).toContain("patchpilot_test_pass_rate_ratio 0");
    expect(text).toContain("patchpilot_acceptance_rate_ratio 0");
  });
});
