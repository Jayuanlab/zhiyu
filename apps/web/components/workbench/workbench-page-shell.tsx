import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

export function WorkbenchPageShell({
  icon,
  title,
  description,
  badges,
  actions,
  children,
  className,
  contentClassName,
}: {
  icon?: string;
  title: string;
  description?: string;
  badges?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <main className={cn("h-full min-h-0 overflow-y-auto bg-[#F8FAF9] text-foreground", className)}>
      <div className={cn("mx-auto flex w-full max-w-7xl flex-col gap-5 px-4 py-5 pb-10 sm:px-6 lg:px-8", contentClassName)}>
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {icon ? <span className={cn(icon, "text-xl")} aria-hidden /> : null}
              <h1 className="truncate text-2xl font-semibold sm:text-3xl">{title}</h1>
              {badges}
            </div>
            {description ? (
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                {description}
              </p>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </header>
        {children}
      </div>
    </main>
  );
}
