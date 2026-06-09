"use client";

import type { AgentProfile, AgentRun, PatchPilotSnapshot, WorkItem } from "@patchpilot/domain";
import { CheckCircle2, FileCode2, ShieldCheck, TestTube2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";

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

function latestRunByWorkItem(runs: AgentRun[]) {
  const byWorkItem = new Map<string, AgentRun>();
  for (const candidate of runs) {
    const current = byWorkItem.get(candidate.workItemId);
    if (!current || candidate.startedAt > current.startedAt) byWorkItem.set(candidate.workItemId, candidate);
  }
  return byWorkItem;
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
  const isTeamAcceptance = teamWorkItems.length > 1;
  const allTeamSucceeded =
    isTeamAcceptance && teamWorkItems.length > 0
      ? teamWorkItems.every((item) => runsByWorkItem.get(item.id)?.status === "succeeded" || item.status === "done")
      : run?.status === "succeeded";
  const targetRunCount = isTeamAcceptance ? teamWorkItems.length : 1;
  const succeededRunCount = isTeamAcceptance
    ? teamWorkItems.filter((item) => runsByWorkItem.get(item.id)?.status === "succeeded" || item.status === "done").length
    : run?.status === "succeeded"
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
      router.push("/");
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
  const visibleWorkspaceRuns = isTeamAcceptance
    ? (snapshot?.workspaceRuns.filter((workspace) => workspace.prdId === run.prdId) ?? [])
    : (snapshot?.workspaceRuns.filter((workspace) => workspace.runId === run.id) ?? []);
  const visibleAuditEvents = (
    isTeamAcceptance
      ? (snapshot?.auditEvents.filter((event) => event.prdId === run.prdId) ?? [])
      : (snapshot?.auditEvents.filter((event) => event.runId === run.id) ?? [])
  ).slice(0, 6);

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
                <p style={{ margin: 0 }}>{result?.summary ?? "已完成执行，暂无摘要。"}</p>
              </div>
              {isTeamAcceptance ? (
                <div className="team-run-list">
                  {teamWorkItems.map((item) => {
                    const itemRun = runsByWorkItem.get(item.id);
                    const agent = item.assignedAgentId ? agentsById.get(item.assignedAgentId) : undefined;
                    const itemAccepted = itemRun ? acceptedRunIds.has(itemRun.id) : false;
                    const showWorkItemStatus = ["blocked", "cancelled", "done"].includes(item.status) || itemAccepted;
                    return (
                      <div className="team-run-row" key={item.id}>
                        <div>
                          <span className="agent-role">{roleLabels[item.role]} agent</span>
                          <strong>{item.title}</strong>
                          <small>{agent?.name ?? "已由平台调度"} · {itemRun?.result?.tests.length ?? 0} 条测试证据</small>
                        </div>
                        <span
                          className={`status-pill ${
                            showWorkItemStatus ? workItemStatusTone(item.status) : itemRun ? runStatusTone(itemRun.status) : "amber"
                          }`}
                        >
                          {itemAccepted || item.status === "done"
                            ? "已完成"
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
                  <strong>{result?.changedFiles.length ?? 0} 组文件</strong>
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
                  <ShieldCheck size={18} />
                  <span className="muted">风险等级</span>
                  <strong>{result?.riskLevel === "low" ? "低" : result?.riskLevel ?? "未知"}</strong>
                </div>
              </div>
              <div className="question-card" style={{ background: "white" }}>
                <strong>Reviewer agent 摘要</strong>
                <p style={{ margin: 0 }}>{result?.reviewerSummary ?? "暂无审查摘要。"}</p>
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
              {result?.changedFiles.length ? (
                <ul className="compact-list">
                  {result.changedFiles.map((file) => (
                    <li key={file}>{file}</li>
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
