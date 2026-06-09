import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

type StatusNoticeTone = "info" | "success" | "warning" | "error";

const icons: Record<StatusNoticeTone, ReactNode> = {
  info: <Info size={18} />,
  success: <CheckCircle2 size={18} />,
  warning: <AlertTriangle size={18} />,
  error: <AlertTriangle size={18} />
};

export function StatusNotice({
  title,
  children,
  tone = "info"
}: {
  title: string;
  children?: ReactNode;
  tone?: StatusNoticeTone;
}) {
  return (
    <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span className="notice-icon">{icons[tone]}</span>
      <span>
        <strong>{title}</strong>
        {children ? <span className="notice-copy">{children}</span> : null}
      </span>
    </div>
  );
}
