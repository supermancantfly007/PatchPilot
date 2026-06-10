import { describe, expect, it } from "vitest";
import {
  createInMemoryTelemetry,
  readTelemetryConfig,
  telemetryAttributes,
  type AgentRunTelemetryInput
} from "./index";

describe("PatchPilot telemetry", () => {
  it("is disabled by default and can be enabled for OTLP HTTP export", () => {
    expect(readTelemetryConfig({ serviceName: "patchpilot-api", env: {} })).toMatchObject({
      enabled: false,
      exporter: "none",
      serviceName: "patchpilot-api"
    });

    expect(
      readTelemetryConfig({
        serviceName: "patchpilot-api",
        env: {
          PATCHPILOT_OTEL_ENABLED: "false",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318"
        }
      })
    ).toMatchObject({
      enabled: false,
      exporter: "none"
    });

    expect(
      readTelemetryConfig({
        serviceName: "patchpilot-api",
        env: {
          PATCHPILOT_OTEL_ENABLED: "true",
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318"
        }
      })
    ).toMatchObject({
      enabled: true,
      exporter: "otlp",
      traceEndpoint: "http://collector:4318/v1/traces",
      metricEndpoint: "http://collector:4318/v1/metrics",
      logEndpoint: "http://collector:4318/v1/logs"
    });
  });

  it("normalizes correlation attributes with a PRD workflow proxy", () => {
    expect(
      telemetryAttributes({
        requirementId: "req_1",
        prdId: "prd_1",
        workItemId: "wi_1",
        agentRunId: "run_1",
        testRunId: "test_1"
      })
    ).toMatchObject({
      "patchpilot.workflow.id": "prd_1",
      "patchpilot.workflow.proxy": "prd",
      "patchpilot.requirement.id": "req_1",
      "patchpilot.prd.id": "prd_1",
      "patchpilot.work_item.id": "wi_1",
      "patchpilot.agent_run.id": "run_1",
      "patchpilot.test_run.id": "test_1"
    });
  });

  it("records in-memory traces, metrics, and logs for a correlated run", async () => {
    const telemetry = createInMemoryTelemetry();
    const run: AgentRunTelemetryInput = {
      id: "run_1",
      requirementId: "req_1",
      prdId: "prd_1",
      workItemId: "wi_1",
      runner: "simulated",
      status: "running",
      currentStep: "planning",
      costEstimateUsd: 0.42,
      startedAt: "2026-06-10T00:00:00.000Z"
    };

    try {
      telemetry.startAgentRun(run);
      telemetry.recordRunEvent(run, {
        id: "evt_1",
        at: "2026-06-10T00:00:00.010Z",
        type: "plan.created",
        message: "Plan created."
      });
      telemetry.recordTestRun(run, {
        id: "test_1",
        runId: run.id,
        prdId: run.prdId,
        workItemId: run.workItemId,
        status: "passed",
        command: "pnpm test",
        summary: "Tests passed.",
        durationMs: 32,
        endedAt: "2026-06-10T00:00:00.050Z"
      });
      telemetry.recordAuditEvent({
        id: "audit_1",
        traceId: run.id,
        action: "agent_run.succeeded",
        targetType: "agent_run",
        targetId: run.id,
        message: "Run succeeded.",
        requirementId: run.requirementId,
        prdId: run.prdId,
        workItemId: run.workItemId,
        runId: run.id,
        createdAt: "2026-06-10T00:00:00.090Z"
      });
      telemetry.endAgentRun({ ...run, status: "succeeded", endedAt: "2026-06-10T00:00:00.100Z" }, "succeeded");
      await telemetry.forceFlush();

      const spans = telemetry.getFinishedSpans();
      const runSpan = spans.find((span) => span.name === "patchpilot.agent_run");
      const testSpan = spans.find((span) => span.name === "patchpilot.test_run");
      expect(runSpan?.attributes).toMatchObject({
        "patchpilot.requirement.id": "req_1",
        "patchpilot.prd.id": "prd_1",
        "patchpilot.workflow.id": "prd_1",
        "patchpilot.workflow.proxy": "prd",
        "patchpilot.work_item.id": "wi_1",
        "patchpilot.agent_run.id": "run_1",
        "patchpilot.agent_run.status": "succeeded"
      });
      expect(runSpan?.events.map((event) => event.name)).toEqual(["plan.created", "audit.agent_run.succeeded"]);
      expect(testSpan?.attributes).toMatchObject({
        "patchpilot.test_run.id": "test_1",
        "patchpilot.test_run.status": "passed"
      });

      expect(telemetry.getFinishedLogRecords().map((record) => record.eventName)).toEqual(
        expect.arrayContaining(["patchpilot.agent_run.started", "plan.created", "patchpilot.test_run.passed"])
      );
      expect(
        telemetry
          .getMetrics()
          .flatMap((resourceMetric) => resourceMetric.scopeMetrics)
          .flatMap((scopeMetric) => scopeMetric.metrics)
          .map((metric) => metric.descriptor.name)
      ).toEqual(
        expect.arrayContaining([
          "patchpilot.agent_run.started",
          "patchpilot.agent_run.completed",
          "patchpilot.test_run.completed"
        ])
      );
    } finally {
      await telemetry.shutdown();
    }
  });
});
