"use client";

import type { AgentRun } from "@patchpilot/domain";
import { AlertTriangle, CheckCircle2, Circle, Clock, ExternalLink, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";

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

function runStatusTone(status: AgentRun["status"]) {
  if (status === "succeeded") return "green";
  if (status === "failed" || status === "cancelled") return "red";
  if (status === "needs_approval") return "amber";
  return "blue";
}

function runnerLabel(runner: AgentRun["runner"]) {
  return runner === "codex" ? "本地 Codex runner" : "模拟 runner";
}

export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [connection, setConnection] = useState<"connecting" | "live" | "polling" | "closed">("connecting");
  const [error, setError] = useState<string | null>(null);

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

  return (
    <AppShell>
      <div className="two-col">
        <section className="grid">
          <div className="card">
            <div className="card-header">
              <div>
                <span className={`status-pill ${runStatusTone(run.status)}`}>
                  <Clock size={14} />
                  {runStatusLabel(run.status)}
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
                  {run.failureSummary ?? "runner 没有返回更详细的失败摘要。"} 请返回工作台重新提交，或让主线程查看后端日志。
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
                    <strong>{run.result.tests.every((test) => test.status === "passed") ? "通过" : "需处理"}</strong>
                  </div>
                  <div className="metric">
                    <span className="muted">成本</span>
                    <strong>${run.costActualUsd?.toFixed(2) ?? run.costEstimateUsd.toFixed(2)}</strong>
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {run.result.summary}
                  </p>
                  <StatusNotice title="下一步：验收结果" tone="success">
                    请查看摘要、测试和风险等级。如果不满意，可以在验收页要求修改。
                  </StatusNotice>
                  <button
                    className="button"
                    disabled={run.status !== "succeeded"}
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
              <h3>执行模式</h3>
            </div>
            <div className="card-body grid">
              <StatusNotice
                title={`当前为${runnerLabel(run.runner)}`}
                tone={run.runner === "codex" ? "info" : "warning"}
              >
                {run.runner === "codex"
                  ? "Codex 会在隔离 worktree 中开发、测试并返回证据；验收通过后仍不会自动合并。"
                  : "本地 MVP 会模拟代码变更、测试和审查事件，用于验证端到端体验。"}
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
