"use client";

import type {
  AgentProfile,
  AgentRun,
  ApprovalRecord,
  PatchPilotSnapshot,
  PullRequestRecord,
  ReviewRecord,
  TestCase,
  WorkItem
} from "@patchpilot/domain";
import { AlertTriangle, Check, CheckCircle2, Circle, Clock, DollarSign, ExternalLink, GitPullRequest, Loader2, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ArtifactReferenceList } from "@/components/ArtifactReferenceList";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";
import {
  approvalKindLabels,
  approvalRiskLabels,
  approvalRiskTone,
  approvalShortId,
  approvalStatusLabels,
  approvalStatusTone,
  approvalTargetLabels,
  failureTypeLabels,
  failureTypeTone,
  formatCost,
  formatCostMode,
  formatCurrency,
  relatedApprovalsForRun,
  runBudgetUsage
} from "@/lib/professionalMode";

function StepIcon({ status }: { status: AgentRun["timeline"][number]["status"] }) {
  if (status === "done") return <CheckCircle2 size={18} />;
  if (status === "active") return <Loader2 size={18} />;
  if (status === "failed") return <AlertTriangle size={18} />;
  return <Circle size={16} />;
}

function runStatusLabel(status: AgentRun["status"]) {
  const labels: Record<AgentRun["status"], string> = {
    queued: "排队中",
    running: "执行中",
    needs_approval: "等待批准",
    succeeded: "等待你确认",
    failed: "执行失败",
    cancelled: "已取消"
  };
  return labels[status];
}

function visibleRunStatusLabel(run: AgentRun, accepted: boolean) {
  return accepted ? "已验收" : runStatusLabel(run.status);
}

function runStatusTone(status: AgentRun["status"]) {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "needs_approval") return "amber";
  return "blue";
}

function runnerLabel(_runner: AgentRun["runner"]) {
  return "本地 Codex runner";
}

const roleOrder: WorkItem["role"][] = ["backend", "frontend", "test", "ops", "reviewer", "product"];

const roleLabels: Record<WorkItem["role"], string> = {
  product: "产品",
  frontend: "前端",
  backend: "后端",
  test: "测试",
  ops: "运维",
  reviewer: "审查"
};

const workItemStatusLabels: Record<WorkItem["status"], string> = {
  proposed: "待拆解",
  ready: "待领取",
  claimed: "已领取",
  running: "执行中",
  review: "待验收",
  blocked: "需处理",
  done: "已完成",
  cancelled: "已取消"
};

function workItemTone(status: WorkItem["status"]) {
  if (status === "done" || status === "review") return "green";
  if (status === "blocked" || status === "cancelled") return "red";
  if (status === "claimed" || status === "running") return "blue";
  return "amber";
}

function reworkStatusLabel(item: WorkItem) {
  if (item.status === "ready") return "待返工";
  if (item.status === "claimed" || item.status === "running") return "返工中";
  if (item.status === "review") return "返工待验收";
  return workItemStatusLabels[item.status];
}

function reworkStatusTone(item: WorkItem) {
  return item.status === "review" ? "green" : "amber";
}

function pullRequestStatusLabel(status: PullRequestRecord["status"]) {
  const labels: Record<PullRequestRecord["status"], string> = {
    draft: "草稿",
    ready_for_review: "待审查",
    changes_requested: "需修改",
    approved: "已批准",
    merged: "已合并",
    closed: "已关闭"
  };
  return labels[status];
}

function pullRequestTone(status: PullRequestRecord["status"]) {
  if (["ready_for_review", "approved", "merged"].includes(status)) return "green";
  if (status === "changes_requested" || status === "closed") return "red";
  return "amber";
}

function reviewStatusLabel(status: ReviewRecord["status"]) {
  const labels: Record<ReviewRecord["status"], string> = {
    approved: "已批准",
    changes_requested: "需修改",
    blocked: "已阻塞"
  };
  return labels[status];
}

function reviewTone(status: ReviewRecord["status"]) {
  if (status === "approved") return "green";
  if (status === "changes_requested") return "amber";
  return "red";
}

function toolCallTone(status: "started" | "completed" | "failed" | "unknown") {
  if (status === "completed") return "green";
  if (status === "failed") return "red";
  if (status === "started") return "blue";
  return "amber";
}

function formatShortDate(value?: string) {
  if (!value) return "暂无时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function approvalSortDate(approval: ApprovalRecord) {
  return approval.updatedAt ?? approval.createdAt;
}

function testCaseStatusLabel(status: TestCase["status"]) {
  const labels: Record<TestCase["status"], string> = {
    draft: "草稿",
    ready: "待执行",
    passed: "已通过",
    failed: "未通过",
    blocked: "阻塞"
  };
  return labels[status];
}

function orderWorkItems(items: WorkItem[]) {
  return [...items].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role));
}

function latestRunByWorkItem(runs: AgentRun[]) {
  const byWorkItem = new Map<string, AgentRun>();
  for (const candidate of runs) {
    const current = byWorkItem.get(candidate.workItemId);
    if (!current || candidate.startedAt > current.startedAt) byWorkItem.set(candidate.workItemId, candidate);
  }
  return byWorkItem;
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [snapshot, setSnapshot] = useState<PatchPilotSnapshot | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "polling" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);

  useEffect(() => {
    setConnection("connecting");
    setError(null);
    const source = new EventSource(api.eventSourceUrl(id));
    source.onmessage = (event) => {
      try {
        setRun(JSON.parse(event.data) as AgentRun);
        setLastUpdated(new Date());
        setConnection("live");
      } catch {
        setError("运行事件格式不正确，请刷新页面读取最新快照。");
      }
    };
    source.onerror = () => {
      source.close();
      setConnection("polling");
      void api
        .getRun(id)
        .then((nextRun) => {
          setRun(nextRun);
          setLastUpdated(new Date());
          setConnection(["succeeded", "failed", "cancelled"].includes(nextRun.status) ? "closed" : "polling");
        })
        .catch((nextError) => {
          setError(nextError instanceof Error ? nextError.message : "无法读取运行状态。");
        });
    };
    return () => source.close();
  }, [id]);

  useEffect(() => {
    if (!run?.prdId) return;

    let cancelled = false;
    const refresh = async () => {
      try {
        const nextSnapshot = await api.getSnapshot();
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        const nextRun = nextSnapshot.agentRuns.find((item) => item.id === id);
        if (nextRun) {
          setRun(nextRun);
          setLastUpdated(new Date());
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "无法读取团队状态。");
        }
      }
    };

    void refresh();
    const interval = setInterval(() => void refresh(), 1500);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [id, run?.prdId]);

  if (!run) {
    return (
      <AppShell>
        <div className="card">
          <div className="card-body grid">
            <StatusNotice title="正在连接这次执行" tone="info">
              正在等待第一条运行事件。如果停留太久，请确认 API 服务正在运行。
            </StatusNotice>
            {error ? (
              <StatusNotice title="连接失败" tone="error">
                {error}
              </StatusNotice>
            ) : null}
          </div>
        </div>
      </AppShell>
    );
  }

  const teamWorkItems = orderWorkItems(snapshot?.workItems.filter((item) => item.prdId === run.prdId) ?? []);
  const teamRuns = snapshot?.agentRuns.filter((item) => item.prdId === run.prdId) ?? [run];
  const runsByWorkItem = latestRunByWorkItem(teamRuns);
  const agentsById = new Map<string, AgentProfile>((snapshot?.agents ?? []).map((agent) => [agent.id, agent]));
  const acceptedRunIds = new Set(
    (snapshot?.acceptances ?? []).filter((item) => item.status === "accepted").map((item) => item.runId)
  );
  const rejectedRunIds = new Set(
    (snapshot?.acceptances ?? []).filter((item) => item.status === "rejected").map((item) => item.runId)
  );
  const currentRunAccepted = acceptedRunIds.has(run.id);
  const totalTeamItems = Math.max(teamWorkItems.length, 1);
  const finishedTeamItems = teamWorkItems.filter((item) => {
    const itemRun = runsByWorkItem.get(item.id);
    return (itemRun?.status === "succeeded" && !rejectedRunIds.has(itemRun.id)) || item.status === "done";
  }).length;
  const failedTeamItems = teamWorkItems.filter((item) => {
    const itemRun = runsByWorkItem.get(item.id);
    return itemRun?.status === "failed" || ["blocked", "cancelled"].includes(item.status) || ((item.reworkCount ?? 0) > 0 && item.status === "ready");
  }).length;
  const allTeamSucceeded =
    teamWorkItems.length > 1
      ? teamWorkItems.every((item) => {
          const itemRun = runsByWorkItem.get(item.id);
          return (itemRun?.status === "succeeded" && !rejectedRunIds.has(itemRun.id)) || item.status === "done";
        })
      : run.status === "succeeded" && !rejectedRunIds.has(run.id);
  const teamTests = teamRuns.flatMap((item) => item.result?.tests ?? []);
  const passedTeamTests = teamTests.filter((test) => test.status === "passed").length;
  const teamTestCases = snapshot?.testCases.filter((testCase) => testCase.prdId === run.prdId) ?? [];
  const runTestRuns = snapshot?.testRuns.filter((test) => test.runId === run.id) ?? run.result?.tests ?? [];
  const runTestCases = snapshot?.testCases.filter((testCase) => testCase.workItemId === run.workItemId) ?? [];
  const runWorkspace = snapshot?.workspaceRuns.find((workspace) => workspace.runId === run.id);
  const runPullRequest = snapshot?.pullRequests.find((pullRequest) => pullRequest.runId === run.id);
  const runReview = snapshot?.reviewRecords.find((review) => review.runId === run.id);
  const runAuditEvents = (snapshot?.auditEvents.filter((event) => event.runId === run.id) ?? []).slice(0, 5);
  const requirementArtifactReferences =
    snapshot?.requirements.find((requirement) => requirement.id === run.requirementId)?.artifactReferences ?? [];
  const runApprovals = relatedApprovalsForRun(snapshot?.approvals ?? [], run).sort(
    (left, right) => new Date(approvalSortDate(right)).getTime() - new Date(approvalSortDate(left)).getTime()
  );
  const pendingRunApprovals = runApprovals.filter((approval) => approval.status === "pending");
  const budgetUsage = runBudgetUsage(run);
  const diffSummary = run.result?.diffSummary;
  const resultChangedFiles = run.result?.changedFiles ?? [];
  const diffChangedFiles = diffSummary?.changedFiles ?? resultChangedFiles;
  const hasDiffChanges = diffSummary?.hasChanges ?? resultChangedFiles.length > 0;
  const toolCalls = run.result?.toolCalls ?? [];
  const agentMessages = run.result?.agentMessages ?? [];
  const reasoningSummaries = run.result?.reasoningSummaries ?? [];
  const currentRunId = run.id;

  async function decideApproval(approval: ApprovalRecord, decision: "approve" | "deny") {
    setDecisionError(null);
    setDecidingApprovalId(approval.id);
    try {
      if (decision === "approve") {
        await api.approveApproval(approval.id, `Professional mode approved ${approval.kind} for run ${currentRunId}.`);
      } else {
        await api.denyApproval(approval.id, `Professional mode denied ${approval.kind} for run ${currentRunId}.`);
      }
      const nextSnapshot = await api.getSnapshot();
      setSnapshot(nextSnapshot);
      const nextRun = nextSnapshot.agentRuns.find((item) => item.id === currentRunId);
      if (nextRun) {
        setRun(nextRun);
        setLastUpdated(new Date());
      }
    } catch (nextError) {
      setDecisionError(nextError instanceof Error ? nextError.message : "审批操作失败。");
    } finally {
      setDecidingApprovalId(null);
    }
  }

  return (
    <AppShell>
      <div className="two-col">
        <section className="grid">
          <div className="card">
            <div className="card-header">
              <div>
                <span className={`status-pill ${runStatusTone(run.status)}`}>
                  <Clock size={14} />
                  {visibleRunStatusLabel(run, currentRunAccepted)}
                </span>
                <h1 style={{ margin: "12px 0 0", fontSize: 34 }}>PatchPilot 正在推进这次任务</h1>
                <p className="muted">
                  {lastUpdated ? `最后更新于 ${lastUpdated.toLocaleTimeString()}` : "等待第一条事件"}
                </p>
              </div>
            </div>
            <div className="card-body grid">
              <StatusNotice
                title={connection === "live" ? "实时更新已连接" : "当前正在读取最新快照"}
                tone={connection === "live" ? "success" : "info"}
              >
                {connection === "live"
                  ? "页面会随 agent 事件自动刷新。"
                  : "实时事件断开时会回退到一次快照读取，最终状态仍会展示在这里。"}
              </StatusNotice>
              {error ? (
                <StatusNotice title="状态更新遇到问题" tone="error">
                  {error}
                </StatusNotice>
              ) : null}
              {run.status === "failed" ? (
                <StatusNotice title="这次执行失败了" tone="error">
                  {run.failureType ? `${failureTypeLabels[run.failureType]}：` : ""}
                  {run.failureSummary ?? "runner 没有返回更详细的失败摘要。"} 请返回工作台重新提交，或让主线程查看后端日志。
                </StatusNotice>
              ) : null}
              {run.status === "needs_approval" && pendingRunApprovals.length > 0 ? (
                <StatusNotice title="这次执行等待审批" tone="warning">
                  {pendingRunApprovals.map((approval) => approvalKindLabels[approval.kind]).join("、")} 需要处理。
                </StatusNotice>
              ) : null}
              <div className="stepper">
                {run.timeline.map((step) => (
                  <div className={`step ${step.status}`} key={step.key}>
                    <span className="step-dot">
                      <StepIcon status={step.status} />
                    </span>
                    <span>
                      <strong>{step.label}</strong>
                      <br />
                      <span className="muted">{step.detail}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <h2>Agent team 进度</h2>
                <p className="muted" style={{ margin: "4px 0 0" }}>
                  同一个 PRD 下的后端、前端、测试和运维任务会在这里汇总。
                </p>
              </div>
              <span className={`status-pill ${failedTeamItems > 0 ? "red" : allTeamSucceeded ? "green" : "blue"}`}>
                {finishedTeamItems}/{totalTeamItems} 完成
              </span>
            </div>
            <div className="card-body grid">
              <div className="team-summary-grid">
                <div className="metric">
                  <span className="muted">团队任务</span>
                  <strong>{totalTeamItems}</strong>
                </div>
                <div className="metric">
                  <span className="muted">测试通过</span>
                  <strong>
                    {passedTeamTests}/{Math.max(teamTests.length, passedTeamTests)}
                  </strong>
                </div>
                <div className="metric">
                  <span className="muted">测试用例</span>
                  <strong>{teamTestCases.length}</strong>
                </div>
                <div className="metric">
                  <span className="muted">需要处理</span>
                  <strong>{failedTeamItems}</strong>
                </div>
              </div>
              <div className="team-run-list">
                {teamWorkItems.length > 0 ? (
                  teamWorkItems.map((item) => {
                    const itemRun = runsByWorkItem.get(item.id);
                    const agent = item.assignedAgentId ? agentsById.get(item.assignedAgentId) : undefined;
                    const itemAccepted = itemRun ? acceptedRunIds.has(itemRun.id) : false;
                    const itemRejected = itemRun ? rejectedRunIds.has(itemRun.id) : false;
                    const isRework = (item.reworkCount ?? 0) > 0 && !["done", "cancelled"].includes(item.status);
                    const showWorkItemStatus = ["blocked", "cancelled", "done"].includes(item.status) || itemAccepted || isRework;
                    return (
                      <div className="team-run-row" key={item.id}>
                        <div>
                          <span className="agent-role">{roleLabels[item.role]} agent</span>
                          <strong>{item.title}</strong>
                          <small>{agent?.name ?? "等待调度"} · {itemRun ? runnerLabel(itemRun.runner) : "尚未启动"}</small>
                          {isRework ? (
                            <small className="rework-reason">
                              返工第 {item.reworkCount} 轮
                              {item.lastRejectionReason ? ` · ${item.lastRejectionReason}` : ""}
                            </small>
                          ) : null}
                        </div>
                        <div className="team-run-actions">
                          <span
                            className={`status-pill ${
                              isRework
                                ? reworkStatusTone(item)
                                : showWorkItemStatus
                                  ? workItemTone(item.status)
                                  : itemRun
                                    ? runStatusTone(itemRun.status)
                                    : workItemTone(item.status)
                            }`}
                          >
                            {itemAccepted || item.status === "done"
                              ? "已完成"
                              : isRework || itemRejected
                                ? reworkStatusLabel(item)
                              : showWorkItemStatus
                                ? workItemStatusLabels[item.status]
                              : itemRun
                                ? runStatusLabel(itemRun.status)
                                : workItemStatusLabels[item.status]}
                          </span>
                          {itemRun ? (
                            <Link className="text-link" href={`/runs/${itemRun.id}`}>
                              查看
                            </Link>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <StatusNotice title="正在读取团队任务" tone="info">
                    团队快照加载后，会展示每个 agent 的任务和状态。
                  </StatusNotice>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h2>最近发生了什么</h2>
              <span className="status-pill">普通语言摘要</span>
            </div>
            <div className="card-body event-list">
              {run.events.length > 0 ? (
                run.events
                  .slice()
                  .reverse()
                  .map((event) => (
                    <div className="event" key={event.id}>
                      <strong>{event.message}</strong>
                      <br />
                      <span className="muted">{new Date(event.at).toLocaleTimeString()}</span>
                    </div>
                  ))
              ) : (
                <StatusNotice title="还没有运行事件" tone="info">
                  任务刚启动时会短暂出现这个状态。
                </StatusNotice>
              )}
            </div>
          </div>
        </section>

        <aside className="grid">
          <div className="card">
            <div className="card-header">
              <h3>证据摘要</h3>
            </div>
            <div className="card-body grid">
              {run.result ? (
                <>
                  <div className="metric">
                    <span className="muted">风险等级</span>
                    <strong>{run.result.riskLevel === "low" ? "低" : run.result.riskLevel}</strong>
                  </div>
                  <div className="metric">
                    <span className="muted">测试</span>
                    <strong>
                      {runTestRuns.length > 0
                        ? runTestRuns.every((test) => test.status === "passed")
                          ? "通过"
                          : "需处理"
                        : "暂无"}
                    </strong>
                  </div>
                  <div className="metric">
                    <span className="muted">PullRequest</span>
                    <strong>{runPullRequest ? pullRequestStatusLabel(runPullRequest.status) : "生成中"}</strong>
                  </div>
                  <div className="metric">
                    <span className="muted">ReviewRecord</span>
                    <strong>{runReview ? reviewStatusLabel(runReview.status) : "生成中"}</strong>
                  </div>
                  <div className="metric">
                    <span className="muted">成本</span>
                    <strong>{formatCost(run)}</strong>
                    <small>{formatCostMode(run)}</small>
                  </div>
                  <div className="metric">
                    <span className="muted">预算</span>
                    <strong>{formatCurrency(run.budgetUsd)}</strong>
                    <small>{budgetUsage.label}</small>
                  </div>
                  <div className="metric">
                    <span className="muted">失败类型</span>
                    <strong>{run.failureType ? failureTypeLabels[run.failureType] : "未记录"}</strong>
                    <small>{run.failureType ?? "当前没有失败分类"}</small>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {run.result.summary}
                  </p>
                  <StatusNotice title="下一步：验收结果" tone="success">
                    请查看团队摘要、测试和风险等级。如果不满意，可以在验收页要求修改。
                  </StatusNotice>
                  <button
                    className="button"
                    disabled={!allTeamSucceeded}
                    onClick={() => router.push(`/acceptance/${run.id}`)}
                    type="button"
                  >
                    查看结果并确认
                    <ExternalLink size={17} />
                  </button>
                </>
              ) : run.status === "failed" ? (
                <StatusNotice title="没有可验收结果" tone="error">
                  执行失败时不会进入验收。失败摘要和事件日志保留在左侧。
                </StatusNotice>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  完成测试和审查后，这里会展示改动摘要、测试结果和风险等级。
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <h3>预算和审批</h3>
                <p className="muted" style={{ margin: "4px 0 0" }}>
                  {formatCostMode(run)} {formatCost(run)} · 预算 {formatCurrency(run.budgetUsd)}
                </p>
              </div>
              <span className={`status-pill ${budgetUsage.tone}`}>
                <DollarSign size={14} />
                {budgetUsage.label}
              </span>
            </div>
            <div className="card-body grid">
              {decisionError ? (
                <StatusNotice title="审批操作失败" tone="error">
                  {decisionError}
                </StatusNotice>
              ) : null}
              <div className="team-summary-grid">
                <div className="metric">
                  <span className="muted">成本</span>
                  <strong>{formatCost(run)}</strong>
                  <small>{formatCostMode(run)}</small>
                </div>
                <div className="metric">
                  <span className="muted">运行预算</span>
                  <strong>{formatCurrency(run.budgetUsd)}</strong>
                  <small>软阈值 {formatCurrency(run.budgetSoftThresholdUsd)}</small>
                </div>
                <div className="metric">
                  <span className="muted">失败类型</span>
                  <strong>{run.failureType ? failureTypeLabels[run.failureType] : "未记录"}</strong>
                  <small>{run.failureType ?? "当前没有失败分类"}</small>
                </div>
              </div>
              <div className={`budget-meter ${budgetUsage.tone}`} aria-label={`预算使用率 ${budgetUsage.percent}%`}>
                <span style={{ width: `${budgetUsage.percent}%` }} />
              </div>
              {run.failureType ? (
                <span className={`status-pill ${failureTypeTone(run.failureType)}`}>
                  {run.failureType}
                </span>
              ) : null}
              <div className="event-list">
                {runApprovals.length ? (
                  runApprovals.map((approval) => (
                    <div className="event approval-event" key={approval.id}>
                      <div>
                        <strong>
                          <ShieldCheck size={16} />
                          {approvalKindLabels[approval.kind]} · {approvalShortId(approval.id)}
                        </strong>
                        <p className="muted" style={{ marginBottom: 0 }}>
                          {approval.requestedReason}
                        </p>
                        <small className="muted">
                          {approvalTargetLabels[approval.targetType]} · 到期 {formatShortDate(approval.expiresAt)}
                        </small>
                      </div>
                      <div className="approval-actions">
                        <span className={`status-pill ${approvalRiskTone(approval.riskLevel)}`}>
                          {approvalRiskLabels[approval.riskLevel]}
                        </span>
                        <span className={`status-pill ${approvalStatusTone(approval.status)}`}>
                          {approvalStatusLabels[approval.status]}
                        </span>
                        {approval.status === "pending" ? (
                          <>
                            <button
                              aria-label={`批准审批 ${approvalShortId(approval.id)}`}
                              className="button compact"
                              disabled={decidingApprovalId === approval.id}
                              onClick={() => void decideApproval(approval, "approve")}
                              type="button"
                            >
                              <Check size={15} />
                              批准
                            </button>
                            <button
                              aria-label={`拒绝审批 ${approvalShortId(approval.id)}`}
                              className="button compact secondary"
                              disabled={decidingApprovalId === approval.id}
                              onClick={() => void decideApproval(approval, "deny")}
                              type="button"
                            >
                              <X size={15} />
                              拒绝
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="empty-copy">这个 run 没有关联审批记录。</p>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>运行捕获</h3>
              <span className="status-pill">{toolCalls.length} 个工具调用</span>
            </div>
            <div className="card-body grid">
              {run.result ? (
                <>
                  <div className="metric">
                    <span className="muted">Diff</span>
                    <strong>
                      {diffSummary?.changedFileCount ?? resultChangedFiles.length} 个文件
                    </strong>
                    <small className="muted">
                      {hasDiffChanges ? "包含代码变更" : "未产生变更"}
                    </small>
                  </div>
                  {diffChangedFiles.length > 0 ? (
                    <div className="event-list">
                      {diffChangedFiles.slice(0, 8).map((file) => (
                        <div className="event" key={file}>
                          <strong style={{ wordBreak: "break-word" }}>{file}</strong>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {toolCalls.length > 0 ? (
                    <div className="event-list">
                      {toolCalls.slice(0, 8).map((toolCall) => (
                        <div className="event" key={toolCall.id}>
                          <strong>{toolCall.name}</strong>
                          <p className="muted" style={{ marginBottom: 0, wordBreak: "break-word" }}>
                            {toolCall.command ?? toolCall.summary}
                          </p>
                          {toolCall.command ? (
                            <small className="muted" style={{ wordBreak: "break-word" }}>{toolCall.summary}</small>
                          ) : null}
                          <span className={`status-pill ${toolCallTone(toolCall.status)}`} style={{ marginTop: 10 }}>
                            {toolCall.status}
                            {typeof toolCall.exitCode === "number" ? ` · exit ${toolCall.exitCode}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <StatusNotice title="暂无结构化工具调用" tone="warning">
                      当前 runner 没有返回可展示的工具调用明细。
                    </StatusNotice>
                  )}
                  {agentMessages[0] ? (
                    <div className="event">
                      <strong>Agent message</strong>
                      <p className="muted" style={{ marginBottom: 0 }}>
                        {agentMessages[0]}
                      </p>
                    </div>
                  ) : null}
                  {reasoningSummaries[0] ? (
                    <div className="event">
                      <strong>Reasoning summary</strong>
                      <p className="muted" style={{ marginBottom: 0 }}>
                        {reasoningSummaries[0]}
                      </p>
                    </div>
                  ) : null}
                  {run.result.testOutputSummary ? (
                    <div className="event">
                      <strong>Test output</strong>
                      <p className="muted" style={{ marginBottom: 0 }}>
                        {run.result.testOutputSummary}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  runner 完成后会展示结构化工具调用、diff 和测试输出摘要。
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>交付证据</h3>
              <span className="status-pill">{runAuditEvents.length} 条审计</span>
            </div>
            <div className="card-body event-list">
              {requirementArtifactReferences.length > 0 ? (
                <div className="event">
                  <strong>输入资料</strong>
                  <div style={{ marginTop: 10 }}>
                    <ArtifactReferenceList references={requirementArtifactReferences} />
                  </div>
                </div>
              ) : null}
              {runWorkspace ? (
                <div className="event">
                  <strong>WorkspaceRun · {runWorkspace.status}</strong>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {runWorkspace.isolation} · {runWorkspace.path}
                  </p>
                </div>
              ) : (
                <StatusNotice title="暂无工作区记录" tone="warning">
                  这个 run 还没有写入 workspace 证据。
                </StatusNotice>
              )}
              {runPullRequest ? (
                <div className="event">
                  <strong>
                    <GitPullRequest size={16} />
                    PullRequest · {pullRequestStatusLabel(runPullRequest.status)}
                  </strong>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {`${runPullRequest.branchName} -> ${runPullRequest.baseBranch}`} · {runPullRequest.url}
                  </p>
                  <span className={`status-pill ${pullRequestTone(runPullRequest.status)}`} style={{ marginTop: 10 }}>
                    {runPullRequest.provider}
                  </span>
                </div>
              ) : run.result ? (
                <StatusNotice title="暂无 PR 记录" tone="warning">
                  完成的 run 应写入 PullRequest 交付记录；请刷新快照或检查后端证据链。
                </StatusNotice>
              ) : null}
              {runReview ? (
                <div className="event">
                  <strong>
                    <ShieldCheck size={16} />
                    ReviewRecord · {reviewStatusLabel(runReview.status)}
                  </strong>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {runReview.summary}
                  </p>
                  <span className={`status-pill ${reviewTone(runReview.status)}`} style={{ marginTop: 10 }}>
                    {runReview.findings.length} 条发现
                  </span>
                </div>
              ) : run.result ? (
                <StatusNotice title="暂无审查记录" tone="warning">
                  完成的 run 应写入 ReviewRecord，关联 PR、测试和风险摘要。
                </StatusNotice>
              ) : null}
              {runTestCases.length > 0 ? (
                runTestCases.map((testCase) => (
                  <div className="event" key={testCase.id}>
                    <strong>TestCase · {testCaseStatusLabel(testCase.status)}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {testCase.title} · {testCase.steps[0] ?? "按验收标准执行"}
                    </p>
                  </div>
                ))
              ) : run.result ? (
                <StatusNotice title="暂无测试用例" tone="warning">
                  完成的 run 应关联可复用 TestCase，方便从 PRD 追溯到测试证据。
                </StatusNotice>
              ) : null}
              {runTestRuns.length > 0 ? (
                runTestRuns.map((test) => (
                  <div className="event" key={test.id}>
                    <strong>TestRun · {test.status}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {test.command} · {test.durationMs}ms
                    </p>
                  </div>
                ))
              ) : (
                <StatusNotice title="暂无测试记录" tone="warning">
                  测试完成后会在这里显示平台级 TestRun。
                </StatusNotice>
              )}
              {runAuditEvents.length > 0 ? (
                runAuditEvents.map((event) => (
                  <div className="event" key={event.id}>
                    <strong>{event.action}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {event.message}
                    </p>
                  </div>
                ))
              ) : null}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>执行模式</h3>
            </div>
            <div className="card-body grid">
              <StatusNotice
                title={`当前为${runnerLabel(run.runner)}`}
                tone="info"
              >
                Codex 会在隔离 worktree 中开发、测试并返回证据；验收通过后仍不会自动合并。
              </StatusNotice>
              {run.result?.workspacePath ? (
                <div className="metric">
                  <span className="muted">工作区</span>
                  <strong>{run.result.workspacePath}</strong>
                </div>
              ) : null}
              <Link className="button secondary" href="/">
                返回工作台
              </Link>
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
