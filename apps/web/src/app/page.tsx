"use client";

import type { RequirementTemplate } from "@patchpilot/domain";
import { ArrowRight, Paperclip, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { TemplateSelector } from "@/components/TemplateSelector";
import { api } from "@/lib/api";

export default function HomePage() {
  const router = useRouter();
  const [template, setTemplate] = useState<RequirementTemplate>("feature");
  const [rawInput, setRawInput] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!rawInput.trim()) return;
    setSubmitting(true);
    try {
      const requirement = await api.createRequirement(rawInput, template);
      router.push(`/requirements/${requirement.id}/confirm`);
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
