"use client";

import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export type PanelStateKind = "ready" | "loading" | "refreshing" | "stale" | "empty" | "error";

const stateTone: Record<PanelStateKind, string> = {
  ready: "border-border/60 bg-background",
  loading: "border-border/60 bg-background",
  refreshing: "border-sky-200 bg-sky-50/40",
  stale: "border-amber-200 bg-amber-50/40",
  empty: "border-dashed border-border bg-background",
  error: "border-destructive/30 bg-destructive/5",
};

const stateIcon: Record<PanelStateKind, string> = {
  ready: "ri-checkbox-circle-line",
  loading: "ri-loader-4-line animate-spin",
  refreshing: "ri-refresh-line animate-spin",
  stale: "ri-time-line",
  empty: "ri-inbox-line",
  error: "ri-error-warning-line",
};

export function PanelState({
  state,
  title,
  description,
  detail,
  action,
  children,
  className,
}: {
  state: PanelStateKind;
  title: string;
  description?: string;
  detail?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  if (state === "ready" && children) {
    return <>{children}</>;
  }

  return (
    <section className={cn("rounded-md border p-5", stateTone[state], className)}>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-sm">
          <span className={cn("text-xl", stateIcon[state])} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-foreground">{title}</h2>
              {description ? (
                <p className="mt-1 text-sm leading-6 text-muted-foreground">{description}</p>
              ) : null}
            </div>
            {action ? <div className="shrink-0">{action}</div> : null}
          </div>
          {detail ? <div className="mt-3 text-xs leading-5 text-muted-foreground">{detail}</div> : null}
        </div>
      </div>
    </section>
  );
}
