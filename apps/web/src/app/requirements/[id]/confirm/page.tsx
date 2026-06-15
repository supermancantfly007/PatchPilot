"use client";

import type { InterfaceContract, Prd, Requirement, WorkItem } from "@patchpilot/domain";
import { ArrowRight, Bot, CheckCircle2, ClipboardList, RefreshCw, Send, UserRound } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ArtifactReferenceList } from "@/components/ArtifactReferenceList";
import { StatusNotice } from "@/components/StatusNotice";
import { api } from "@/lib/api";

export default function RequirementConfirmPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [prd, setPrd] = useState<Prd | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [interfaceContracts, setInterfaceContracts] = useState<InterfaceContract[]>([]);
  const [draftAnswer, setDraftAnswer] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    void api
      .getRequirement(id)
      .then((bundle) => {
        setRequirement(bundle.requirement);
        setPrd(bundle.prd || null);
        setWorkItems(bundle.workItems);
        setInterfaceContracts(bundle.interfaceContracts);
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
      setInterfaceContracts(result.interfaceContracts);
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
      const started = await api.startTeam(prd.id);
      const run = started.runs[0];
      if (!run) throw new Error("没有生成可执行任务");
      setPrd(started.prd);
      setWorkItems(started.workItems);
      setInterfaceContracts(started.interfaceContracts);
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
  const artifactReferences = requirement.artifactReferences ?? [];
  const reworkItems = workItems.filter((item) => (item.reworkCount ?? 0) > 0 && !["done", "cancelled"].includes(item.status));

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
                  {reworkItems.length > 0 ? (
                    <StatusNotice title="这些任务已回到返工队列" tone="warning">
                      上次验收要求修改后，PatchPilot 已清空 agent 领取状态，并把 {reworkItems.length} 个任务重新设为可执行。
                    </StatusNotice>
                  ) : null}
                  <StatusNotice
                    title="下一步会启动本地 Codex agent team"
                    tone="info"
                  >
                    平台会为团队任务创建隔离 worktree，让 Codex 开发、测试并返回证据；不会自动合并或发布。
                  </StatusNotice>
                  <div className="question-card" style={{ background: "white" }}>
                    <strong>要做什么</strong>
                    <p style={{ margin: 0 }}>{requirement.rawInput}</p>
                  </div>
                  {artifactReferences.length > 0 ? (
                    <div className="question-card" style={{ background: "white" }}>
                      <strong>关联资料</strong>
                      <ArtifactReferenceList references={artifactReferences} />
                    </div>
                  ) : null}
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
                    {submitting ? "启动中" : "开始执行 agent team"}
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
              <h3>接口契约</h3>
              <span className="status-pill">{interfaceContracts.length ? `${interfaceContracts.length} 份` : "待生成"}</span>
            </div>
            <div className="card-body event-list">
              {interfaceContracts.length > 0 ? (
                interfaceContracts.map((contract) => (
                  <div className="event" key={contract.id}>
                    <strong>{contract.name}</strong>
                    <p className="muted" style={{ margin: "6px 0" }}>
                      {contract.kind.toUpperCase()} · {contract.providerRole} {"->"} {contract.consumerRoles.join(", ")}
                    </p>
                    <p style={{ margin: 0 }}>{contract.summary}</p>
                  </div>
                ))
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  PRD 批准后会生成 HTTP、事件流和共享状态契约，前端、后端、测试 agent 会以此对齐。
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
                    <strong>
                      {item.title}
                      {(item.reworkCount ?? 0) > 0 ? (
                        <span className="inline-status">
                          <RefreshCw size={13} />
                          返工第 {item.reworkCount} 轮
                        </span>
                      ) : null}
                    </strong>
                    <p className="muted" style={{ marginBottom: 0 }}>
                      {item.scope}
                    </p>
                    {item.lastRejectionReason ? (
                      <p className="rework-reason" style={{ margin: "8px 0 0" }}>
                        {item.lastRejectionReason}
                      </p>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  需求确认后将生成面向前端、后端、测试或运维的垂直任务。
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
