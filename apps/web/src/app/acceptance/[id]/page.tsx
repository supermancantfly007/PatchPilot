"use client";

import type { AgentRun } from "@patchpilot/domain";
import { CheckCircle2, FileCode2, ShieldCheck, TestTube2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";

function runnerLabel(runner: AgentRun["runner"]) {
  return runner === "codex" ? "本地 Codex runner" : "本地 MVP 模拟执行";
}

export default function AcceptancePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void api.getRun(id).then(setRun).catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "验收结果加载失败。");
    });
  }, [id]);

  async function decide(status: "accepted" | "rejected") {
    if (status === "rejected" && !reason.trim()) {
      setError("要求修改前，请写清楚哪里不对以及期望结果。");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.acceptRun(id, status, reason);
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

  return (
    <AppShell>
      <div className="two-col">
        <section className="grid">
          <div className="card">
            <div className="card-header">
              <div>
                <span className="status-pill green">
                  <CheckCircle2 size={14} />
                  可验收
                </span>
                <h1 style={{ margin: "12px 0 0", fontSize: 34 }}>这次 agent 交付完成了</h1>
              </div>
            </div>
            <div className="card-body grid">
              {run.status !== "succeeded" ? (
                <StatusNotice title="这次执行还不能验收" tone="warning">
                  当前状态是 {run.status}。只有执行成功后才能接受结果或要求修改。
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
              <div className="evidence-grid">
                <div className="metric">
                  <FileCode2 size={18} />
                  <span className="muted">变更范围</span>
                  <strong>{result?.changedFiles.length ?? 0} 组文件</strong>
                </div>
                <div className="metric">
                  <TestTube2 size={18} />
                  <span className="muted">测试结果</span>
                  <strong>{result?.tests.every((test) => test.status === "passed") ? "通过" : "需处理"}</strong>
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
                  disabled={saving || run.status !== "succeeded"}
                  onClick={() => void decide("accepted")}
                  type="button"
                >
                  <CheckCircle2 size={17} />
                  {saving ? "提交中" : "接受结果"}
                </button>
                <button
                  className="button secondary"
                  disabled={saving || run.status !== "succeeded"}
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
              {result?.tests.length ? (
                result.tests.map((test) => (
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
              {result?.workspacePath ? (
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
