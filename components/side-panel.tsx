"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Shared chrome for every aside panel so task history, sandboxes, and schedule
 * read as one system — same header rhythm, count badge, and empty-state slot.
 */
export function SidePanel({
  title,
  icon: Icon,
  count,
  children,
  empty,
  actions,
}: {
  title: string;
  icon: LucideIcon;
  count?: number;
  children?: ReactNode;
  empty?: ReactNode;
  actions?: ReactNode;
}) {
  const isEmpty = children == null;
  return (
    <section className="side-panel">
      <header className="side-panel-head">
        <span className="side-panel-icon" aria-hidden="true">
          <Icon size={14} strokeWidth={1.75} />
        </span>
        <h2 className="side-panel-title">{title}</h2>
        {typeof count === "number" && <span className="side-panel-count">{count}</span>}
        {actions && <div className="side-panel-actions">{actions}</div>}
      </header>
      <div className={`side-panel-body${isEmpty ? " side-panel-body-empty" : ""}`}>
        {isEmpty ? empty ?? <p className="side-panel-empty">Nothing here yet</p> : children}
      </div>
    </section>
  );
}
