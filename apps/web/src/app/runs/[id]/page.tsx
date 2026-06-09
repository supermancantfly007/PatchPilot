"use client";

import type { AgentRun } from "@patchpilot/domain";
import { AlertTriangle, CheckCircle2, Circle, Clock, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

function StepIcon({ status }: { status: AgentRun["timeline"][number]["status"] }) {
  if (status === "done") return <CheckCircle2 size={18} />;
  if (status === "active") return <Loader2 size={18} />;
  if (status === "failed") return <AlertTriangle size={18} />;
  return <Circle size={16} />;
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  useEffect(() => {
    const source = new EventSource(api.eventSourceUrl(id));
    source.onmessage = (event) => {
      setRun(JSON.parse(event.data) as AgentRun);
      setLastUpdated(new Date());
    };
    source.onerror = () => {
      source.close();
      void api.getRun(id).then((nextRun) => {
        setRun(nextRun);
        setLastUpdated(new Date());
      });
    };
    return () => source.close();
  }, [id]);

  if (!run) {
    return (
      <AppShell>
        <div className="card">
          <div className="card-body">正在连接 agent run...</div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="two-col">
        <section className="grid">
          <div className="card">
            <div className="card-header">
              <div>
                <span className={`status-pill ${run.status === "succeeded" ? "green" : "blue"}`}>
                  <Clock size={14} />
                  {run.status === "succeeded" ? "等待你确认" : "执行中"}
                </span>
                <h1 style={{ margin: "12px 0 0", fontSize: 34 }}>PatchPilot 正在推进这次任务</h1>
                <p className="muted">
                  {lastUpdated ? `最后更新于 ${lastUpdated.toLocaleTimeString()}` : "等待第一条事件"}
                </p>
              </div>
            </div>
            <div className="card-body">
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
              <h2>最近发生了什么</h2>
              <span className="status-pill">普通语言摘要</span>
            </div>
            <div className="card-body event-list">
              {run.events
                .slice()
                .reverse()
                .map((event) => (
                  <div className="event" key={event.id}>
                    <strong>{event.message}</strong>
                    <br />
                    <span className="muted">{new Date(event.at).toLocaleTimeString()}</span>
                  </div>
                ))}
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
                    <strong>{run.result.tests.every((test) => test.status === "passed") ? "通过" : "需处理"}</strong>
                  </div>
                  <div className="metric">
                    <span className="muted">成本</span>
                    <strong>${run.costActualUsd?.toFixed(2) ?? run.costEstimateUsd.toFixed(2)}</strong>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {run.result.summary}
                  </p>
                  <button className="button" onClick={() => router.push(`/acceptance/${run.id}`)} type="button">
                    查看结果并确认
                    <ExternalLink size={17} />
                  </button>
                </>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  完成测试和审查后，这里会展示改动摘要、测试结果和风险等级。
                </p>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <h3>专业入口</h3>
            </div>
            <div className="card-body">
              <p className="muted">AgentRun、WorkspaceRun、TestRun 和审计详情后续会在专业视图中展开。</p>
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
