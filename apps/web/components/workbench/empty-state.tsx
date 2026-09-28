import type { ReactNode } from "react";
import { RemixIcon } from "@/components/remix-icon";
import { cn } from "@/lib/utils";

export function EmptyState({
  label,
  title,
  description,
  icon = "inbox",
  action,
  detail,
  className,
}: {
  label: string;
  title: string;
  description: string;
  icon?: string;
  action?: ReactNode;
  detail?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex min-h-52 flex-col justify-center rounded-2xl border border-slate-200 bg-slate-50/70 px-6 py-7 sm:px-8", className)}>
      <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-slate-500">
        <span className="flex size-8 items-center justify-center rounded-lg border border-slate-200 bg-white text-blue-700" aria-hidden="true">
          <RemixIcon name={icon} size="size-4" />
        </span>
        {label}
      </div>
      <h2 className="mt-4 text-xl font-semibold tracking-tight text-slate-950 text-balance">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600 text-pretty">{description}</p>
      {action ? <div className="mt-5 flex flex-wrap items-center gap-3">{action}</div> : null}
      {detail ? <div className="mt-4 text-xs leading-5 text-slate-500">{detail}</div> : null}
    </section>
  );
}
