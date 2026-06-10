import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Counter,
  type Histogram,
  type Span,
  type Tracer
} from "@opentelemetry/api";
import { SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchLogRecordProcessor,
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
  type ReadableLogRecord
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

export {
  prometheusContentType,
  prometheusMetricNames,
  renderPrometheusMetrics,
  type PrometheusMetricsSnapshot
} from "./prometheus";

export type TelemetryExporter = "none" | "otlp" | "in_memory";

export interface TelemetryEnv {
  NODE_ENV?: string;
  OTEL_EXPORTER_OTLP_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?: string;
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT?: string;
  OTEL_METRIC_EXPORT_INTERVAL?: string;
  OTEL_SERVICE_NAME?: string;
  OTEL_SDK_DISABLED?: string;
  PATCHPILOT_OTEL_ENABLED?: string;
  PATCHPILOT_OTEL_EXPORTER?: string;
  PATCHPILOT_OTEL_EXPORT_INTERVAL_MS?: string;
  PATCHPILOT_OTEL_METRIC_INTERVAL_MS?: string;
  PATCHPILOT_OTEL_SERVICE_NAME?: string;
  npm_package_version?: string;
}

export interface TelemetryConfig {
  enabled: boolean;
  exporter: TelemetryExporter;
  serviceName: string;
  serviceVersion: string;
  environment: string;
  traceEndpoint: string;
  metricEndpoint: string;
  logEndpoint: string;
  exportIntervalMs: number;
  metricIntervalMs: number;
}

export interface TelemetryCorrelationIds {
  requirementId?: string;
  prdId?: string;
  workflowId?: string;
  workflowProxy?: string;
  workItemId?: string;
  agentRunId?: string;
  testRunId?: string;
}

export interface AgentRunTelemetryInput {
  id: string;
  requirementId: string;
  prdId: string;
  workItemId: string;
  runner?: string;
  status?: string;
  currentStep?: string;
  costEstimateUsd?: number;
  costActualUsd?: number;
  failureType?: string;
  failureSummary?: string;
  startedAt?: string;
  endedAt?: string;
}

export interface AgentRunEventTelemetryInput {
  id?: string;
  at?: string;
  type: string;
  message: string;
}

export interface TestRunTelemetryInput {
  id: string;
  runId?: string;
  prdId?: string;
  workItemId?: string;
  status: string;
  command: string;
  summary?: string;
  durationMs?: number;
  startedAt?: string;
  endedAt?: string;
  runner?: string;
  exitCode?: number | null;
  retryCount?: number;
  flakySignal?: boolean;
}

export interface AuditEventTelemetryInput {
  id: string;
  traceId: string;
  action: string;
  targetType: string;
  targetId: string;
  message: string;
  requirementId?: string;
  prdId?: string;
  workItemId?: string;
  runId?: string;
  createdAt?: string;
}

export interface WorkerDispatchTelemetryInput {
  workItemId: string;
  prdId?: string;
  agentId?: string;
  role?: string;
  status: "started" | "succeeded" | "failed";
  error?: string;
}

export interface WorkerTickTelemetryInput {
  planned: number;
  dispatched: number;
  failed: number;
}

export interface PatchPilotTelemetry {
  readonly enabled: boolean;
  readonly config: TelemetryConfig;
  startAgentRun(run: AgentRunTelemetryInput): void;
  recordRunEvent(run: AgentRunTelemetryInput, event: AgentRunEventTelemetryInput): void;
  recordTestRun(run: AgentRunTelemetryInput, testRun: TestRunTelemetryInput): void;
  recordAuditEvent(event: AuditEventTelemetryInput): void;
  endAgentRun(run: AgentRunTelemetryInput, status: string): void;
  recordWorkerDispatch(input: WorkerDispatchTelemetryInput): void;
  recordWorkerTick(input: WorkerTickTelemetryInput): void;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface InMemoryTelemetry extends PatchPilotTelemetry {
  readonly spanExporter: InMemorySpanExporter;
  readonly metricExporter: InMemoryMetricExporter;
  readonly logExporter: InMemoryLogRecordExporter;
  getFinishedSpans(): ReadableSpan[];
  getMetrics(): ResourceMetrics[];
  getFinishedLogRecords(): ReadableLogRecord[];
  reset(): void;
}

interface ExporterSet {
  spanExporter: SpanExporter;
  metricExporter: PushMetricExporter;
  logExporter: LogRecordExporter;
  inMemory?: {
    spanExporter: InMemorySpanExporter;
    metricExporter: InMemoryMetricExporter;
    logExporter: InMemoryLogRecordExporter;
  };
}

interface ActiveRunSpan {
  span: Span;
  context: Context;
  startedAtMs?: number;
}

const packageVersion = "0.1.0";
const defaultOtlpEndpoint = "http://localhost:4318";
const defaultExportIntervalMs = 500;
const defaultMetricIntervalMs = 1000;
const instrumentationName = "patchpilot";
const telemetryByService = new Map<string, PatchPilotTelemetry>();

export function readTelemetryConfig(
  options: { serviceName?: string; env?: TelemetryEnv } = {}
): TelemetryConfig {
  const env = options.env ?? process.env;
  const serviceName =
    options.serviceName ||
    pickString(env.PATCHPILOT_OTEL_SERVICE_NAME, env.OTEL_SERVICE_NAME, "patchpilot");
  const exporter = pickExporter(env.PATCHPILOT_OTEL_EXPORTER);
  const endpointConfigured = Boolean(
    env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
      env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
  );
  const explicitEnabled =
    env.PATCHPILOT_OTEL_ENABLED === undefined ? undefined : isTruthy(env.PATCHPILOT_OTEL_ENABLED);
  const enabled =
    !isTruthy(env.OTEL_SDK_DISABLED) &&
    exporter !== "none" &&
    (explicitEnabled ?? (endpointConfigured || exporter === "in_memory"));
  const baseEndpoint = pickString(env.OTEL_EXPORTER_OTLP_ENDPOINT, defaultOtlpEndpoint);

  return {
    enabled,
    exporter: enabled ? exporter : "none",
    serviceName,
    serviceVersion: pickString(env.npm_package_version, packageVersion),
    environment: pickString(env.NODE_ENV, "development"),
    traceEndpoint: pickString(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, otlpSignalEndpoint(baseEndpoint, "traces")),
    metricEndpoint: pickString(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, otlpSignalEndpoint(baseEndpoint, "metrics")),
    logEndpoint: pickString(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, otlpSignalEndpoint(baseEndpoint, "logs")),
    exportIntervalMs: pickPositiveInt(env.PATCHPILOT_OTEL_EXPORT_INTERVAL_MS, defaultExportIntervalMs),
    metricIntervalMs: pickPositiveInt(
      env.PATCHPILOT_OTEL_METRIC_INTERVAL_MS,
      env.OTEL_METRIC_EXPORT_INTERVAL,
      defaultMetricIntervalMs
    )
  };
}

export function getTelemetry(options: { serviceName: string; env?: TelemetryEnv }): PatchPilotTelemetry {
  const config = readTelemetryConfig(options);
  const key = `${config.serviceName}:${config.exporter}:${config.traceEndpoint}:${config.metricEndpoint}:${config.logEndpoint}`;
  const existing = telemetryByService.get(key);
  if (existing) return existing;
  const telemetry = createTelemetry(config);
  telemetryByService.set(key, telemetry);
  return telemetry;
}

export async function shutdownTelemetry(): Promise<void> {
  const telemetry = [...telemetryByService.values()];
  telemetryByService.clear();
  await Promise.allSettled(telemetry.map((item) => item.shutdown()));
}

export function createTelemetry(config: TelemetryConfig = readTelemetryConfig()): PatchPilotTelemetry {
  if (!config.enabled || config.exporter === "none") return new NoopTelemetry(config);
  return new OpenTelemetryClient(config, createExporters(config));
}

export function createInMemoryTelemetry(serviceName = "patchpilot-test"): InMemoryTelemetry {
  const config: TelemetryConfig = {
    ...readTelemetryConfig({
      serviceName,
      env: {
        PATCHPILOT_OTEL_ENABLED: "true",
        PATCHPILOT_OTEL_EXPORTER: "in_memory",
        NODE_ENV: "test"
      }
    }),
    enabled: true,
    exporter: "in_memory"
  };
  const spanExporter = new InMemorySpanExporter();
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const logExporter = new InMemoryLogRecordExporter();
  const telemetry = new OpenTelemetryClient(config, {
    spanExporter,
    metricExporter,
    logExporter,
    inMemory: { spanExporter, metricExporter, logExporter }
  });

  return Object.assign(telemetry, {
    spanExporter,
    metricExporter,
    logExporter,
    getFinishedSpans: () => spanExporter.getFinishedSpans(),
    getMetrics: () => metricExporter.getMetrics(),
    getFinishedLogRecords: () => logExporter.getFinishedLogRecords(),
    reset: () => {
      spanExporter.reset();
      metricExporter.reset();
      logExporter.reset();
    }
  }) as InMemoryTelemetry;
}

export function telemetryAttributes(ids: TelemetryCorrelationIds, extra: Attributes = {}): Attributes {
  const attributes: Attributes = {
    "patchpilot.workflow.id": ids.workflowId ?? ids.prdId ?? ids.requirementId,
    "patchpilot.workflow.proxy": ids.workflowProxy ?? (ids.workflowId ? "workflow" : ids.prdId ? "prd" : "requirement"),
    "patchpilot.requirement.id": ids.requirementId,
    "patchpilot.prd.id": ids.prdId,
    "patchpilot.work_item.id": ids.workItemId,
    "patchpilot.agent_run.id": ids.agentRunId,
    "patchpilot.test_run.id": ids.testRunId,
    ...extra
  };
  return compactAttributes(attributes);
}

class OpenTelemetryClient implements PatchPilotTelemetry {
  readonly enabled = true;
  readonly config: TelemetryConfig;

  private readonly tracerProvider: NodeTracerProvider;
  private readonly meterProvider: MeterProvider;
  private readonly loggerProvider: LoggerProvider;
  private readonly tracer: Tracer;
  private readonly logger: Logger;
  private readonly agentRunStartedCounter: Counter;
  private readonly agentRunCompletedCounter: Counter;
  private readonly agentRunDurationHistogram: Histogram;
  private readonly testRunCompletedCounter: Counter;
  private readonly testRunDurationHistogram: Histogram;
  private readonly workerDispatchCounter: Counter;
  private readonly workerTickCounter: Counter;
  private readonly runSpans = new Map<string, ActiveRunSpan>();

  constructor(config: TelemetryConfig, exporters: ExporterSet) {
    this.config = config;
    const resource = resourceFromAttributes({
      "service.name": config.serviceName,
      "service.version": config.serviceVersion,
      "deployment.environment.name": config.environment,
      "patchpilot.telemetry.exporter": config.exporter
    });

    this.tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        config.exporter === "in_memory"
          ? new SimpleSpanProcessor(exporters.spanExporter)
          : new BatchSpanProcessor(exporters.spanExporter, {
              scheduledDelayMillis: config.exportIntervalMs
            })
      ]
    });
    this.meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: exporters.metricExporter,
          exportIntervalMillis: config.metricIntervalMs
        })
      ]
    });
    this.loggerProvider = new LoggerProvider({
      resource,
      processors: [
        config.exporter === "in_memory"
          ? new SimpleLogRecordProcessor(exporters.logExporter)
          : new BatchLogRecordProcessor(exporters.logExporter, {
              scheduledDelayMillis: config.exportIntervalMs
            })
      ]
    });

    this.tracer = this.tracerProvider.getTracer(instrumentationName, config.serviceVersion);
    const meter = this.meterProvider.getMeter(instrumentationName, config.serviceVersion);
    this.logger = this.loggerProvider.getLogger(instrumentationName, config.serviceVersion);

    this.agentRunStartedCounter = meter.createCounter("patchpilot.agent_run.started", {
      description: "Agent Runs started by PatchPilot"
    });
    this.agentRunCompletedCounter = meter.createCounter("patchpilot.agent_run.completed", {
      description: "Agent Runs completed by PatchPilot"
    });
    this.agentRunDurationHistogram = meter.createHistogram("patchpilot.agent_run.duration_ms", {
      description: "Agent Run duration in milliseconds",
      unit: "ms"
    });
    this.testRunCompletedCounter = meter.createCounter("patchpilot.test_run.completed", {
      description: "Test Runs recorded by PatchPilot"
    });
    this.testRunDurationHistogram = meter.createHistogram("patchpilot.test_run.duration_ms", {
      description: "Test Run duration in milliseconds",
      unit: "ms"
    });
    this.workerDispatchCounter = meter.createCounter("patchpilot.worker.dispatch", {
      description: "Worker dispatch attempts"
    });
    this.workerTickCounter = meter.createCounter("patchpilot.worker.tick", {
      description: "Worker polling ticks"
    });
  }

  startAgentRun(run: AgentRunTelemetryInput): void {
    this.safe(() => {
      const attributes = runAttributes(run, {
        "patchpilot.agent_run.status": run.status ?? "running",
        "patchpilot.agent_run.current_step": run.currentStep,
        "patchpilot.agent_run.cost_estimate_usd": run.costEstimateUsd
      });
      const span = this.tracer.startSpan("patchpilot.agent_run", { attributes });
      this.runSpans.set(run.id, {
        span,
        context: trace.setSpan(ROOT_CONTEXT, span),
        startedAtMs: parseTime(run.startedAt)
      });
      this.agentRunStartedCounter.add(1, attributes);
      this.emitLog("patchpilot.agent_run.started", "Agent run started.", attributes, SeverityNumber.INFO, this.runSpans.get(run.id)?.context);
    });
  }

  recordRunEvent(run: AgentRunTelemetryInput, event: AgentRunEventTelemetryInput): void {
    this.safe(() => {
      const active = this.runSpans.get(run.id);
      const attributes = runAttributes(run, {
        "patchpilot.agent_run.event.id": event.id,
        "patchpilot.agent_run.event.type": event.type
      });
      active?.span.addEvent(event.type, compactAttributes({ ...attributes, "patchpilot.message": event.message }), parseTime(event.at));
      this.emitLog(event.type, event.message, attributes, SeverityNumber.INFO, active?.context);
    });
  }

  recordTestRun(run: AgentRunTelemetryInput, testRun: TestRunTelemetryInput): void {
    this.safe(() => {
      const active = this.runSpans.get(run.id);
      const attributes = runAttributes(run, {
        "patchpilot.test_run.id": testRun.id,
        "patchpilot.test_run.status": testRun.status,
        "patchpilot.test_run.command": testRun.command,
        "patchpilot.test_run.runner": testRun.runner,
        "patchpilot.test_run.exit_code": testRun.exitCode ?? undefined,
        "patchpilot.test_run.retry_count": testRun.retryCount,
        "patchpilot.test_run.flaky": testRun.flakySignal
      });
      const span = this.tracer.startSpan("patchpilot.test_run", { attributes }, active?.context ?? ROOT_CONTEXT);
      if (testRun.status === "failed" || testRun.status === "blocked") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: testRun.summary });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }
      span.end(parseTime(testRun.endedAt));
      this.testRunCompletedCounter.add(1, attributes);
      if (testRun.durationMs !== undefined) this.testRunDurationHistogram.record(testRun.durationMs, attributes);
      this.emitLog(
        `patchpilot.test_run.${testRun.status}`,
        testRun.summary || `Test run ${testRun.status}.`,
        attributes,
        testRun.status === "failed" ? SeverityNumber.ERROR : SeverityNumber.INFO,
        active?.context
      );
    });
  }

  recordAuditEvent(event: AuditEventTelemetryInput): void {
    this.safe(() => {
      const active = event.runId ? this.runSpans.get(event.runId) : undefined;
      const attributes = telemetryAttributes(
        {
          requirementId: event.requirementId,
          prdId: event.prdId,
          workItemId: event.workItemId,
          agentRunId: event.runId
        },
        {
          "patchpilot.audit_event.id": event.id,
          "patchpilot.audit_event.trace_id": event.traceId,
          "patchpilot.audit_event.action": event.action,
          "patchpilot.audit_event.target_type": event.targetType,
          "patchpilot.audit_event.target_id": event.targetId
        }
      );
      active?.span.addEvent(`audit.${event.action}`, attributes, parseTime(event.createdAt));
      this.emitLog(`audit.${event.action}`, event.message, attributes, SeverityNumber.INFO, active?.context);
    });
  }

  endAgentRun(run: AgentRunTelemetryInput, status: string): void {
    this.safe(() => {
      const active = this.runSpans.get(run.id);
      const attributes = runAttributes(run, {
        "patchpilot.agent_run.status": status,
        "patchpilot.agent_run.failure_type": run.failureType,
        "patchpilot.agent_run.failure_summary": run.failureSummary,
        "patchpilot.agent_run.cost_actual_usd": run.costActualUsd
      });
      const endedAtMs = parseTime(run.endedAt);
      const startedAtMs = active?.startedAtMs ?? parseTime(run.startedAt);
      const durationMs = endedAtMs !== undefined && startedAtMs !== undefined ? Math.max(0, endedAtMs - startedAtMs) : undefined;
      if (status === "failed" || status === "cancelled") {
        active?.span.setStatus({ code: SpanStatusCode.ERROR, message: run.failureSummary || status });
      } else {
        active?.span.setStatus({ code: SpanStatusCode.OK });
      }
      for (const [key, value] of Object.entries(attributes)) {
        if (value !== undefined) active?.span.setAttribute(key, value);
      }
      active?.span.end(endedAtMs);
      this.runSpans.delete(run.id);
      this.agentRunCompletedCounter.add(1, attributes);
      if (durationMs !== undefined) this.agentRunDurationHistogram.record(durationMs, attributes);
      this.emitLog(
        `patchpilot.agent_run.${status}`,
        `Agent run ${status}.`,
        attributes,
        status === "failed" ? SeverityNumber.ERROR : SeverityNumber.INFO,
        active?.context
      );
      void this.forceFlush();
    });
  }

  recordWorkerDispatch(input: WorkerDispatchTelemetryInput): void {
    this.safe(() => {
      const attributes = telemetryAttributes(
        {
          prdId: input.prdId,
          workItemId: input.workItemId
        },
        {
          "patchpilot.worker.agent_id": input.agentId,
          "patchpilot.worker.role": input.role,
          "patchpilot.worker.dispatch.status": input.status,
          "patchpilot.error": input.error
        }
      );
      const span = this.tracer.startSpan("patchpilot.worker.dispatch", { attributes });
      if (input.status === "failed") span.setStatus({ code: SpanStatusCode.ERROR, message: input.error });
      else span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      this.workerDispatchCounter.add(1, attributes);
      this.emitLog(
        `patchpilot.worker.dispatch.${input.status}`,
        input.error || `Worker dispatch ${input.status}.`,
        attributes,
        input.status === "failed" ? SeverityNumber.ERROR : SeverityNumber.INFO
      );
    });
  }

  recordWorkerTick(input: WorkerTickTelemetryInput): void {
    this.safe(() => {
      const attributes = compactAttributes({
        "patchpilot.worker.tick.planned": input.planned,
        "patchpilot.worker.tick.dispatched": input.dispatched,
        "patchpilot.worker.tick.failed": input.failed
      });
      this.workerTickCounter.add(1, attributes);
      this.emitLog("patchpilot.worker.tick", "Worker tick completed.", attributes, input.failed > 0 ? SeverityNumber.WARN : SeverityNumber.INFO);
    });
  }

  async forceFlush(): Promise<void> {
    await Promise.allSettled([
      this.tracerProvider.forceFlush(),
      this.meterProvider.forceFlush(),
      this.loggerProvider.forceFlush()
    ]);
  }

  async shutdown(): Promise<void> {
    for (const active of this.runSpans.values()) active.span.end();
    this.runSpans.clear();
    await Promise.allSettled([
      this.tracerProvider.shutdown(),
      this.meterProvider.shutdown(),
      this.loggerProvider.shutdown()
    ]);
  }

  private emitLog(
    eventName: string,
    body: string,
    attributes: Attributes,
    severityNumber: SeverityNumber,
    context?: Context
  ) {
    this.logger.emit({
      eventName,
      severityNumber,
      severityText: severityText(severityNumber),
      body,
      attributes,
      context
    });
  }

  private safe(action: () => void) {
    try {
      action();
    } catch {
      // Telemetry must never change product control-plane behavior.
    }
  }
}

class NoopTelemetry implements PatchPilotTelemetry {
  readonly enabled = false;

  constructor(readonly config: TelemetryConfig) {}

  startAgentRun(): void {}
  recordRunEvent(): void {}
  recordTestRun(): void {}
  recordAuditEvent(): void {}
  endAgentRun(): void {}
  recordWorkerDispatch(): void {}
  recordWorkerTick(): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

function createExporters(config: TelemetryConfig): ExporterSet {
  if (config.exporter === "in_memory") {
    const spanExporter = new InMemorySpanExporter();
    const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
    const logExporter = new InMemoryLogRecordExporter();
    return {
      spanExporter,
      metricExporter,
      logExporter,
      inMemory: { spanExporter, metricExporter, logExporter }
    };
  }

  return {
    spanExporter: new OTLPTraceExporter({ url: config.traceEndpoint }),
    metricExporter: new OTLPMetricExporter({ url: config.metricEndpoint }),
    logExporter: new OTLPLogExporter({ url: config.logEndpoint })
  };
}

function runAttributes(run: AgentRunTelemetryInput, extra: Attributes = {}) {
  return telemetryAttributes(
    {
      requirementId: run.requirementId,
      prdId: run.prdId,
      workItemId: run.workItemId,
      agentRunId: run.id
    },
    {
      "patchpilot.runner": run.runner,
      ...extra
    }
  );
}

function compactAttributes(attributes: Attributes): Attributes {
  const compacted: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === "") continue;
    compacted[key] = value;
  }
  return compacted;
}

function otlpSignalEndpoint(baseEndpoint: string, signal: "traces" | "metrics" | "logs") {
  const trimmed = baseEndpoint.replace(/\/+$/, "");
  return trimmed.endsWith(`/v1/${signal}`) ? trimmed : `${trimmed}/v1/${signal}`;
}

function pickExporter(value: string | undefined): TelemetryExporter {
  if (value === "none" || value === "otlp" || value === "in_memory") return value;
  return "otlp";
}

function pickString(...values: Array<string | undefined>) {
  return values.find((value) => value !== undefined && value.trim() !== "")?.trim() ?? "";
}

function pickPositiveInt(...values: Array<string | number | undefined>) {
  for (const value of values) {
    const parsed = typeof value === "number" ? value : Number(value);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return defaultExportIntervalMs;
}

function isTruthy(value: string | undefined) {
  return value === "1" || value === "true" || value === "yes";
}

function parseTime(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function severityText(severityNumber: SeverityNumber) {
  if (severityNumber >= SeverityNumber.ERROR) return "ERROR";
  if (severityNumber >= SeverityNumber.WARN) return "WARN";
  if (severityNumber >= SeverityNumber.INFO) return "INFO";
  return "DEBUG";
}
