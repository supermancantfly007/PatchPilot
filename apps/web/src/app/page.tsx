"use client";

import type { RequirementTemplate, RuntimeConfig } from "@patchpilot/domain";
import { ArrowRight, Paperclip, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { StatusNotice } from "@/components/StatusNotice";
import { TemplateSelector } from "@/components/TemplateSelector";
import { api } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  const [template, setTemplate] = useState<RequirementTemplate>("feature");
  const [rawInput, setRawInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<RuntimeConfig | null>(null);

  useEffect(() => {
    void api.getConfig().then(setConfig).catch(() => {
      setConfig(null);
    });
  }, []);

  async function submit() {
    if (!rawInput.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const requirement = await api.createRequirement(rawInput, template);
      router.push(`/requirements/${requirement.id}/confirm`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "提交失败，请稍后再试。");
    } finally {
      setSubmitting(false);
    }
  }

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
            MVP 支持文字输入；截图、录屏和文件入口已预留
          </span>
          <button className="button" disabled={!rawInput.trim() || submitting} onClick={submit} type="button">
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

      <section className="evidence-grid" style={{ marginTop: 28 }}>
        <div className="metric execution-mode">
          <span className="muted">当前模式</span>
          <strong>{config?.activeRunner === "codex" ? "本地 Codex" : "模拟执行"}</strong>
          <small>
            {config?.activeRunner === "codex"
              ? "会在隔离 worktree 中调用本机 Codex 执行，并收集测试证据。"
              : "会走完整验收闭环，但不会真实修改仓库。"}
          </small>
        </div>
        <div className="metric">
          <span className="muted">默认澄清</span>
          <strong>最多 3 问</strong>
        </div>
        <div className="metric">
          <span className="muted">执行边界</span>
          <strong>隔离工作区</strong>
        </div>
        <div className="metric">
          <span className="muted">信任证据</span>
          <strong>
            <ShieldCheck size={20} /> 测试 + 审查
          </strong>
        </div>
      </section>
    </AppShell>
  );
}
