"use client";

import type {
  AgentRun,
  ApprovalRecord,
  AuditChainVerification,
  BugReport,
  PatchPilotSnapshot,
  Requirement,
  TestCase,
  WorkItem
} from "@patchpilot/domain";
import {
  Activity,
  AlertTriangle,
  Bug,
  Check,
  ClipboardList,
  DollarSign,
  FileCheck2,
  GitPullRequest,
  Paperclip,
  ShieldCheck,
  X
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ProductMetricsDashboard } from "@/components/ProductMetricsDashboard";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";
import { computeProductMetrics } from "@/lib/productMetrics";
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
  runBudgetUsage,
  runShortId
} from "@/lib/professionalMode";

const requirementStatusLabels: Record<Requirement["status"], string> = {
  submitted: "已提交",
  clarifying: "待澄清",
  prd_draft: "需求说明待确认",
  approved: "已批准",
  rejected: "已拒绝"
};

const workItemStatusLabels: Record<WorkItem["status"], string> = {
  proposed: "待规划",
  ready: "可执行",
  claimed: "已领取",
  running: "执行中",
  review: "审查中",
  blocked: "阻塞",
  done: "完成",
  cancelled: "取消"
};

const roleLabels: Record<WorkItem["role"], string> = {
  product: "产品",
  frontend: "前端",
  backend: "后端",
  test: "测试",
  ops: "运维",
  reviewer: "审查"
};

const runStatusLabels: Record<AgentRun["status"], string> = {
  queued: "排队中",
  running: "执行中",
  needs_approval: "等待批准",
  succeeded: "待验收",
  failed: "失败",
  cancelled: "取消"
};

const testCaseStatusLabels: Record<TestCase["status"], string> = {
  draft: "草稿",
  ready: "待执行",
  passed: "已通过",
  failed: "未通过",
  blocked: "阻塞"
};

const bugStatusLabels: Record<BugReport["status"], string> = {
  reported: "已报告",
  needs_repro: "待复现",
  reproduced: "已复现",
  unreproducible: "无法复现",
  fixing: "修复中",
  verifying: "验证中",
  closed: "已关闭"
};

function statusTone(status: Requirement["status"] | WorkItem["status"] | AgentRun["status"] | TestCase["status"] | BugReport["status"]) {
  if (["approved", "done", "succeeded", "passed", "closed"].includes(status)) return "green";
  if (["rejected", "blocked", "failed", "cancelled", "unreproducible"].includes(status)) return "red";
  if (["prd_draft", "review", "needs_approval", "ready", "reported", "needs_repro", "reproduced", "fixing", "verifying"].includes(status)) return "amber";
  return "blue";
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

function sortByDate<T>(items: T[], getDate: (item: T) => string | undefined) {
  return [...items].sort((left, right) => {
    const leftTime = new Date(getDate(left) ?? 0).getTime();
    const rightTime = new Date(getDate(right) ?? 0).getTime();
    return rightTime - leftTime;
  });
}

function approvalSortDate(approval: ApprovalRecord) {
  return approval.updatedAt ?? approval.createdAt;
}

export default function ControlPage() {
  const [snapshot, setSnapshot] = useState<PatchPilotSnapshot | null>(null);
  const [auditVerification, setAuditVerification] = useState<AuditChainVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decidingApprovalId, setDecidingApprovalId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const [nextSnapshot, nextAuditVerification] = await Promise.all([
          api.getSnapshot(),
          api.verifyAudit().catch(() => null)
        ]);
        if (cancelled) return;
        setSnapshot(nextSnapshot);
        setAuditVerification(nextAuditVerification);
        setError(null);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "专业控制台加载失败。");
        }
      }
    }

    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  const requirements = snapshot?.requirements ?? [];
  const prds = snapshot?.prds ?? [];
  const workItems = snapshot?.workItems ?? [];
  const bugs = snapshot?.bugs ?? [];
  const testCases = snapshot?.testCases ?? [];
  const runs = snapshot?.agentRuns ?? [];
  const reviewRecords = snapshot?.reviewRecords ?? [];
  const artifacts = snapshot?.artifacts ?? [];
  const auditEvents = snapshot?.auditEvents ?? [];
  const pullRequests = snapshot?.pullRequests ?? [];
  const approvals = snapshot?.approvals ?? [];
  const openWorkItems = workItems.filter((item) => !["done", "cancelled"].includes(item.status));
  const openBugs = bugs.filter((bug) => !["closed", "unreproducible"].includes(bug.status));
  const failedRuns = runs.filter((run) => run.status === "failed" || run.status === "cancelled");
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const budgetedRuns = runs.filter((run) => run.budgetUsd !== undefined || run.budgetSoftThresholdUsd !== undefined);
  const totalRunCost = runs.reduce((total, run) => total + (run.costActualUsd ?? run.costEstimateUsd), 0);
  const totalRunBudget = budgetedRuns.reduce((total, run) => total + (run.budgetUsd ?? 0), 0);
  const overBudgetRuns = budgetedRuns.filter((run) => runBudgetUsage(run).tone === "red");
  const recentRequirements = sortByDate(requirements, (item) => item.updatedAt).slice(0, 8);
  const visibleWorkItems = sortByDate(workItems, (item) => item.updatedAt ?? item.createdAt).slice(0, 10);
  const visibleTestCases = sortByDate(testCases, (item) => item.updatedAt).slice(0, 10);
  const visibleRuns = sortByDate(runs, (item) => item.startedAt).slice(0, 10);
  const visibleApprovals = sortByDate(approvals, approvalSortDate).slice(0, 10);
  const visibleBudgetRuns = sortByDate(budgetedRuns.length ? budgetedRuns : runs, (item) => item.startedAt).slice(0, 8);
  const visibleAuditEvents = sortByDate(auditEvents, (item) => item.createdAt).slice(0, 10);
  const productMetrics = snapshot ? computeProductMetrics(snapshot, { auditVerification }) : null;

  async function decideApproval(approval: ApprovalRecord, decision: "approve" | "deny") {
    setDecisionError(null);
    setDecidingApprovalId(approval.id);
    try {
      if (decision === "approve") {
        await api.approveApproval(approval.id, `Professional mode approved ${approval.kind} for ${approval.targetType}.`);
      } else {
        await api.denyApproval(approval.id, `Professional mode denied ${approval.kind} for ${approval.targetType}.`);
      }
      const nextSnapshot = await api.getSnapshot();
      setSnapshot(nextSnapshot);
    } catch (nextError) {
      setDecisionError(nextError instanceof Error ? nextError.message : "审批操作失败。");
    } finally {
      setDecidingApprovalId(null);
    }
  }

  return (
    <AppShell>
      <section className="section-heading">
        <div>
          <span className="eyebrow compact">
            <ClipboardList size={15} />
            专业模式
          </span>
          <h1 style={{ margin: "12px 0 0", fontSize: 42 }}>专业控制台</h1>
          <p className="muted" style={{ margin: "10px 0 0", maxWidth: 760, lineHeight: 1.6 }}>
            集中查看需求、工作项、bug、测试用例、Agent Run、PR 和审计事件，方便项目负责人判断 agent team 是否真实推进。
          </p>
        </div>
      </section>

      <div className="grid" style={{ marginTop: 26 }}>
        {error ? (
          <StatusNotice title="专业控制台暂时不可用" tone="error">
            {error}
          </StatusNotice>
        ) : null}
        {!snapshot && !error ? (
          <StatusNotice title="正在同步项目事实" tone="info">
            正在读取 control plane snapshot。
          </StatusNotice>
        ) : null}

        <div className="summary-strip">
          <div className="summary-stat">
            <span className="muted">需求</span>
            <strong>{requirements.length} 个需求</strong>
          </div>
          <div className="summary-stat">
            <span className="muted">工作项</span>
            <strong>{workItems.length} 个工作项</strong>
            <small className="muted">{openWorkItems.length} 个未完成</small>
          </div>
          <div className="summary-stat">
            <span className="muted">Bug</span>
            <strong>{bugs.length} 个 bug</strong>
            <small className="muted">{openBugs.length} 个待处理</small>
          </div>
          <div className="summary-stat">
            <span className="muted">测试用例</span>
            <strong>{testCases.length} 条测试用例</strong>
          </div>
          <div className="summary-stat">
            <span className="muted">Agent Run</span>
            <strong>{runs.length} 个 Agent Run</strong>
            <small className="muted">{failedRuns.length} 个失败或取消</small>
          </div>
          <div className={`summary-stat ${pendingApprovals.length ? "attention" : ""}`}>
            <span className="muted">审批</span>
            <strong>{pendingApprovals.length} 个待处理</strong>
            <small className="muted">{approvals.length} 条审批记录</small>
          </div>
          <div className={`summary-stat ${overBudgetRuns.length ? "attention" : ""}`}>
            <span className="muted">成本 / 预算</span>
            <strong>{formatCurrency(totalRunCost)}</strong>
            <small className="muted">{totalRunBudget > 0 ? `${formatCurrency(totalRunBudget)} 运行预算` : "未设置运行预算"}</small>
          </div>
          <div className="summary-stat">
            <span className="muted">审计</span>
            <strong>{auditEvents.length} 条审计事件</strong>
          </div>
          <div className="summary-stat">
            <span className="muted">输入资料</span>
            <strong>{artifacts.filter((artifact) => artifact.kind === "intake_attachment").length} 个引用</strong>
          </div>
        </div>

        {decisionError ? (
          <StatusNotice title="审批操作失败" tone="error">
            {decisionError}
          </StatusNotice>
        ) : null}

        <ProductMetricsDashboard metrics={productMetrics} />

        <div className="dashboard-grid">
          <section aria-label="需求管理" className="dashboard-panel">
            <div className="panel-title">
              <h3>需求管理</h3>
              <span className="status-pill">{requirements.length} 个</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {recentRequirements.length ? (
                recentRequirements.map((requirement) => {
                  const prdIds = prds
                    .filter((prd) => prd.requirementId === requirement.id)
                    .map((prd) => prd.id);
                  const requirementWorkItems = workItems.filter((item) => prdIds.includes(item.prdId));
                  const requirementRuns = runs.filter((run) => prdIds.includes(run.prdId));
                  const requirementTestCases = testCases.filter((testCase) => prdIds.includes(testCase.prdId));
                  const requirementReviews = reviewRecords.filter((review) => prdIds.includes(review.prdId));
                  const artifactCount = requirement.artifactReferences?.length ?? 0;

                  return (
                    <Link className="dashboard-row" href={`/requirements/${requirement.id}/confirm`} key={requirement.id}>
                      <span>
                        <strong>{requirement.simpleSummary}</strong>
                        <small>
                          {requirementStatusLabels[requirement.status]} · {formatShortDate(requirement.updatedAt)}
                        </small>
                        <small>
                          {requirementWorkItems.length} 个工作项 · {requirementRuns.length} 个 Agent Run ·{" "}
                          {requirementTestCases.length} 条测试用例 · {requirementReviews.length} 条审查证据
                        </small>
                        {artifactCount > 0 ? (
                          <small>
                            <Paperclip size={13} />
                            {artifactCount} 个输入资料引用
                          </small>
                        ) : null}
                      </span>
                      <span className={`status-pill ${statusTone(requirement.status)}`}>
                        {requirementStatusLabels[requirement.status]}
                      </span>
                    </Link>
                  );
                })
              ) : (
                <p className="empty-copy">还没有需求。提交一个想法后，这里会显示 PRD 和交付证据计数。</p>
              )}
            </div>
          </section>

          <section aria-label="工作项看板" className="dashboard-panel">
            <div className="panel-title">
              <h3>工作项看板</h3>
              <span className="status-pill">{openWorkItems.length} 个未完成</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleWorkItems.length ? (
                visibleWorkItems.map((item) => (
                  <div className="dashboard-row" key={item.id}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>
                        {roleLabels[item.role]} agent · {item.scope}
                      </small>
                      {(item.reworkCount ?? 0) > 0 ? (
                        <small className="rework-reason">
                          返工第 {item.reworkCount} 轮
                          {item.lastRejectionReason ? ` · ${item.lastRejectionReason}` : ""}
                        </small>
                      ) : null}
                    </span>
                    <span className={`status-pill ${statusTone(item.status)}`}>{workItemStatusLabels[item.status]}</span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">PRD 批准后会生成可领取的工作项。</p>
              )}
            </div>
          </section>

          <section aria-label="Bug 队列" className="dashboard-panel">
            <div className="panel-title">
              <h3>Bug 队列</h3>
              <span className="status-pill">{openBugs.length} 个待处理</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {bugs.length ? (
                sortByDate(bugs, (bug) => bug.updatedAt).slice(0, 8).map((bug) => (
                  <div className="dashboard-row" key={bug.id}>
                    <span>
                      <strong>{bug.title}</strong>
                      <small>
                        {bug.severity} · {bug.expectedBehavior}
                      </small>
                      {(bug.artifactReferences?.length ?? 0) > 0 ? (
                        <small>
                          <Paperclip size={13} />
                          {bug.artifactReferences?.length} 个输入资料引用
                        </small>
                      ) : null}
                    </span>
                    <span className={`status-pill ${statusTone(bug.status)}`}>{bugStatusLabels[bug.status]}</span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">通过“修 bug”模板提交问题后，测试 agent 会先复现，再交给开发 agent 修复。</p>
              )}
            </div>
          </section>

          <section aria-label="测试用例管理" className="dashboard-panel">
            <div className="panel-title">
              <h3>测试用例管理</h3>
              <span className="status-pill">{testCases.length} 条</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleTestCases.length ? (
                visibleTestCases.map((testCase) => (
                  <div className="dashboard-row" key={testCase.id}>
                    <span>
                      <strong>
                        <FileCheck2 size={16} />
                        {testCase.title}
                      </strong>
                      <small>
                        {testCase.kind} · {testCase.expectedResult}
                      </small>
                    </span>
                    <span className={`status-pill ${statusTone(testCase.status)}`}>
                      {testCaseStatusLabels[testCase.status]}
                    </span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">批准 PRD 后，平台会把验收标准映射成 TestCase。</p>
              )}
            </div>
          </section>

          <section aria-label="Agent Run 证据" className="dashboard-panel">
            <div className="panel-title">
              <h3>Agent Run 证据</h3>
              <span className="status-pill">{runs.length} 个</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleRuns.length ? (
                visibleRuns.map((run) => {
                  const changedFileCount = run.result?.diffSummary?.changedFileCount ?? run.result?.changedFiles.length ?? 0;
                  const toolCallCount = run.result?.toolCalls?.length ?? 0;
                  return (
                    <Link className="dashboard-row" href={`/runs/${run.id}`} key={run.id}>
                      <span>
                        <strong>
                          <Activity size={16} />
                          {run.id.replace(/^run_/, "").slice(0, 8)}
                        </strong>
                        <small>
                          {run.runner} · {run.currentStep} · {formatShortDate(run.startedAt)}
                        </small>
                        <small>
                          {formatCostMode(run)} {formatCost(run)} ·{" "}
                          {run.budgetUsd === undefined ? "未设置预算" : `预算 ${formatCurrency(run.budgetUsd)} · ${runBudgetUsage(run).label}`}
                        </small>
                        <small>
                          {changedFileCount} 个变更文件 · {toolCallCount} 个工具调用
                          {run.failureType ? ` · ${failureTypeLabels[run.failureType]}` : ""}
                        </small>
                      </span>
                      <span className={`status-pill ${statusTone(run.status)}`}>{runStatusLabels[run.status]}</span>
                    </Link>
                  );
                })
              ) : (
                <p className="empty-copy">工作项开始执行后会产生 Agent Run 记录。</p>
              )}
            </div>
          </section>

          <section aria-label="交付审计" className="dashboard-panel">
            <div className="panel-title">
              <h3>交付审计</h3>
              <span className="status-pill">{auditEvents.length} 条</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleAuditEvents.length ? (
                visibleAuditEvents.map((event) => (
                  <div className="dashboard-row" key={event.id}>
                    <span>
                      <strong>
                        <ShieldCheck size={16} />
                        {event.action}
                      </strong>
                      <small>{event.message}</small>
                    </span>
                    <span className="status-pill">{formatShortDate(event.createdAt)}</span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">需求、执行、返工和验收会写入审计链路。</p>
              )}
            </div>
          </section>
        </div>

        <div className="dashboard-grid">
          <section aria-label="审批队列" className="dashboard-panel">
            <div className="panel-title">
              <h3>审批队列</h3>
              <span className={`status-pill ${pendingApprovals.length ? "amber" : "green"}`}>
                {pendingApprovals.length} 个待处理
              </span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleApprovals.length ? (
                visibleApprovals.map((approval) => (
                  <div className="dashboard-row approval-row" key={approval.id}>
                    <span>
                      <strong>
                        <ShieldCheck size={16} />
                        {approvalKindLabels[approval.kind]} · {approvalShortId(approval.id)}
                      </strong>
                      <small className="governance-detail">
                        {approval.requestedReason}
                      </small>
                      <small>
                        {approvalTargetLabels[approval.targetType]} · {approval.targetId.replace(/^(run_|wi_|prd_)/, "").slice(0, 12)} · 到期{" "}
                        {formatShortDate(approval.expiresAt)}
                      </small>
                    </span>
                    <span className="approval-actions">
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
                    </span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">当前没有审批记录。</p>
              )}
            </div>
          </section>

          <section aria-label="成本与预算" className="dashboard-panel">
            <div className="panel-title">
              <h3>成本与预算</h3>
              <span className={`status-pill ${overBudgetRuns.length ? "red" : "blue"}`}>
                {overBudgetRuns.length} 个超限
              </span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleBudgetRuns.length ? (
                visibleBudgetRuns.map((run) => {
                  const usage = runBudgetUsage(run);
                  return (
                    <Link className="dashboard-row" href={`/runs/${run.id}`} key={run.id}>
                      <span>
                        <strong>
                          <DollarSign size={16} />
                          {runShortId(run.id)}
                        </strong>
                        <small>
                          {formatCostMode(run)} {formatCost(run)} · 预算 {formatCurrency(run.budgetUsd)}
                        </small>
                        <small>
                          软阈值 {formatCurrency(run.budgetSoftThresholdUsd)} · {run.status === "needs_approval" ? "等待预算审批" : runStatusLabels[run.status]}
                        </small>
                      </span>
                      <span className={`status-pill ${usage.tone}`}>{usage.label}</span>
                    </Link>
                  );
                })
              ) : (
                <p className="empty-copy">Agent Run 启动后会显示成本估算、实际成本和预算阈值。</p>
              )}
            </div>
          </section>
        </div>

        <div className="dashboard-grid">
          <section className="dashboard-panel">
            <div className="panel-title">
              <h3>PR 交付</h3>
              <span className="status-pill">{pullRequests.length} 个</span>
            </div>
            <div className="dashboard-list compact-list-panel">
              {pullRequests.length ? (
                sortByDate(pullRequests, (pullRequest) => pullRequest.createdAt).slice(0, 8).map((pullRequest) => (
                  <div className="dashboard-row" key={pullRequest.id}>
                    <span>
                      <strong>
                        <GitPullRequest size={16} />
                        {pullRequest.title}
                      </strong>
                      <small>
                        {pullRequest.branchName} {"->"} {pullRequest.baseBranch}
                      </small>
                    </span>
                    <span className="status-pill">{pullRequest.status}</span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">成功的 agent run 会生成本地 PullRequest 交付记录。</p>
              )}
            </div>
          </section>

          <section className="dashboard-panel">
            <div className="panel-title">
              <h3>风险队列</h3>
              <span className="status-pill">{failedRuns.length + openBugs.length} 个线索</span>
            </div>
            <div className="rework-stack">
              {failedRuns.length || openBugs.length ? (
                <>
                  {failedRuns.slice(0, 4).map((run) => (
                    <div className="rework-item" key={run.id}>
                      <AlertTriangle size={18} />
                      <span>
                        <strong>{runStatusLabels[run.status]} · {runShortId(run.id)}</strong>
                        <small>
                          {run.failureType ? `${failureTypeLabels[run.failureType]} · ` : ""}
                          {run.failureSummary ?? "需要查看 Agent Run 证据。"}
                        </small>
                        {run.failureType ? (
                          <span className={`status-pill ${failureTypeTone(run.failureType)}`} style={{ marginTop: 8 }}>
                            {run.failureType}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ))}
                  {openBugs.slice(0, 4).map((bug) => (
                    <div className="rework-item" key={bug.id}>
                      <Bug size={18} />
                      <span>
                        <strong>{bug.title}</strong>
                        <small>{bugStatusLabels[bug.status]} · {bug.reproductionSteps}</small>
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <p className="empty-copy">当前没有失败 run 或待处理 bug。</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </AppShell>
  );
}
