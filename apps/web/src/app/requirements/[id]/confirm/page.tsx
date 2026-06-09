"use client";

import type { Prd, Requirement, WorkItem } from "@patchpilot/domain";
import { ArrowRight, CheckCircle2, ClipboardList, HelpCircle } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

export default function RequirementConfirmPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [requirement, setRequirement] = useState<Requirement | null>(null);
  const [prd, setPrd] = useState<Prd | null>(null);
  const [workItems, setWorkItems] = useState<WorkItem[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void api.getRequirement(id).then((bundle) => {
      setRequirement(bundle.requirement);
      setPrd(bundle.prd || null);
      setWorkItems(bundle.workItems);
      setAnswers(
        Object.fromEntries(
          bundle.requirement.clarificationQuestions.map((question) => [question.id, question.recommendedAnswer])
        )
      );
      setLoading(false);
    });
  }, [id]);

  async function generatePrd() {
    if (!requirement) return;
    setSubmitting(true);
    try {
      const result = await api.answerClarification(requirement.id, answers);
      setRequirement(result.requirement);
      setPrd(result.prd);
    } finally {
      setSubmitting(false);
    }
  }

  async function start() {
    if (!prd) return;
    setSubmitting(true);
    try {
      const approved = await api.approvePrd(prd.id);
      const workItem = approved.workItems[0];
      if (!workItem) throw new Error("没有生成可执行任务");
      setWorkItems(approved.workItems);
      const run = await api.startRun(workItem.id);
      router.push(`/runs/${run.id}`);
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
          <div className="card-body">没有找到这个需求。</div>
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
                <span className="status-pill blue">
                  <ClipboardList size={14} />
                  简版需求确认
                </span>
                <h1 style={{ margin: "12px 0 0", fontSize: 34 }}>{requirement.simpleSummary}</h1>
              </div>
            </div>
            <div className="card-body grid">
              {!prd ? (
                <>
                  <p className="muted" style={{ margin: 0 }}>
                    先回答最多 3 个问题。推荐答案已经填好，也可以直接让平台决定。
                  </p>
                  {requirement.clarificationQuestions.map((question) => (
                    <div className="question-card" key={question.id}>
                      <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <HelpCircle size={17} />
                        {question.question}
                      </strong>
                      <input
                        className="input"
                        onChange={(event) =>
                          setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                        }
                        value={answers[question.id] || ""}
                      />
                      <button
                        className="button secondary"
                        onClick={() =>
                          setAnswers((current) => ({
                            ...current,
                            [question.id]: question.recommendedAnswer
                          }))
                        }
                        type="button"
                      >
                        使用推荐答案
                      </button>
                    </div>
                  ))}
                  <button className="button" disabled={submitting} onClick={generatePrd} type="button">
                    {submitting ? "生成中" : "生成需求说明"}
                    <ArrowRight size={17} />
                  </button>
                </>
              ) : (
                <>
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
