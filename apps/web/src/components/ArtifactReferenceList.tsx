"use client";

import type { IntakeArtifactReference } from "@patchpilot/domain";
import { artifactKindLabel } from "@patchpilot/domain";
import { FileText, Image, Link as LinkIcon, Video, X } from "lucide-react";
import { StatusNotice } from "@/components/StatusNotice";

interface ArtifactReferenceListProps {
  references: IntakeArtifactReference[];
  emptyTitle?: string;
  emptyCopy?: string;
  onRemove?: (id: string) => void;
}

function ArtifactIcon({ kind }: { kind: IntakeArtifactReference["kind"] }) {
  if (kind === "screenshot") return <Image size={16} />;
  if (kind === "recording") return <Video size={16} />;
  if (kind === "link") return <LinkIcon size={16} />;
  return <FileText size={16} />;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function referenceMeta(reference: IntakeArtifactReference) {
  return [
    reference.artifactId ? `artifact ${reference.artifactId}` : undefined,
    reference.contentType,
    typeof reference.sizeBytes === "number" ? formatBytes(reference.sizeBytes) : undefined
  ].filter(Boolean).join(" · ");
}

export function ArtifactReferenceList({
  references,
  emptyTitle = "暂无附件或链接",
  emptyCopy = "提交需求时添加的文件、截图、录屏和链接会显示在这里。",
  onRemove
}: ArtifactReferenceListProps) {
  if (references.length === 0) {
    return (
      <StatusNotice title={emptyTitle} tone="info">
        {emptyCopy}
      </StatusNotice>
    );
  }

  return (
    <div className="artifact-list">
      {references.map((reference) => (
        <div className="artifact-row" key={reference.id}>
          <span className="artifact-icon">
            <ArtifactIcon kind={reference.kind} />
          </span>
          <span className="artifact-copy">
            <strong>{reference.label}</strong>
            <small>
              {artifactKindLabel(reference.kind)}
              {referenceMeta(reference) ? ` · ${referenceMeta(reference)}` : ""}
            </small>
            {reference.uri ? (
              <a className="text-link" href={reference.uri} rel="noreferrer" target="_blank">
                {reference.kind === "link" ? "打开链接" : reference.uri}
              </a>
            ) : null}
          </span>
          {onRemove ? (
            <button
              aria-label={`移除 ${reference.label}`}
              className="icon-button"
              onClick={() => onRemove(reference.id)}
              type="button"
            >
              <X size={15} />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
