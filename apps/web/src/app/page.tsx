"use client";

import type {
  AgentProfile,
  AgentRun,
  IntakeArtifactReference,
  PatchPilotSnapshot,
  Requirement,
  RequirementTemplate,
  WorkItem
} from "@patchpilot/domain";
import {
  AlertTriangle,
  ArrowRight,
  Bug,
  ClipboardList,
  FileText,
  Image,
  Paperclip,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Video
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ArtifactReferenceList } from "@/components/ArtifactReferenceList";
import { StatusNotice } from "@/components/StatusNotice";
import { TemplateSelector } from "@/components/TemplateSelector";
import { api } from "@/lib/api";

const bugPrompt = "请修复一个问题：\n\n复现步骤：\n\n实际结果：\n\n期望结果：\n\n验收证明：";

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

const runStatusLabels: Record<AgentRun["status"], string> = {
  queued: "排队中",
  running: "执行中",
  needs_approval: "等待批准",
  succeeded: "待验收",
  failed: "失败",
  cancelled: "取消"
};

type AgentViewStatus = AgentProfile["status"] | "syncing";

const agentRoles: AgentProfile["role"][] = ["product", "frontend", "backend", "test", "ops", "reviewer"];

const agentRoleLabels: Record<AgentProfile["role"], string> = {
  product: "product agent",
  frontend: "frontend agent",
  backend: "backend agent",
  test: "test agent",
  ops: "ops agent",
  reviewer: "reviewer agent"
};

const agentStatusLabels: Record<AgentViewStatus, string> = {
  idle: "待命",
  busy: "执行中",
  offline: "离线",
  syncing: "同步中"
};

function statusTone(status: Requirement["status"] | WorkItem["status"] | AgentRun["status"]) {
  if (["approved", "done", "succeeded"].includes(status)) return "green";
  if (["rejected", "blocked", "failed", "cancelled"].includes(status)) return "red";
  if (["prd_draft", "review", "needs_approval"].includes(status)) return "amber";
  return "blue";
}

function workItemViewLabel(item: WorkItem) {
  if (!(item.reworkCount ?? 0)) return workItemStatusLabels[item.status];
  if (item.status === "ready") return "待返工";
  if (item.status === "claimed" || item.status === "running") return "返工中";
  if (item.status === "review") return "返工待验收";
  return workItemStatusLabels[item.status];
}

function workItemViewTone(item: WorkItem) {
  if ((item.reworkCount ?? 0) > 0 && !["done", "cancelled"].includes(item.status)) {
    return item.status === "review" ? "green" : "amber";
  }
  return statusTone(item.status);
}

function agentStatusTone(status: AgentViewStatus) {
  if (status === "busy") return "blue";
  if (status === "offline") return "red";
  if (status === "syncing") return "amber";
  return "green";
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function countByStatus<T extends string>(items: Array<{ status: T }>, statuses: T[]) {
  return statuses.map((status) => ({
    status,
    count: items.filter((item) => item.status === status).length
  }));
}

function toBugPayload(rawInput: string, artifactReferences: IntakeArtifactReference[]) {
  const lines = rawInput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const title = lines.find((line) => !line.endsWith("：")) || "用户提交的 bug";
  return {
    title: title.slice(0, 80),
    description: rawInput,
    reproductionSteps: rawInput,
    expectedBehavior: "按用户描述的期望结果正常工作。",
    actualBehavior: "当前行为与用户描述不一致。",
    severity: "medium" as const,
    reporter: "human",
    artifactReferences
  };
}

function makeClientId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `client_${crypto.randomUUID()}`;
  return `client_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function artifactKindForFile(file: File): IntakeArtifactReference["kind"] {
  if (file.type.startsWith("image/")) return "screenshot";
  if (file.type.startsWith("video/")) return "recording";
  return "file";
}

function isValidUrl(value: string) {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

export default function HomePage() {
  const router = useRouter();
  const [template, setTemplate] = useState<RequirementTemplate>("feature");
  const [rawInput, setRawInput] = useState("");
  const [artifactReferences, setArtifactReferences] = useState<IntakeArtifactReference[]>([]);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkLabel, setLinkLabel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<PatchPilotSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .getSnapshot()
      .then((nextSnapshot) => {
        setSnapshot(nextSnapshot);
        setSnapshotError(null);
      })
      .catch((nextError) => {
        setSnapshotError(nextError instanceof Error ? nextError.message : "工作台快照加载失败。");
      });
  }, []);

  function addFiles(files: FileList | null) {
    if (!files?.length) return;
    const selectedFiles = Array.from(files);
    const now = new Date().toISOString();
    setArtifactReferences((current) => [
      ...current,
      ...selectedFiles.map((file) => ({
        id: makeClientId(),
        kind: artifactKindForFile(file),
        label: file.name,
        contentType: file.type || "application/octet-stream",
        sizeBytes: file.size,
        metadata: {
          source: "file_picker",
          lastModified: new Date(file.lastModified).toISOString()
        },
        createdAt: now
      }))
    ].slice(0, 12));
  }

  function addLinkReference() {
    const normalizedUrl = linkUrl.trim();
    if (!isValidUrl(normalizedUrl)) return;
    setArtifactReferences((current) => [
      ...current,
      {
        id: makeClientId(),
        kind: "link" as const,
        label: linkLabel.trim() || normalizedUrl,
        uri: normalizedUrl,
        metadata: { source: "composer_link" },
        createdAt: new Date().toISOString()
      }
    ].slice(0, 12));
    setLinkUrl("");
    setLinkLabel("");
  }

  function removeArtifactReference(id: string) {
    setArtifactReferences((current) => current.filter((reference) => reference.id !== id));
  }

  const canAddLink = isValidUrl(linkUrl) && artifactReferences.length < 12;

  async function submit() {
    if (!rawInput.trim() && artifactReferences.length === 0) return;
    const normalizedInput = rawInput.trim() || "请根据附件和链接整理需求。";
    setSubmitting(true);
    setError(null);
    try {
      if (template === "bug") {
        const result = await api.createBug(toBugPayload(normalizedInput, artifactReferences));
        router.push(`/requirements/${result.requirement.id}/confirm`);
        return;
      }
      const requirement = await api.createRequirement(normalizedInput, template, artifactReferences);
      router.push(`/requirements/${requirement.id}/confirm`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "提交失败，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  }

  const requirements = snapshot?.requirements ?? [];
  const workItems = snapshot?.workItems ?? [];
  const agentRuns = snapshot?.agentRuns ?? [];
  const testCases = snapshot?.testCases ?? [];
  const reviewRecords = snapshot?.reviewRecords ?? [];
  const acceptances = snapshot?.acceptances ?? [];
  const bugs = snapshot?.bugs ?? [];
  const agents = snapshot?.agents ?? [];
  const recentRequirements = requirements
    .slice()
    .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 4);
  const recentRuns = agentRuns
    .slice()
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, 4);
  const activeWorkItems = workItems.filter((item) => !["done", "cancelled"].includes(item.status));
  const visibleActiveWorkItems = activeWorkItems.slice(0, 4);
  const failedRuns = agentRuns.filter((run) => run.status === "failed");
  const rejectedAcceptances = acceptances.filter((acceptance) => acceptance.status === "rejected");
  const blockedWorkItems = workItems.filter((item) => item.status === "blocked");
  const reworkWorkItems = workItems.filter((item) => (item.reworkCount ?? 0) > 0 && !["done", "cancelled"].includes(item.status));
  const openBugs = bugs.filter((bug) => !["closed", "unreproducible"].includes(bug.status));
  const busyAgents = agents.filter((agent) => agent.status === "busy");
  const needsAttention = failedRuns.length + rejectedAcceptances.length + blockedWorkItems.length + openBugs.length;
  const openRequirement = requirements.find((requirement) => !["approved", "rejected"].includes(requirement.status));
  const reviewWorkItem = workItems.find((item) => item.status === "review");
  const agentTeam = agentRoles.map((role) => {
    const agent = agents.find((item) => item.role === role);
    const currentWorkItem = agent?.currentWorkItemId
      ? workItems.find((item) => item.id === agent.currentWorkItemId)
      : undefined;
    const roleWorkItem = workItems.find((item) => item.role === role && !["done", "cancelled"].includes(item.status));
    const workItem = currentWorkItem ?? (role === "reviewer" ? reviewWorkItem : roleWorkItem);
    const run = workItem
      ? agentRuns
          .filter((item) => item.workItemId === workItem.id)
          .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())[0]
      : undefined;
    const status: AgentViewStatus = snapshot
      ? agent?.status ?? (workItem && ["claimed", "running"].includes(workItem.status) ? "busy" : "idle")
      : "syncing";
    const taskTitle = snapshot
      ? workItem?.title ?? (role === "product" && openRequirement ? openRequirement.simpleSummary : "暂无任务")
      : "等待工作台快照";
    const taskMeta = workItem
      ? `${workItemStatusLabels[workItem.status]}${run ? ` · ${runStatusLabels[run.status]}` : ""}`
      : role === "product" && openRequirement
        ? requirementStatusLabels[openRequirement.status]
        : snapshot
          ? "待命"
          : "读取中";

    return {
      role,
      status,
      taskMeta,
      taskTitle
    };
  });

  return (
    <AppShell>
      <section className="hero">
        <span className="eyebrow">
          <Sparkles size={15} />
          像提交一个想法一样启动 agent team
        </span>
        <h1>你说目标，PatchPilot 负责推进到可验收结果。</h1>
        <p>
          白底极简工作台，默认隐藏工程复杂度。先确认需求，再自动拆任务、执行、测试、审查，最后给你证据摘要。
        </p>
      </section>

      <section className="composer-card">
        <textarea
          className="composer-textarea"
          onChange={(event) => setRawInput(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              void submit();
            }
          }}
          placeholder="你想让 PatchPilot 做什么？例如：做一个白色底的 agent 平台首页，可以提交需求、看到进度并确认结果。"
          value={rawInput}
        />
        <div className="composer-artifacts" aria-label="附件和链接">
          <div className="attachment-toolbar">
            <label className="button secondary attachment-button">
              <FileText size={17} />
              文件
              <input
                aria-label="添加文件、截图或录屏"
                className="file-input"
                multiple
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
            <label className="button secondary attachment-button" aria-disabled={artifactReferences.length >= 12}>
              <Image size={17} />
              截图
              <input
                accept="image/*"
                aria-label="添加截图文件"
                className="file-input"
                disabled={artifactReferences.length >= 12}
                multiple
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
            <label className="button secondary attachment-button" aria-disabled={artifactReferences.length >= 12}>
              <Video size={17} />
              录屏
              <input
                accept="video/*"
                aria-label="添加录屏文件"
                className="file-input"
                disabled={artifactReferences.length >= 12}
                multiple
                onChange={(event) => {
                  addFiles(event.target.files);
                  event.target.value = "";
                }}
                type="file"
              />
            </label>
          </div>
          <div className="link-input-row">
            <input
              aria-label="链接标题"
              className="input"
              onChange={(event) => setLinkLabel(event.target.value)}
              placeholder="链接标题"
              value={linkLabel}
            />
            <input
              aria-label="链接 URL"
              className="input"
              onChange={(event) => setLinkUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLinkReference();
                }
              }}
              placeholder="https://example.com/context"
              type="url"
              value={linkUrl}
            />
            <button
              className="button secondary"
              disabled={!canAddLink}
              onClick={addLinkReference}
              type="button"
            >
              <Plus size={17} />
              添加链接
            </button>
          </div>
          {artifactReferences.length > 0 ? (
            <ArtifactReferenceList references={artifactReferences} onRemove={removeArtifactReference} />
          ) : null}
        </div>
        {error ? (
          <div className="composer-notice">
            <StatusNotice title="需求没有提交成功" tone="error">
              {error}。请确认 API 服务已启动，然后重试。
            </StatusNotice>
          </div>
        ) : null}
        <div className="composer-footer">
          <span className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <Paperclip size={16} />
            {artifactReferences.length > 0 ? `${artifactReferences.length} 个附件或链接会进入需求说明` : "可附加文件、截图、录屏和链接"}
          </span>
          <button
            className="button"
            disabled={(!rawInput.trim() && artifactReferences.length === 0) || submitting}
            onClick={submit}
            type="button"
          >
            {submitting ? "提交中" : "生成需求说明"}
            <ArrowRight size={17} />
          </button>
        </div>
      </section>

      <TemplateSelector
        active={template}
        onSelect={(nextTemplate, prompt) => {
          setTemplate(nextTemplate);
          if (!rawInput.trim()) setRawInput(prompt);
        }}
      />

      <section className="workspace-summary" aria-label="工作台状态摘要">
        <div className="section-heading">
          <div>
            <span className="eyebrow compact">
              <ClipboardList size={14} />
              工作台
            </span>
            <h2>最近交付状态</h2>
          </div>
          <span className="muted">{snapshot ? `已读取 ${requirements.length} 个需求` : "正在读取工作台快照"}</span>
        </div>

        {snapshotError ? (
          <StatusNotice title="工作台快照暂不可用" tone="warning">
            {snapshotError}。提交新需求仍可继续，状态摘要会在 API 恢复后显示。
          </StatusNotice>
        ) : null}

        <div className="summary-strip">
          <div className="summary-stat">
            <span className="muted">最近需求</span>
            <strong>{requirements.length}</strong>
          </div>
          <div className="summary-stat">
            <span className="muted">活跃任务</span>
            <strong>{activeWorkItems.length}</strong>
          </div>
          <div className="summary-stat">
            <span className="muted">Agent team</span>
            <strong>
              {busyAgents.length}/{agents.length}
            </strong>
          </div>
          <div className={`summary-stat ${needsAttention > 0 ? "attention" : ""}`}>
            <span className="muted">Bug / rework</span>
            <strong>{needsAttention}</strong>
          </div>
        </div>

        <section className="agent-team-panel" aria-label="Agent team 自动工作状态">
          <div className="panel-title">
            <h3>Agent team</h3>
            <span className={`status-pill ${busyAgents.length > 0 ? "blue" : "green"}`}>
              {busyAgents.length > 0 ? `${busyAgents.length} 个执行中` : "全部待命"}
            </span>
          </div>
          <div className="agent-team-list">
            {agentTeam.map((agent) => (
              <div className="agent-row" key={agent.role}>
                <span>
                  <span className="agent-role">{agentRoleLabels[agent.role]}</span>
                  <strong>{agent.taskTitle}</strong>
                  <small>{agent.taskMeta}</small>
                </span>
                <span className={`status-pill ${agentStatusTone(agent.status)}`}>{agentStatusLabels[agent.status]}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="dashboard-grid">
          <section className="dashboard-panel">
            <div className="panel-title">
              <h3>最近需求</h3>
              <span className="status-pill">{recentRequirements.length ? "可继续" : "暂无"}</span>
            </div>
            <div className="dashboard-list">
              {recentRequirements.length ? (
                recentRequirements.map((requirement) => (
                  <Link className="dashboard-row" href={`/requirements/${requirement.id}/confirm`} key={requirement.id}>
                    <span>
                      <strong>{requirement.simpleSummary}</strong>
                      <small>{formatShortDate(requirement.updatedAt)}</small>
                    </span>
                    <span className={`status-pill ${statusTone(requirement.status)}`}>
                      {requirementStatusLabels[requirement.status]}
                    </span>
                  </Link>
                ))
              ) : (
                <p className="empty-copy">提交第一个需求后，这里会显示确认、PRD 和执行入口。</p>
              )}
            </div>
          </section>

          <section className="dashboard-panel">
            <div className="panel-title">
              <h3>Work items</h3>
              <span className="status-pill">{workItems.length} 项</span>
            </div>
            <div className="status-bars">
              {countByStatus(workItems, ["ready", "running", "review", "blocked", "done"]).map(({ status, count }) => (
                <div className="status-bar" key={status}>
                  <span>{workItemStatusLabels[status]}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
            <div className="dashboard-list compact-list-panel">
              {visibleActiveWorkItems.length ? (
                visibleActiveWorkItems.map((item) => (
                  <div className="dashboard-row" key={item.id}>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.scope}</small>
                      {(item.reworkCount ?? 0) > 0 ? (
                        <small className="rework-reason">
                          返工第 {item.reworkCount} 轮
                          {item.lastRejectionReason ? ` · ${item.lastRejectionReason}` : ""}
                        </small>
                      ) : null}
                    </span>
                    <span className={`status-pill ${workItemViewTone(item)}`}>{workItemViewLabel(item)}</span>
                  </div>
                ))
              ) : (
                <p className="empty-copy">没有正在推进的任务。批准需求说明后会生成 work items。</p>
              )}
            </div>
          </section>

          <section className="dashboard-panel">
            <div className="panel-title">
              <h3>Agent runs</h3>
              <span className="status-pill">{recentRuns.length ? "最近 4 次" : "暂无"}</span>
            </div>
            <div className="status-bars">
              {countByStatus(agentRuns, ["queued", "running", "succeeded", "failed"]).map(({ status, count }) => (
                <div className="status-bar" key={status}>
                  <span>{runStatusLabels[status]}</span>
                  <strong>{count}</strong>
                </div>
              ))}
            </div>
            <div className="dashboard-list compact-list-panel">
              {recentRuns.length ? (
                recentRuns.map((run) => (
                  <Link className="dashboard-row" href={`/runs/${run.id}`} key={run.id}>
                    <span>
                      <strong>本地 Codex</strong>
                      <small>{formatShortDate(run.startedAt)}</small>
                    </span>
                    <span className={`status-pill ${statusTone(run.status)}`}>{runStatusLabels[run.status]}</span>
                  </Link>
                ))
              ) : (
                <p className="empty-copy">启动 work item 后，这里会显示 agent 执行进度和结果。</p>
              )}
            </div>
          </section>

          <section className="dashboard-panel action-panel">
            <div className="panel-title">
              <h3>Bug / rework</h3>
              <span className={`status-pill ${needsAttention > 0 ? "red" : "green"}`}>
                {needsAttention > 0 ? "需要处理" : "清爽"}
              </span>
            </div>
            <div className="rework-stack">
              <div className="rework-item">
                <AlertTriangle size={18} />
                <span>
                  <strong>{openBugs.length} 个待处理 bug</strong>
                  <small>人工提交后进入复现、诊断和修复流程</small>
                </span>
              </div>
              <div className="rework-item">
                <RefreshCw size={18} />
                <span>
                  <strong>{failedRuns.length + rejectedAcceptances.length + blockedWorkItems.length} 个返工线索</strong>
                  <small>{reworkWorkItems.length} 个任务已回到队列，失败、阻塞和验收拒绝都会保留证据</small>
                </span>
              </div>
              <button
                className="button secondary"
                onClick={() => {
                  setTemplate("bug");
                  if (!rawInput.trim()) setRawInput(bugPrompt);
                }}
                type="button"
              >
                <Bug size={17} />
                填写 bug / rework
              </button>
            </div>
          </section>
        </div>
      </section>

      <section className="evidence-grid" style={{ marginTop: 28 }}>
        <div className="metric execution-mode">
          <span className="muted">当前模式</span>
          <strong>本地 Codex</strong>
          <small>
            会在隔离 worktree 中调用本机 Codex 执行，并收集测试证据。
          </small>
        </div>
        <div className="metric">
          <span className="muted">默认澄清</span>
          <strong>逐轮澄清</strong>
        </div>
        <div className="metric">
          <span className="muted">执行边界</span>
          <strong>隔离工作区</strong>
        </div>
        <div className="metric">
          <span className="muted">测试用例</span>
          <strong>{testCases.length} 条</strong>
          <small>PRD 批准后会生成可追溯到工作项的 TestCase。</small>
        </div>
        <div className="metric">
          <span className="muted">审查证据</span>
          <strong>
            <ShieldCheck size={20} /> {reviewRecords.length} 条
          </strong>
          <small>每次成功交付都会写入 ReviewRecord。</small>
        </div>
      </section>
    </AppShell>
  );
}
