"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo } from "react";

const STORAGE_KEY = "openzhiyu:workbench-scroll-v1";
const MAX_ENTRIES = 24;

type ScrollSnapshot = Record<string, number>;

function readSnapshot(): ScrollSnapshot {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as ScrollSnapshot) : {};
  } catch {
    return {};
  }
}

function writeSnapshot(routeKey: string, value: number) {
  const snapshot = readSnapshot();
  const next: ScrollSnapshot = { ...snapshot, [routeKey]: value };
  const entries = Object.entries(next).slice(-MAX_ENTRIES);
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function findScrollableMain() {
  return document.querySelector<HTMLElement>("main.h-full.overflow-y-auto");
}

export function PageScrollRestoration() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = useMemo(
    () => `${pathname}?${searchParams?.toString() ?? ""}`,
    [pathname, searchParams],
  );

  useEffect(() => {
    const main = findScrollableMain();
    if (!main) return;

    const snapshot = readSnapshot();
    const savedTop = snapshot[routeKey];
    if (typeof savedTop === "number" && savedTop > 0) {
      requestAnimationFrame(() => {
        main.scrollTop = savedTop;
      });
    }

    return () => {
      writeSnapshot(routeKey, main.scrollTop);
    };
  }, [routeKey]);

  return null;
}
