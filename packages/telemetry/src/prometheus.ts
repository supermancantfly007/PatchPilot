export const prometheusContentType = "text/plain; version=0.0.4; charset=utf-8";

export const prometheusMetricNames = {
  runDurationSeconds: "patchpilot_agent_run_duration_seconds",
  runFailuresTotal: "patchpilot_agent_run_failures_total",
  queueDepth: "patchpilot_work_item_queue_depth",
  costEstimateUsd: "patchpilot_agent_run_cost_estimate_usd",
  costActualUsd: "patchpilot_agent_run_cost_actual_usd",
  testRunsTotal: "patchpilot_test_runs_total",
  testPassRateRatio: "patchpilot_test_pass_rate_ratio",
  acceptanceDecisionsTotal: "patchpilot_acceptance_decisions_total",
  acceptanceRateRatio: "patchpilot_acceptance_rate_ratio"
} as const;

export interface PrometheusMetricsSnapshot {
  agentRuns: ReadonlyArray<{
    runner?: string;
    status?: string;
    failureType?: string;
    startedAt?: string;
    endedAt?: string;
    costEstimateUsd?: number;
    costActualUsd?: number;
  }>;
  workItems: ReadonlyArray<{
    role?: string;
    status?: string;
  }>;
  testRuns: ReadonlyArray<{
    status?: string;
  }>;
  acceptances: ReadonlyArray<{
    status?: string;
  }>;
}

type MetricType = "counter" | "gauge" | "histogram";
type Labels = Record<string, string | number | boolean | undefined>;

const runnerKinds = ["simulated", "codex", "unknown"] as const;
const agentRunStatuses = ["queued", "running", "needs_approval", "succeeded", "failed", "cancelled", "unknown"] as const;
const workItemStatuses = ["proposed", "ready", "claimed", "running", "review", "blocked", "done", "cancelled", "unknown"] as const;
const agentRoles = ["product", "frontend", "backend", "test", "ops", "reviewer", "unknown"] as const;
const failureTypes = [
  "transient",
  "deterministic",
  "test_failed",
  "policy_denied",
  "budget_exhausted",
  "environment_failed",
  "unknown"
] as const;
const testRunStatuses = ["queued", "running", "passed", "failed", "blocked", "skipped", "unknown"] as const;
const terminalTestRunStatuses = new Set(["passed", "failed", "blocked", "skipped"]);
const acceptanceStatuses = ["accepted", "rejected", "unknown"] as const;
const durationBucketsSeconds = [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600] as const;

export function renderPrometheusMetrics(snapshot: PrometheusMetricsSnapshot): string {
  const lines: string[] = [];

  appendRunDurationHistogram(lines, snapshot);
  lines.push("");
  appendRunFailureMetrics(lines, snapshot);
  lines.push("");
  appendQueueDepthMetrics(lines, snapshot);
  lines.push("");
  appendCostMetrics(lines, snapshot);
  lines.push("");
  appendTestMetrics(lines, snapshot);
  lines.push("");
  appendAcceptanceMetrics(lines, snapshot);

  return `${lines.join("\n").trimEnd()}\n`;
}

function appendRunDurationHistogram(lines: string[], snapshot: PrometheusMetricsSnapshot) {
  const name = prometheusMetricNames.runDurationSeconds;
  appendHeader(lines, name, "Agent Run duration for completed runs in seconds.", "histogram");

  const observations = new Map<string, { labels: Labels; durations: number[] }>();
  for (const labels of runnerStatusLabelSets()) {
    observations.set(labelKey(labels), { labels, durations: [] });
  }

  for (const run of snapshot.agentRuns) {
    const duration = durationSeconds(run.startedAt, run.endedAt);
    if (duration === undefined) continue;
    const labels = runLabels(run);
    const key = labelKey(labels);
    const item = observations.get(key) ?? { labels, durations: [] };
    item.durations.push(duration);
    observations.set(key, item);
  }

  for (const item of [...observations.values()].sort(compareLabelSets)) {
    const sortedDurations = [...item.durations].sort((left, right) => left - right);
    for (const bucket of durationBucketsSeconds) {
      lines.push(sample(`${name}_bucket`, countLessThanOrEqual(sortedDurations, bucket), { ...item.labels, le: bucket }));
    }
    lines.push(sample(`${name}_bucket`, sortedDurations.length, { ...item.labels, le: "+Inf" }));
    lines.push(sample(`${name}_sum`, sortedDurations.reduce((total, value) => total + value, 0), item.labels));
    lines.push(sample(`${name}_count`, sortedDurations.length, item.labels));
  }
}

function appendRunFailureMetrics(lines: string[], snapshot: PrometheusMetricsSnapshot) {
  const name = prometheusMetricNames.runFailuresTotal;
  appendHeader(lines, name, "Agent Runs that ended in failure, grouped by runner and failure type.", "counter");
  const counts = new Map<string, { labels: Labels; count: number }>();

  for (const runner of runnerKinds) {
    for (const failureType of failureTypes) {
      const labels = { runner, failure_type: failureType };
      counts.set(labelKey(labels), { labels, count: 0 });
    }
  }

  for (const run of snapshot.agentRuns) {
    if (normalizeEnum(run.status, agentRunStatuses) !== "failed") continue;
    const labels = {
      runner: normalizeEnum(run.runner, runnerKinds),
      failure_type: normalizeEnum(run.failureType, failureTypes)
    };
    const key = labelKey(labels);
    const item = counts.get(key) ?? { labels, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }

  for (const item of [...counts.values()].sort(compareLabelSets)) {
    lines.push(sample(name, item.count, item.labels));
  }
}

function appendQueueDepthMetrics(lines: string[], snapshot: PrometheusMetricsSnapshot) {
  const name = prometheusMetricNames.queueDepth;
  appendHeader(lines, name, "Current Work Item queue depth grouped by role and status.", "gauge");
  const counts = new Map<string, { labels: Labels; count: number }>();

  for (const role of agentRoles) {
    for (const status of workItemStatuses) {
      const labels = { role, status };
      counts.set(labelKey(labels), { labels, count: 0 });
    }
  }

  for (const workItem of snapshot.workItems) {
    const labels = {
      role: normalizeEnum(workItem.role, agentRoles),
      status: normalizeEnum(workItem.status, workItemStatuses)
    };
    const key = labelKey(labels);
    const item = counts.get(key) ?? { labels, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }

  for (const item of [...counts.values()].sort(compareLabelSets)) {
    lines.push(sample(name, item.count, item.labels));
  }
}

function appendCostMetrics(lines: string[], snapshot: PrometheusMetricsSnapshot) {
  const estimateName = prometheusMetricNames.costEstimateUsd;
  const actualName = prometheusMetricNames.costActualUsd;
  const values = new Map<string, { labels: Labels; estimate: number; actual: number }>();

  for (const labels of runnerStatusLabelSets()) {
    values.set(labelKey(labels), { labels, estimate: 0, actual: 0 });
  }

  for (const run of snapshot.agentRuns) {
    const labels = runLabels(run);
    const key = labelKey(labels);
    const item = values.get(key) ?? { labels, estimate: 0, actual: 0 };
    item.estimate += finiteOrZero(run.costEstimateUsd);
    item.actual += finiteOrZero(run.costActualUsd);
    values.set(key, item);
  }

  appendHeader(lines, estimateName, "Current sum of Agent Run estimated cost in USD.", "gauge");
  for (const item of [...values.values()].sort(compareLabelSets)) {
    lines.push(sample(estimateName, item.estimate, item.labels));
  }

  lines.push("");
  appendHeader(lines, actualName, "Current sum of Agent Run actual cost in USD.", "gauge");
  for (const item of [...values.values()].sort(compareLabelSets)) {
    lines.push(sample(actualName, item.actual, item.labels));
  }
}

function appendTestMetrics(lines: string[], snapshot: PrometheusMetricsSnapshot) {
  const totalName = prometheusMetricNames.testRunsTotal;
  appendHeader(lines, totalName, "Test Runs recorded by status.", "counter");
  const counts = new Map<string, { labels: Labels; count: number }>();
  for (const status of testRunStatuses) {
    const labels = { status };
    counts.set(labelKey(labels), { labels, count: 0 });
  }

  for (const testRun of snapshot.testRuns) {
    const labels = { status: normalizeEnum(testRun.status, testRunStatuses) };
    const key = labelKey(labels);
    const item = counts.get(key) ?? { labels, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }

  for (const item of [...counts.values()].sort(compareLabelSets)) {
    lines.push(sample(totalName, item.count, item.labels));
  }

  const terminalTotal = snapshot.testRuns.filter((testRun) =>
    terminalTestRunStatuses.has(normalizeEnum(testRun.status, testRunStatuses))
  ).length;
  const passed = snapshot.testRuns.filter((testRun) => normalizeEnum(testRun.status, testRunStatuses) === "passed").length;
  lines.push("");
  appendHeader(lines, prometheusMetricNames.testPassRateRatio, "Ratio of passed terminal Test Runs, from 0 to 1.", "gauge");
  lines.push(sample(prometheusMetricNames.testPassRateRatio, ratio(passed, terminalTotal)));
}

function appendAcceptanceMetrics(lines: string[], snapshot: PrometheusMetricsSnapshot) {
  const totalName = prometheusMetricNames.acceptanceDecisionsTotal;
  appendHeader(lines, totalName, "Acceptance decisions recorded by status.", "counter");
  const counts = new Map<string, { labels: Labels; count: number }>();
  for (const status of acceptanceStatuses) {
    const labels = { status };
    counts.set(labelKey(labels), { labels, count: 0 });
  }

  for (const acceptance of snapshot.acceptances) {
    const labels = { status: normalizeEnum(acceptance.status, acceptanceStatuses) };
    const key = labelKey(labels);
    const item = counts.get(key) ?? { labels, count: 0 };
    item.count += 1;
    counts.set(key, item);
  }

  for (const item of [...counts.values()].sort(compareLabelSets)) {
    lines.push(sample(totalName, item.count, item.labels));
  }

  const accepted = snapshot.acceptances.filter((acceptance) =>
    normalizeEnum(acceptance.status, acceptanceStatuses) === "accepted"
  ).length;
  const decided = snapshot.acceptances.filter((acceptance) =>
    ["accepted", "rejected"].includes(normalizeEnum(acceptance.status, acceptanceStatuses))
  ).length;
  lines.push("");
  appendHeader(lines, prometheusMetricNames.acceptanceRateRatio, "Ratio of accepted acceptance decisions, from 0 to 1.", "gauge");
  lines.push(sample(prometheusMetricNames.acceptanceRateRatio, ratio(accepted, decided)));
}

function runnerStatusLabelSets(): Labels[] {
  const labels: Labels[] = [];
  for (const runner of runnerKinds) {
    for (const status of agentRunStatuses) {
      labels.push({ runner, status });
    }
  }
  return labels;
}

function runLabels(run: { runner?: string; status?: string }): Labels {
  return {
    runner: normalizeEnum(run.runner, runnerKinds),
    status: normalizeEnum(run.status, agentRunStatuses)
  };
}

function appendHeader(lines: string[], name: string, help: string, type: MetricType) {
  lines.push(`# HELP ${name} ${escapeHelp(help)}`);
  lines.push(`# TYPE ${name} ${type}`);
}

function sample(name: string, value: number, labels: Labels = {}) {
  return `${name}${formatLabels(labels)} ${formatNumber(value)}`;
}

function formatLabels(labels: Labels) {
  const entries = Object.entries(labels).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
  if (entries.length === 0) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(String(value))}"`).join(",")}}`;
}

function labelKey(labels: Labels) {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\u0000");
}

function compareLabelSets(left: { labels: Labels }, right: { labels: Labels }) {
  return labelKey(left.labels).localeCompare(labelKey(right.labels));
}

function normalizeEnum<T extends readonly string[]>(value: string | undefined, allowedValues: T): T[number] | "unknown" {
  if (!value) return "unknown";
  return allowedValues.includes(value) ? value : "unknown";
}

function durationSeconds(startedAt: string | undefined, endedAt: string | undefined) {
  const start = parseTimestamp(startedAt);
  const end = parseTimestamp(endedAt);
  if (start === undefined || end === undefined) return undefined;
  return Math.max(0, (end - start) / 1000);
}

function parseTimestamp(value: string | undefined) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function countLessThanOrEqual(sortedValues: number[], threshold: number) {
  let count = 0;
  for (const value of sortedValues) {
    if (value > threshold) break;
    count += 1;
  }
  return count;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? numerator / denominator : 0;
}

function finiteOrZero(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

function escapeHelp(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

function escapeLabelValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}
