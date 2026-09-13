"use client";

import { cn } from "@/lib/utils";

/**
 * Mobile layout wrapper component
 * Keeps navigation in normal flow and gives the workbench the remaining viewport height.
 * Server and client render the same wrapper; pages retain their own scroll containers.
 */
export function MobileLayoutWrapper({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className={cn("flex h-svh flex-col", "md:pb-0")}>{children}</div>;
}
