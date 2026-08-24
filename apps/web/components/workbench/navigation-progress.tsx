"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

const DONE_DELAY_MS = 180;
const STALE_DELAY_MS = 8000;

function isModifiedClick(event: MouseEvent) {
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

function isSameAppNavigation(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute("href");
  if (!href || href.startsWith("#")) return false;
  if (anchor.target && anchor.target !== "_self") return false;

  const nextUrl = new URL(anchor.href, window.location.href);
  if (nextUrl.origin !== window.location.origin) return false;
  if (nextUrl.pathname === window.location.pathname && nextUrl.search === window.location.search) {
    return false;
  }

  return true;
}

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeKey = useMemo(
    () => `${pathname}?${searchParams?.toString() ?? ""}`,
    [pathname, searchParams],
  );
  const [active, setActive] = useState(false);
  const doneTimerRef = useRef<number | null>(null);
  const staleTimerRef = useRef<number | null>(null);
  const beginTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;

    const clearTimers = () => {
      if (beginTimerRef.current !== null) {
        window.clearTimeout(beginTimerRef.current);
        beginTimerRef.current = null;
      }
      if (doneTimerRef.current !== null) {
        window.clearTimeout(doneTimerRef.current);
        doneTimerRef.current = null;
      }
      if (staleTimerRef.current !== null) {
        window.clearTimeout(staleTimerRef.current);
        staleTimerRef.current = null;
      }
    };

    const begin = () => {
      if (!mountedRef.current) return;
      clearTimers();
      setActive(true);
      staleTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current) return;
        setActive(false);
        staleTimerRef.current = null;
      }, STALE_DELAY_MS);
    };

    const scheduleBegin = () => {
      if (beginTimerRef.current !== null) return;
      beginTimerRef.current = window.setTimeout(() => {
        beginTimerRef.current = null;
        begin();
      }, 0);
    };

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || isModifiedClick(event)) return;
      const target = event.target instanceof Element ? event.target : null;
      const anchor = target?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!isSameAppNavigation(anchor)) return;
      begin();
    };

    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    window.history.pushState = function patchedPushState(...args) {
      const result = originalPushState.apply(this, args);
      scheduleBegin();
      return result;
    };
    window.history.replaceState = function patchedReplaceState(...args) {
      const result = originalReplaceState.apply(this, args);
      scheduleBegin();
      return result;
    };

    window.addEventListener("openzhiyu:navigation-start", begin);
    document.addEventListener("click", handleClick, true);

    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      mountedRef.current = false;
      window.removeEventListener("openzhiyu:navigation-start", begin);
      document.removeEventListener("click", handleClick, true);
      clearTimers();
    };
  }, []);

  useEffect(() => {
    if (!active) return;
    if (doneTimerRef.current !== null) {
      window.clearTimeout(doneTimerRef.current);
    }
    doneTimerRef.current = window.setTimeout(() => {
      setActive(false);
      doneTimerRef.current = null;
    }, DONE_DELAY_MS);
  }, [routeKey, active]);

  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-x-0 top-0 z-[10000] h-[2px] overflow-hidden bg-transparent"
    >
      <div
        className={[
          "h-full bg-primary shadow-[0_0_14px_rgba(37,99,235,0.35)] transition-all duration-300 ease-out",
          active ? "w-[78%] opacity-100" : "w-full opacity-0",
        ].join(" ")}
      />
    </div>
  );
}
