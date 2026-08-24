"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type PageMetricName =
  | "route_visible_ms"
  | "route_duration_ms"
  | "initial_navigation_ms";

type PageMetric = {
  name: PageMetricName;
  path: string;
  valueMs: number;
  at: string;
  metadata?: Record<string, string | number | boolean | null>;
};

const ENDPOINT = "/api/ux-performance/page-events";
const SAMPLE_RATE = Number.parseFloat(
  process.env.NEXT_PUBLIC_UX_PAGE_METRIC_SAMPLE_RATE ?? "1",
);

function shouldSample() {
  if (!Number.isFinite(SAMPLE_RATE)) return true;
  if (SAMPLE_RATE >= 1) return true;
  if (SAMPLE_RATE <= 0) return false;
  return Math.random() <= SAMPLE_RATE;
}

function postMetrics(events: PageMetric[]) {
  if (events.length === 0) return;
  const body = JSON.stringify({ events });
  if (typeof navigator !== "undefined" && "sendBeacon" in navigator) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(ENDPOINT, blob)) return;
  }
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

function nowIso() {
  return new Date().toISOString();
}

function visibleAfterPaint(callback: (valueMs: number) => void) {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => callback(performance.now()));
  });
}

export function UxPageMetricsProbe() {
  const pathname = usePathname();
  const sampledRef = useRef<boolean | null>(null);
  const routeStartedAtRef = useRef<number>(0);
  const routePathRef = useRef<string | null>(null);
  const sentInitialNavigationRef = useRef(false);

  if (sampledRef.current === null) {
    sampledRef.current = shouldSample();
  }

  useEffect(() => {
    if (!sampledRef.current || !pathname) return;

    const previousPath = routePathRef.current;
    const previousStartedAt = routeStartedAtRef.current;
    const currentStartedAt = performance.now();
    routeStartedAtRef.current = currentStartedAt;
    routePathRef.current = pathname;

    if (previousPath && previousStartedAt > 0) {
      postMetrics([
        {
          name: "route_duration_ms",
          path: previousPath,
          valueMs: currentStartedAt - previousStartedAt,
          at: nowIso(),
          metadata: { reason: "route_change" },
        },
      ]);
    }

    visibleAfterPaint((paintedAt) => {
      if (routePathRef.current !== pathname) return;
      const events: PageMetric[] = [
        {
          name: "route_visible_ms",
          path: pathname,
          valueMs: paintedAt - currentStartedAt,
          at: nowIso(),
        },
      ];

      if (!sentInitialNavigationRef.current) {
        sentInitialNavigationRef.current = true;
        const navigationEntry = performance.getEntriesByType("navigation")[0] as
          | PerformanceNavigationTiming
          | undefined;
        if (navigationEntry) {
          events.push({
            name: "initial_navigation_ms",
            path: pathname,
            valueMs: navigationEntry.domContentLoadedEventEnd,
            at: nowIso(),
            metadata: {
              responseStartMs: Math.round(navigationEntry.responseStart),
              domInteractiveMs: Math.round(navigationEntry.domInteractive),
            },
          });
        }
      }

      postMetrics(events);
    });
  }, [pathname]);

  useEffect(() => {
    if (!sampledRef.current) return;

    const flushRouteDuration = (reason: string) => {
      const currentPath = routePathRef.current;
      const currentStartedAt = routeStartedAtRef.current;
      if (!currentPath || currentStartedAt <= 0) return;
      postMetrics([
        {
          name: "route_duration_ms",
          path: currentPath,
          valueMs: performance.now() - currentStartedAt,
          at: nowIso(),
          metadata: { reason },
        },
      ]);
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        flushRouteDuration("visibility_hidden");
      }
    };
    const onPageHide = () => flushRouteDuration("pagehide");

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, []);

  return null;
}
