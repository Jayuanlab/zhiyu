import { auth } from "@/app/(auth)/auth";
import { getUxSmokeDashboard, type UxSmokeTrend } from "@/lib/ux-smoke/report";
import type { UxPageMetricTrend } from "@/lib/ux-smoke/page-events";
import { cn } from "@/lib/utils";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

function formatMs(value: number | null | undefined) {
  return typeof value === "number" ? `${value}ms` : "-";
}

function statusTone(value: boolean) {
  return value
    ? "border-rose-200 bg-rose-50 text-rose-700"
    : "border-emerald-200 bg-emerald-50 text-emerald-700";
}

function thresholdRatio(trend: UxSmokeTrend) {
  if (!trend.thresholdMs || !trend.p95Ms) return 0;
  return Math.min(Math.round((trend.p95Ms / trend.thresholdMs) * 100), 100);
}

function pageMetricLabel(value: UxPageMetricTrend["name"]) {
  switch (value) {
    case "initial_navigation_ms":
      return "Initial Navigation";
    case "route_duration_ms":
      return "Route Duration";
    case "route_visible_ms":
      return "Route Visible";
    default:
      return value;
  }
}

function parseWindowParam(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export default async function UxPerformancePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/login");
  }

  const params = searchParams ? await searchParams : {};
  const trendWindow = parseWindowParam(params.window);
  const dashboard = await getUxSmokeDashboard({ window: trendWindow });
  const latest = dashboard.latest;
  const trends = dashboard.trends;
  const slowest = [...trends].sort(
    (left, right) => (right.p95Ms ?? 0) - (left.p95Ms ?? 0),
  )[0];
  const overThreshold = trends.filter((trend) => trend.overThreshold).length;

  return (
    <main className="h-full overflow-y-auto rounded-xl bg-background">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 lg:p-6">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal text-foreground">
              UX Performance
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {latest
                ? `Latest smoke: ${latest.generatedAt}`
                : "No UX smoke report has been generated yet."}
            </p>
          </div>
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-sm font-medium",
              statusTone(!latest?.passed || overThreshold > 0),
            )}
          >
            {latest?.passed && overThreshold === 0 ? "Healthy" : "Needs attention"}
          </div>
        </header>

        <section className="grid gap-3 md:grid-cols-4">
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">History Samples</p>
            <p className="mt-2 text-2xl font-semibold">{dashboard.historyCount}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">Measured Routes</p>
            <p className="mt-2 text-2xl font-semibold">{trends.length}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">Over Threshold</p>
            <p className="mt-2 text-2xl font-semibold">{overThreshold}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <p className="text-xs text-muted-foreground">Slowest p95</p>
            <p className="mt-2 truncate text-2xl font-semibold">
              {slowest ? formatMs(slowest.p95Ms) : "-"}
            </p>
          </div>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4 text-sm">
          <div>
            <p className="font-medium text-foreground">Trend Window</p>
            <p className="mt-1 text-muted-foreground">
              Using {dashboard.trendSampleCount} of {dashboard.historyCount} smoke
              samples.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {[10, 20, 50].map((value) => (
              <a
                key={value}
                href={`/ux-performance?window=${value}`}
                className={cn(
                  "rounded-md border px-3 py-1.5",
                  dashboard.trendWindow === value
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border hover:bg-muted",
                )}
              >
                Last {value}
              </a>
            ))}
            <a
              href="/ux-performance"
              className={cn(
                "rounded-md border px-3 py-1.5",
                dashboard.trendWindow === null
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border hover:bg-muted",
              )}
            >
              All
            </a>
          </div>
        </section>

        {dashboard.missing ? (
          <section className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
            Run <code>pnpm --filter web smoke:ux</code> to generate the first
            local UX performance report.
          </section>
        ) : null}

        <section className="rounded-lg border border-border">
          <div className="border-b border-border p-4">
            <h2 className="text-base font-semibold text-foreground">
              Hot Path Trend
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Check</th>
                  <th className="px-4 py-3 text-right font-medium">Samples</th>
                  <th className="px-4 py-3 text-right font-medium">Latest</th>
                  <th className="px-4 py-3 text-right font-medium">p50</th>
                  <th className="px-4 py-3 text-right font-medium">p95</th>
                  <th className="px-4 py-3 text-right font-medium">p99</th>
                  <th className="px-4 py-3 text-right font-medium">Max</th>
                  <th className="px-4 py-3 text-right font-medium">Threshold</th>
                  <th className="px-4 py-3 font-medium">p95 Load</th>
                </tr>
              </thead>
              <tbody>
                {trends.map((trend) => {
                  const ratio = thresholdRatio(trend);
                  return (
                    <tr key={trend.name} className="border-t border-border">
                      <td className="px-4 py-3 font-medium text-foreground">
                        {trend.name}
                      </td>
                      <td className="px-4 py-3 text-right">{trend.samples}</td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.latestMs)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.p50Ms)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.p95Ms)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.p99Ms)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.maxMs)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.thresholdMs)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="h-2 w-full rounded bg-muted">
                          <div
                            className={cn(
                              "h-2 rounded",
                              trend.overThreshold
                                ? "bg-rose-500"
                                : ratio > 70
                                  ? "bg-amber-500"
                                  : "bg-emerald-500",
                            )}
                            style={{ width: `${Math.max(ratio, 3)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-lg border border-border">
          <div className="border-b border-border p-4">
            <h2 className="text-base font-semibold text-foreground">
              Page Experience
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {dashboard.pageMetrics.sampleCount > 0
                ? `${dashboard.pageMetrics.sampleCount} browser page events recorded.`
                : "No browser page events have been recorded yet."}
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Path</th>
                  <th className="px-4 py-3 font-medium">Metric</th>
                  <th className="px-4 py-3 text-right font-medium">Samples</th>
                  <th className="px-4 py-3 text-right font-medium">Latest</th>
                  <th className="px-4 py-3 text-right font-medium">p50</th>
                  <th className="px-4 py-3 text-right font-medium">p95</th>
                  <th className="px-4 py-3 text-right font-medium">p99</th>
                  <th className="px-4 py-3 text-right font-medium">Max</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.pageMetrics.trends.length === 0 ? (
                  <tr className="border-t border-border">
                    <td
                      className="px-4 py-6 text-center text-muted-foreground"
                      colSpan={8}
                    >
                      Open a few pages after logging in to collect browser
                      experience events.
                    </td>
                  </tr>
                ) : (
                  dashboard.pageMetrics.trends.map((trend) => (
                    <tr
                      key={`${trend.path}:${trend.name}`}
                      className="border-t border-border"
                    >
                      <td className="max-w-[280px] truncate px-4 py-3 font-medium text-foreground">
                        {trend.path}
                      </td>
                      <td className="px-4 py-3">{pageMetricLabel(trend.name)}</td>
                      <td className="px-4 py-3 text-right">{trend.samples}</td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.latestMs)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.p50Ms)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.p95Ms)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.p99Ms)}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {formatMs(trend.maxMs)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-3 lg:grid-cols-2">
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-base font-semibold text-foreground">
              Latest Measured
            </h2>
            <div className="mt-3 space-y-2">
              {(latest?.measured ?? []).map((result) => (
                <div
                  key={`${result.method}:${result.route}`}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/30 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate">{result.name}</span>
                  <span className="font-medium tabular-nums">
                    {formatMs(result.elapsedMs)}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-lg border border-border p-4">
            <h2 className="text-base font-semibold text-foreground">
              Report Files
            </h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Report Dir</dt>
                <dd className="break-all font-mono text-xs">{dashboard.reportDir}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Latest Markdown</dt>
                <dd className="break-all font-mono text-xs">
                  {dashboard.latestMarkdownPath}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">History</dt>
                <dd className="break-all font-mono text-xs">{dashboard.historyPath}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>
    </main>
  );
}
