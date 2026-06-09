"use client";

import type { RequirementTemplate } from "@patchpilot/domain";
import { Bug, FileText, MousePointer2, Sparkles } from "lucide-react";

const templates: Array<{
  id: RequirementTemplate;
  label: string;
  hint: string;
  icon: React.ReactNode;
  prompt: string;
}> = [
  {
    id: "feature",
    label: "做新功能",
    hint: "从一句想法开始",
    icon: <Sparkles size={18} />,
    prompt: "我想做一个 "
  },
  {
    id: "bug",
    label: "修 bug",
    hint: "粘贴报错或步骤",
    icon: <Bug size={18} />,
    prompt: "这个问题需要修复："
  },
  {
    id: "ui",
    label: "改页面",
    hint: "白底、清爽、好用",
    icon: <MousePointer2 size={18} />,
    prompt: "我想把页面改得更好看："
  },
  {
    id: "document",
    label: "上传需求",
    hint: "把文档落成任务",
    icon: <FileText size={18} />,
    prompt: "根据这份需求文档实现："
  }
];

export function TemplateSelector({
  active,
  onSelect
}: {
  active: RequirementTemplate;
  onSelect: (template: RequirementTemplate, prompt: string) => void;
}) {
  return (
    <div className="template-grid">
      {templates.map((template) => (
        <button
          className={`template-button ${active === template.id ? "active" : ""}`}
          key={template.id}
          onClick={() => onSelect(template.id, template.prompt)}
          type="button"
        >
          {template.icon}
          <span>
            <strong>{template.label}</strong>
            <br />
            <span className="muted">{template.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
