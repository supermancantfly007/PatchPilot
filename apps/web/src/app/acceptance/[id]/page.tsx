"use client";

import type { AgentRun } from "@patchpilot/domain";
import { CheckCircle2, FileCode2, ShieldCheck, TestTube2, XCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

export default function AcceptancePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.getRun(id).then(setRun);
  }, [id]);

  async function decide(status: "accepted" | "rejected") {
    setSaving(true);
    try {
      await api.acceptRun(id, status, reason);
      router.push("/");
    } finally {
      setSaving(false);
    }
  }

  if (!run) {
    return (
      <AppShell>
        <div className="card">
          <div className="card-body">正在加载验收结果...</div>
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
                <button className="button" disabled={saving} onClick={() => void decide("accepted")} type="button">
                  <CheckCircle2 size={17} />
                  接受结果
                </button>
                <button
                  className="button secondary"
                  disabled={saving}
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
              {result?.tests.map((test) => (
                <div className="event" key={test.id}>
                  <strong>{test.command}</strong>
                  <p className="muted" style={{ marginBottom: 0 }}>
                    {test.summary} · {test.durationMs}ms
                  </p>
                </div>
              ))}
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
