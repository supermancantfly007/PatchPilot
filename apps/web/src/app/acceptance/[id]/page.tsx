"use client";

import type {
  AgentProfile,
  AgentRun,
  PatchPilotSnapshot,
  PullRequestRecord,
  ReviewRecord,
  TestCase,
  WorkItem
} from "@patchpilot/domain";
import { CheckCircle2, FileCode2, GitPullRequest, ShieldCheck, TestTube2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ArtifactReferenceList } from "@/components/ArtifactReferenceList";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";

type AgentRunResult = NonNullable<AgentRun["result"]>;
type DeliveryRun = {
  item?: WorkItem;
  run: AgentRun;
  result: AgentRunResult;
};

function runnerLabel(runner: AgentRun["runner"]) {
  return runner === "codex" ? "本地 Codex runner" : "本地 MVP 模拟执行";
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

function runStatusLabel(status: AgentRun["status"]) {
  const labels: Record<AgentRun["status"], string> = {
    queued: "排队中",
    running: "执行中",
    needs_approval: "等待批准",
    succeeded: "可验收",
    failed: "失败",
    cancelled: "取消"
  };
  return labels[status];
}

function runStatusTone(status: AgentRun["status"]) {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "needs_approval") return "amber";
  return "blue";
}

function workItemStatusLabel(status: WorkItem["status"]) {
  if (status === "done") return "已完成";
  if (status === "blocked") return "需处理";
  if (status === "cancelled") return "已取消";
  return "未启动";
}

function workItemStatusTone(status: WorkItem["status"]) {
  if (status === "done") return "green";
  if (status === "blocked" || status === "cancelled") return "red";
  return "amber";
}

function reworkStatusLabel(item: WorkItem) {
  if (item.status === "ready") return "待返工";
  if (item.status === "claimed" || item.status === "running") return "返工中";
  if (item.status === "review") return "返工待验收";
  return workItemStatusLabel(item.status);
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

function latestRunByWorkItem(runs: AgentRun[]) {
  const byWorkItem = new Map<string, AgentRun>();
  for (const candidate of runs) {
    const current = byWorkItem.get(candidate.workItemId);
    if (!current || candidate.startedAt > current.startedAt) byWorkItem.set(candidate.workItemId, candidate);
  }
  return byWorkItem;
}

function riskLabel(riskLevel?: AgentRunResult["riskLevel"]) {
  const labels: Record<AgentRunResult["riskLevel"], string> = {
    low: "低",
    medium: "中",
    high: "高"
  };
  return riskLevel ? labels[riskLevel] : "未知";
}

function aggregateRiskLevel(results: AgentRunResult[]) {
  if (results.some((result) => result.riskLevel === "high")) return "high";
  if (results.some((result) => result.riskLevel === "medium")) return "medium";
  if (results.some((result) => result.riskLevel === "low")) return "low";
  return undefined;
}

export default function AcceptancePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [snapshot, setSnapshot] = useState<PatchPilotSnapshot | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void api.getRun(id).then(setRun).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "验收结果加载失败。");
    });
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
        if (nextRun) setRun(nextRun);
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "团队验收状态加载失败。");
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

  const teamRuns = run ? (snapshot?.agentRuns.filter((item) => item.prdId === run.prdId) ?? [run]) : [];
  const teamWorkItems = run
    ? [...(snapshot?.workItems.filter((item) => item.prdId === run.prdId) ?? [])].sort(
        (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role)
      )
    : [];
  const runsByWorkItem = latestRunByWorkItem(teamRuns);
  const agentsById = new Map<string, AgentProfile>((snapshot?.agents ?? []).map((agent) => [agent.id, agent]));
  const acceptedRunIds = new Set(
    (snapshot?.acceptances ?? []).filter((item) => item.status === "accepted").map((item) => item.runId)
  );
  const rejectedRunIds = new Set(
    (snapshot?.acceptances ?? []).filter((item) => item.status === "rejected").map((item) => item.runId)
  );
  const isTeamAcceptance = teamWorkItems.length > 1;
  const allTeamSucceeded =
    isTeamAcceptance && teamWorkItems.length > 0
      ? teamWorkItems.every((item) => {
          const itemRun = runsByWorkItem.get(item.id);
          return (itemRun?.status === "succeeded" && !rejectedRunIds.has(itemRun.id)) || item.status === "done";
        })
      : run?.status === "succeeded" && !rejectedRunIds.has(run.id);
  const targetRunCount = isTeamAcceptance ? teamWorkItems.length : 1;
  const succeededRunCount = isTeamAcceptance
    ? teamWorkItems.filter((item) => {
        const itemRun = runsByWorkItem.get(item.id);
        return (itemRun?.status === "succeeded" && !rejectedRunIds.has(itemRun.id)) || item.status === "done";
      }).length
    : run?.status === "succeeded" && !rejectedRunIds.has(run.id)
      ? 1
      : 0;

  async function decide(status: "accepted" | "rejected") {
    if (status === "rejected" && !reason.trim()) {
      setError("要求修改前，请写清楚哪里不对以及期望结果。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (run && isTeamAcceptance) {
        await api.acceptTeam(run.prdId, status, reason);
      } else {
        await api.acceptRun(id, status, reason);
      }
      router.push(status === "rejected" && run ? `/requirements/${run.requirementId}/confirm` : "/");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "验收提交失败。");
    } finally {
      setSaving(false);
    }
  }

  if (!run) {
    return (
      <AppShell>
        <div className="card">
          <div className="card-body grid">
            <StatusNotice title="正在加载验收结果" tone="info">
              请稍候，正在读取这次执行的摘要、测试和审查结论。
            </StatusNotice>
            {error ? (
              <StatusNotice title="加载失败" tone="error">
                {error}
              </StatusNotice>
            ) : null}
          </div>
        </div>
      </AppShell>
    );
  }

  const result = run.result;
  const visibleTestRuns = isTeamAcceptance
    ? (snapshot?.testRuns.filter((test) => test.prdId === run.prdId) ?? result?.tests ?? [])
    : (snapshot?.testRuns.filter((test) => test.runId === run.id) ?? result?.tests ?? []);
  const visibleTestCases = isTeamAcceptance
    ? (snapshot?.testCases.filter((testCase) => testCase.prdId === run.prdId) ?? [])
    : (snapshot?.testCases.filter((testCase) => testCase.workItemId === run.workItemId) ?? []);
  const visibleWorkspaceRuns = isTeamAcceptance
    ? (snapshot?.workspaceRuns.filter((workspace) => workspace.prdId === run.prdId) ?? [])
    : (snapshot?.workspaceRuns.filter((workspace) => workspace.runId === run.id) ?? []);
  const visiblePullRequests = isTeamAcceptance
    ? (snapshot?.pullRequests.filter((pullRequest) => pullRequest.prdId === run.prdId) ?? [])
    : (snapshot?.pullRequests.filter((pullRequest) => pullRequest.runId === run.id) ?? []);
  const visibleReviewRecords = isTeamAcceptance
    ? (snapshot?.reviewRecords.filter((review) => review.prdId === run.prdId) ?? [])
    : (snapshot?.reviewRecords.filter((review) => review.runId === run.id) ?? []);
  const visibleAuditEvents = (
    isTeamAcceptance
      ? (snapshot?.auditEvents.filter((event) => event.prdId === run.prdId) ?? [])
      : (snapshot?.auditEvents.filter((event) => event.runId === run.id) ?? [])
  ).slice(0, 6);
  const requirementArtifactReferences =
    snapshot?.requirements.find((requirement) => requirement.id === run.requirementId)?.artifactReferences ?? [];
  const deliveryRuns: DeliveryRun[] = (() => {
    if (isTeamAcceptance) {
      return teamWorkItems.reduce<DeliveryRun[]>((items, item) => {
        const itemRun = runsByWorkItem.get(item.id);
        if (itemRun?.result) items.push({ item, run: itemRun, result: itemRun.result });
        return items;
      }, []);
    }

    return result
      ? [{ item: teamWorkItems.find((item) => item.id === run.workItemId), run, result }]
      : [];
  })();
  const changedFileEntries = deliveryRuns.flatMap(({ item, result: itemResult }) =>
    itemResult.changedFiles.map((file) => ({
      key: `${item?.id ?? run.id}:${file}`,
      file,
      role: item ? roleLabels[item.role] : "执行"
    }))
  );
  const aggregateResultCount = deliveryRuns.length;
  const aggregateRisk = aggregateRiskLevel(deliveryRuns.map((item) => item.result));
  const passedTestCaseCount = visibleTestCases.filter((testCase) => testCase.status === "passed").length;
  const flakyTestCaseCount = visibleTestCases.filter((testCase) => testCase.flaky).length;
  const testCasePassRate = visibleTestCases.length > 0
    ? Math.round((passedTestCaseCount / visibleTestCases.length) * 100)
    : 0;

  return (
    <AppShell>
      <div className="two-col">
        <section className="grid">
          <div className="card">
            <div className="card-header">
              <div>
                <span className="status-pill green">
                  <CheckCircle2 size={14} />
                  {isTeamAcceptance ? `${succeededRunCount}/${targetRunCount} 可验收` : "可验收"}
                </span>
                <h1 style={{ margin: "12px 0 0", fontSize: 34 }}>这次 agent 交付完成了</h1>
              </div>
            </div>
            <div className="card-body grid">
              {!allTeamSucceeded ? (
                <StatusNotice title={isTeamAcceptance ? "团队任务还没全部完成" : "这次执行还不能验收"} tone="warning">
                  {isTeamAcceptance
                    ? "请等所有 agent run 都成功后，再一次性接受整组结果。"
                    : `当前状态是 ${run.status}。只有执行成功后才能接受结果或要求修改。`}
                </StatusNotice>
              ) : null}
              <StatusNotice
                title={`当前结果来自${runnerLabel(run.runner)}`}
                tone={run.runner === "codex" ? "success" : "warning"}
              >
                {run.runner === "codex"
                  ? "这是隔离 worktree 中的真实 Codex 执行证据；接受后仍需按仓库规则合并。"
                  : "它用于验证端到端验收体验，不代表真实仓库变更。"}
              </StatusNotice>
              {error ? (
                <StatusNotice title="验收提交没有成功" tone="error">
                  {error}
                </StatusNotice>
              ) : null}
              <div className="question-card" style={{ background: "white" }}>
                <strong>改了什么</strong>
                {isTeamAcceptance ? (
                  <div className="grid" style={{ gap: 10, marginTop: 10 }}>
                    <p style={{ margin: 0 }}>
                      {aggregateResultCount > 0
                        ? `${aggregateResultCount} 个 agent 已完成交付，下面是按角色汇总的交付摘要。`
                        : "团队执行已完成，暂无可展示的交付摘要。"}
                    </p>
                    {deliveryRuns.map(({ item, run: itemRun, result: itemResult }) => (
                      <p className="muted" key={`${item?.id ?? itemRun.id}:${itemResult.summary}`} style={{ margin: 0 }}>
                        <strong className="agent-role">
                          {item ? roleLabels[item.role] : "执行"} agent
                        </strong>{" "}
                        {itemResult.summary}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p style={{ margin: 0 }}>{result?.summary ?? "已完成执行，暂无摘要。"}</p>
                )}
              </div>
              {isTeamAcceptance ? (
                <div className="team-run-list">
                  {teamWorkItems.map((item) => {
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
                          <small>{agent?.name ?? "已由平台调度"} · {itemRun?.result?.tests.length ?? 0} 条测试证据</small>
                          {isRework ? (
                            <small className="rework-reason">
                              返工第 {item.reworkCount} 轮
                              {item.lastRejectionReason ? ` · ${item.lastRejectionReason}` : ""}
                            </small>
                          ) : null}
                        </div>
                        <span
                          className={`status-pill ${
                            isRework
                              ? reworkStatusTone(item)
                              : showWorkItemStatus
                                ? workItemStatusTone(item.status)
                                : itemRun
                                  ? runStatusTone(itemRun.status)
                                  : "amber"
                          }`}
                        >
                          {itemAccepted || item.status === "done"
                            ? "已完成"
                            : isRework || itemRejected
                              ? reworkStatusLabel(item)
                            : showWorkItemStatus
                              ? workItemStatusLabel(item.status)
                              : itemRun
                                ? runStatusLabel(itemRun.status)
                                : "未启动"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className="evidence-grid">
                <div className="metric">
                  <FileCode2 size={18} />
                  <span className="muted">变更范围</span>
                  <strong>{changedFileEntries.length} 组文件</strong>
                </div>
                <div className="metric">
                  <TestTube2 size={18} />
                  <span className="muted">测试结果</span>
                  <strong>
                    {visibleTestRuns.length > 0
                      ? visibleTestRuns.every((test) => test.status === "passed")
                        ? "通过"
                        : "需处理"
                    : "暂无"}
                  </strong>
                </div>
                <div className="metric">
                  <TestTube2 size={18} />
                  <span className="muted">测试用例通过率</span>
                  <strong>{visibleTestCases.length > 0 ? `${testCasePassRate}%` : "暂无"}</strong>
                  {visibleTestCases.length > 0 ? (
                    <small>
                      {passedTestCaseCount}/{visibleTestCases.length} 已通过
                      {flakyTestCaseCount > 0 ? ` · ${flakyTestCaseCount} flaky` : ""}
                    </small>
                  ) : null}
                </div>
                <div className="metric">
                  <ShieldCheck size={18} />
                  <span className="muted">风险等级</span>
                  <strong>{riskLabel(aggregateRisk)}</strong>
                </div>
                <div className="metric">
                  <GitPullRequest size={18} />
                  <span className="muted">PR 交付</span>
                  <strong>{visiblePullRequests.length} 个</strong>
                </div>
                <div className="metric">
                  <ShieldCheck size={18} />
                  <span className="muted">审查记录</span>
                  <strong>{visibleReviewRecords.length} 条</strong>
                </div>
                <div className="metric">
                  <FileCode2 size={18} />
                  <span className="muted">输入资料</span>
                  <strong>{requirementArtifactReferences.length} 个</strong>
                </div>
              </div>
              <div className="question-card" style={{ background: "white" }}>
                <strong>{isTeamAcceptance ? "团队审查摘要" : "Reviewer agent 摘要"}</strong>
                {isTeamAcceptance ? (
                  <div className="grid" style={{ gap: 10, marginTop: 10 }}>
                    {visibleReviewRecords.length > 0 ? (
                      visibleReviewRecords.map((review) => (
                        <p className="muted" key={review.id} style={{ margin: 0 }}>
                          {review.summary}
                        </p>
                      ))
                    ) : deliveryRuns.length > 0 ? (
                      deliveryRuns.map(({ item, run: itemRun, result: itemResult }) => (
                        <p className="muted" key={`${item?.id ?? itemRun.id}:review`} style={{ margin: 0 }}>
                          <strong className="agent-role">
                            {item ? roleLabels[item.role] : "执行"} agent
                          </strong>{" "}
                          {itemResult.reviewerSummary}
                        </p>
                      ))
                    ) : (
                      <p style={{ margin: 0 }}>暂无审查摘要。</p>
                    )}
                  </div>
                ) : (
                  <p style={{ margin: 0 }}>{result?.reviewerSummary ?? "暂无审查摘要。"}</p>
                )}
              </div>
              <textarea
                className="input"
                onChange={(event) => setReason(event.target.value)}
                placeholder="如果要求修改，请写下哪里不对、期望结果是什么。"
                style={{ minHeight: 96 }}
                value={reason}
              />
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  className="button"
                  disabled={saving || !allTeamSucceeded}
                  onClick={() => void decide("accepted")}
                  type="button"
                >
                  <CheckCircle2 size={17} />
                  {saving ? "提交中" : "接受结果"}
                </button>
                <button
                  className="button secondary"
                  disabled={saving || !allTeamSucceeded}
                  onClick={() => void decide("rejected")}
                  type="button"
                >
                  <XCircle size={17} />
                  要求修改
                </button>
              </div>
            </div>
          </div>
        </section>

        <aside className="grid">
          <div className="card">
            <div className="card-header">
              <h3>输入资料</h3>
              <span className="status-pill">{requirementArtifactReferences.length} 个</span>
            </div>
            <div className="card-body">
              <ArtifactReferenceList references={requirementArtifactReferences} />
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>测试用例</h3>
              <span className="status-pill">{visibleTestCases.length} 条</span>
            </div>
            <div className="card-body event-list">
              {visibleTestCases.length ? (
                visibleTestCases.map((testCase) => (
                  <div className="event" key={testCase.id}>
                    <strong>{testCase.title}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {testCaseStatusLabel(testCase.status)}
                      {testCase.flaky ? " · flaky" : ""}
                      {testCase.lastTestRunId ? ` · 最近 TestRun ${testCase.lastTestRunId}` : ""}
                      {" · "}
                      {testCase.steps[0] ?? "按验收标准执行"}
                    </p>
                  </div>
                ))
              ) : (
                <StatusNotice title="暂无测试用例" tone="warning">
                  PRD 批准后应生成可追溯到工作项的测试用例。
                </StatusNotice>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>测试证据</h3>
            </div>
            <div className="card-body event-list">
              {visibleTestRuns.length ? (
                visibleTestRuns.map((test) => (
                  <div className="event" key={test.id}>
                    <strong>{test.command}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {test.summary} · {test.durationMs}ms · {test.status}
                    </p>
                  </div>
                ))
              ) : (
                <StatusNotice title="暂无测试证据" tone="warning">
                  当前结果没有返回测试记录，接受前应由主线程确认 runner 输出。
                </StatusNotice>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>审查证据</h3>
              <span className="status-pill">{visibleReviewRecords.length} 条</span>
            </div>
            <div className="card-body event-list">
              {visibleReviewRecords.length > 0 ? (
                visibleReviewRecords.map((review) => (
                  <div className="event" key={review.id}>
                    <strong>
                      <ShieldCheck size={16} />
                      ReviewRecord · {reviewStatusLabel(review.status)}
                    </strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {review.summary}
                    </p>
                    <span className={`status-pill ${reviewTone(review.status)}`} style={{ marginTop: 10 }}>
                      {review.findings.length} 条发现
                    </span>
                  </div>
                ))
              ) : (
                <StatusNotice title="暂无审查记录" tone="warning">
                  验收前应看到每个完成 agent run 的 ReviewRecord。
                </StatusNotice>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>PR 交付</h3>
              <span className="status-pill">{visiblePullRequests.length} 个</span>
            </div>
            <div className="card-body event-list">
              {visiblePullRequests.length > 0 ? (
                visiblePullRequests.map((pullRequest) => (
                  <div className="event" key={pullRequest.id}>
                    <strong>
                      <GitPullRequest size={16} />
                      {pullRequest.title}
                    </strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {`${pullRequest.branchName} -> ${pullRequest.baseBranch}`} · {pullRequest.url}
                    </p>
                    <span className={`status-pill ${pullRequestTone(pullRequest.status)}`} style={{ marginTop: 10 }}>
                      {pullRequestStatusLabel(pullRequest.status)}
                    </span>
                  </div>
                ))
              ) : (
                <StatusNotice title="暂无 PR 交付记录" tone="warning">
                  验收前应看到每个完成 agent run 的 PullRequest 记录。
                </StatusNotice>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>变更范围</h3>
            </div>
            <div className="card-body">
              {visibleWorkspaceRuns.length > 0 ? (
                <div className="metric" style={{ marginBottom: 12 }}>
                  <span className="muted">工作区</span>
                  <strong>{visibleWorkspaceRuns.length} 个已归档</strong>
                </div>
              ) : result?.workspacePath ? (
                <div className="metric" style={{ marginBottom: 12 }}>
                  <span className="muted">工作区</span>
                  <strong>{result.workspacePath}</strong>
                </div>
              ) : null}
              {changedFileEntries.length ? (
                <ul className="compact-list">
                  {changedFileEntries.map((entry) => (
                    <li key={entry.key}>
                      {isTeamAcceptance ? `${entry.role} agent · ` : ""}
                      {entry.file}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  当前结果没有列出变更文件。
                </p>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>交付审计</h3>
              <span className="status-pill">{visibleAuditEvents.length} 条</span>
            </div>
            <div className="card-body event-list">
              {visibleAuditEvents.length > 0 ? (
                visibleAuditEvents.map((event) => (
                  <div className="event" key={event.id}>
                    <strong>{event.action}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {event.message}
                    </p>
                  </div>
                ))
              ) : (
                <StatusNotice title="暂无审计事件" tone="warning">
                  完成执行和验收后会写入平台审计链路。
                </StatusNotice>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-body">
              <p className="muted" style={{ margin: 0 }}>
                接受结果只代表平台验收通过，不等于自动合并或发布。合并仍走仓库现有规则。
              </p>
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
