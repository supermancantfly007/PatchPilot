import { Bot, CircleDot, ClipboardList } from "lucide-react";
import Link from "next/link";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <Link className="brand" href="/">
            <span className="brand-mark">
              <Bot size={18} />
            </span>
            <span>PatchPilot</span>
          </Link>
          <div className="topbar-actions">
            <Link className="topbar-link" href="/control">
              <ClipboardList size={15} />
              专业控制台
            </Link>
            <div className="project-pill">
              <CircleDot size={14} />
              本地 MVP 工作区
            </div>
          </div>
        </div>
      </header>
      <main className="page">{children}</main>
    </div>
  );
}
