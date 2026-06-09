"use client";

import type { Prd, Requirement, RuntimeConfig, WorkItem } from "@patchpilot/domain";
import { ArrowRight, Bot, CheckCircle2, ClipboardList, Send, UserRound } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";

export default function RequirementConfirmPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [prd, setPrd] = useState<Prd | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void api.getConfig().then(setConfig).catch(() => setConfig(null));
    void api
      .getRequirement(id)
      .then((bundle) => {
        setRequirement(bundle.requirement);
        setPrd(bundle.prd || null);
        setWorkItems(bundle.workItems);
      })
      .catch((nextError) => {
        setError(nextError instanceof Error ? nextError.message : "需求加载失败。");
      })
      .finally(() => setLoading(false));
  }, [id]);

  async function sendClarificationTurn(message = draftAnswer) {
    if (!requirement) return;
    const answer = message.trim();
    if (!answer) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.addClarificationTurn(requirement.id, answer);
      setRequirement(result.requirement);
      setDraftAnswer("");
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "澄清回答提交失败。");
    } finally {
      setSubmitting(false);
    }
  }

  async function generatePrd() {
    if (!requirement) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.createPrdFromClarification(requirement.id);
      setRequirement(result.requirement);
      setPrd(result.prd);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "需求说明生成失败。");
    } finally {
      setSubmitting(false);
    }
  }

  async function start() {
    if (!prd) return;
    setSubmitting(true);
    setError(null);
    try {
      const approved = await api.approvePrd(prd.id);
      const workItem = approved.workItems[0];
      if (!workItem) throw new Error("没有生成可执行任务");
      setWorkItems(approved.workItems);
      const run = await api.startRun(workItem.id);
      router.push(`/runs/${run.id}`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "启动执行失败。");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <AppShell>
        <div className="card">
          <div className="card-body">正在整理需求...</div>
        </div>
      </AppShell>
    );
  }

  if (!requirement) {
    return (
      <AppShell>
        <div className="card">
          <div className="card-body grid">
            <StatusNotice title="没有找到这个需求" tone="error">
              {error ?? "这个需求可能已被删除，或当前 API 数据已重置。"}
            </StatusNotice>
            <button className="button secondary" onClick={() => router.push("/")} type="button">
              返回工作台
            </button>
          </div>
        </div>
      </AppShell>
    );
  }

  const latestAgentTurn = requirement.clarificationTurns
    .slice()
    .reverse()
    .find((turn) => turn.speaker === "agent");

  return (
    <AppShell>
      <div className="two-col">
        <section className="grid">
          <div className="card">
            <div className="card-header">
              <div>
                <span className="status-pill blue">
                  <ClipboardList size={14} />
                  简版需求确认
                </span>
                <h1 style={{ margin: "12px 0 0", fontSize: 34 }}>{requirement.simpleSummary}</h1>
              </div>
            </div>
            <div className="card-body grid">
              {error ? (
                <StatusNotice title={prd ? "执行没有启动成功" : "需求说明没有生成成功"} tone="error">
                  {error}。请保留当前页面，确认 API 服务状态后重试。
                </StatusNotice>
              ) : null}
              {!prd ? (
                <>
                  <p className="muted" style={{ margin: 0 }}>
                    像 Codex CLI 一样逐个问题澄清。每次只问一个问题，推荐答案可以直接使用。
                  </p>
                  <div className="clarification-chat">
                    {requirement.clarificationTurns.map((turn) => (
                      <div className={`chat-turn ${turn.speaker}`} key={turn.id}>
                        <span className="chat-avatar">
                          {turn.speaker === "agent" ? <Bot size={16} /> : <UserRound size={16} />}
                        </span>
                        <div className="chat-bubble">
                          <strong>{turn.speaker === "agent" ? "PatchPilot" : "你"}</strong>
                          <p>{turn.message}</p>
                          {turn.recommendedAnswer ? (
                            <div className="recommended-answer">
                              <span>推荐答案</span>
                              <p>{turn.recommendedAnswer}</p>
                            </div>
                          ) : null}
                        </div>
                      </div>
                    ))}
                  </div>
                  <textarea
                    className="input"
                    onChange={(event) => setDraftAnswer(event.target.value)}
                    placeholder="回答当前问题，或使用推荐答案。"
                    style={{ minHeight: 96 }}
                    value={draftAnswer}
                  />
                  <div className="action-row">
                    <button
                      className="button secondary"
                      disabled={!latestAgentTurn?.recommendedAnswer || submitting}
                      onClick={() => setDraftAnswer(latestAgentTurn?.recommendedAnswer || "")}
                      type="button"
                    >
                      使用推荐答案
                    </button>
                    <button
                      className="button secondary"
                      disabled={!draftAnswer.trim() || submitting}
                      onClick={() => void sendClarificationTurn()}
                      type="button"
                    >
                      {submitting ? "发送中" : "发送并继续澄清"}
                      <Send size={17} />
                    </button>
                    <button className="button" disabled={submitting} onClick={generatePrd} type="button">
                      {submitting ? "生成中" : "生成需求说明"}
                      <ArrowRight size={17} />
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <StatusNotice
                    title={
                      config?.activeRunner === "codex"
                        ? "下一步会启动本地 Codex agent"
                        : "下一步会启动本地模拟执行"
                    }
                    tone={config?.activeRunner === "codex" ? "info" : "warning"}
                  >
                    {config?.activeRunner === "codex"
                      ? "平台会创建隔离 worktree，让 Codex 在其中开发、测试并返回证据；不会自动合并或发布。"
                      : "它会展示计划、测试、审查和验收证据，但当前 runner 不会真实修改仓库文件。"}
                  </StatusNotice>
                  <div className="question-card" style={{ background: "white" }}>
                    <strong>要做什么</strong>
                    <p style={{ margin: 0 }}>{requirement.rawInput}</p>
                  </div>
                  <div className="question-card" style={{ background: "white" }}>
                    <strong>不做什么</strong>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      <li>不自动合并到主分支</li>
                      <li>不访问生产密钥或生产数据</li>
                      <li>不展开超出本次描述的复杂企业配置</li>
                    </ul>
                  </div>
                  <div className="question-card" style={{ background: "white" }}>
                    <strong>如何验收</strong>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      {prd.acceptanceCriteria.map((criterion) => (
                        <li key={criterion}>{criterion}</li>
                      ))}
                    </ul>
                  </div>
                  <button className="button" disabled={submitting} onClick={start} type="button">
                    {submitting ? "启动中" : "开始执行"}
                    <ArrowRight size={17} />
                  </button>
                </>
              )}
            </div>
          </div>
        </section>

        <aside className="grid">
          <div className="card">
            <div className="card-header">
              <h3>专业详情</h3>
              <span className="status-pill">可展开</span>
            </div>
            <div className="card-body">
              {prd ? (
                <div className="markdown-preview">{prd.bodyMarkdown}</div>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  需求说明生成后，这里会展示完整 PRD。普通用户只需要看左侧三块确认内容。
                </p>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3>预计任务</h3>
            </div>
            <div className="card-body">
              {workItems.length > 0 ? (
                workItems.map((item) => (
                  <div className="event" key={item.id}>
                    <strong>{item.title}</strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {item.scope}
                    </p>
                  </div>
                ))
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  需求确认后将生成 1-3 个垂直任务。
                </p>
              )}
            </div>
          </div>
          <div className="card">
            <div className="card-body" style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <CheckCircle2 color="var(--green)" />
              <span className="muted">接受结果不等于合并或发布；代码合并仍走仓库规则。</span>
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
