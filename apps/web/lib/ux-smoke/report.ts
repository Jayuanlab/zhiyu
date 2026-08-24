import "server-only";

import fs from "node:fs";
import path from "node:path";
import { getUxPageMetricTrends, type UxPageMetricTrend } from "./page-events";

export type UxSmokeTrend = {
  name: string;
  samples: number;
  latestMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  thresholdMs: number | null;
  status: number | string | null;
  overThreshold: boolean;
};

export type UxSmokeResult = {
  name: string;
  route: string;
  method: string;
  status: number | string;
  elapsedMs: number;
  thresholdMs: number;
  bytes: number;
  flags?: {
    hit?: boolean;
    stale?: boolean;
    refreshing?: boolean;
    warningCount?: number;
  };
  error?: string | null;
};

export type UxSmokeReport = {
  generatedAt: string;
  baseUrl: string;
  mode: string;
  passed: boolean;
  workshopId: string | null;
  thresholds: {
    apiThresholdMs: number;
    slowApiThresholdMs: number;
    timeoutMs: number;
  };
  discovery: UxSmokeResult;
  warmup: UxSmokeResult[];
  measured: UxSmokeResult[];
  trends?: UxSmokeTrend[];
  failures: string[];
};

export type UxSmokeDashboard = {
  latest: UxSmokeReport | null;
  trends: UxSmokeTrend[];
  pageMetrics: {
    path: string;
    sampleCount: number;
    trends: UxPageMetricTrend[];
  };
  historyCount: number;
  trendWindow: number | null;
  trendSampleCount: number;
  reportDir: string;
  latestMarkdownPath: string;
  historyPath: string;
  missing: boolean;
};

function reportDir() {
  return path.resolve(process.cwd(), ".ux-smoke");
}

function parseReport(value: string) {
  try {
    const parsed = JSON.parse(value) as UxSmokeReport;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function readHistory(historyPath: string) {
  if (!fs.existsSync(historyPath)) return [];
  return fs
    .readFileSync(historyPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseReport)
    .filter((report): report is UxSmokeReport => Boolean(report));
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

export function buildUxSmokeTrendSummary(reports: UxSmokeReport[]) {
  const samplesByName = new Map<
    string,
    Array<{
      elapsedMs: number;
      thresholdMs: number | null;
      status: number | string | null;
    }>
  >();

  for (const report of reports) {
    for (const result of Array.isArray(report.measured) ? report.measured : []) {
      if (typeof result.name !== "string" || typeof result.elapsedMs !== "number") {
        continue;
      }
      const samples = samplesByName.get(result.name) ?? [];
      samples.push({
        elapsedMs: result.elapsedMs,
        thresholdMs:
          typeof result.thresholdMs === "number" ? result.thresholdMs : null,
        status: result.status ?? null,
      });
      samplesByName.set(result.name, samples);
    }
  }

  return Array.from(samplesByName.entries())
    .map(([name, samples]) => {
      const sorted = samples
        .map((sample) => sample.elapsedMs)
        .sort((left, right) => left - right);
      const latest = samples[samples.length - 1];
      const thresholdMs = latest?.thresholdMs ?? null;
      const maxMs = sorted[sorted.length - 1] ?? null;
      return {
        name,
        samples: samples.length,
        latestMs: latest?.elapsedMs ?? null,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        p99Ms: percentile(sorted, 99),
        maxMs,
        thresholdMs,
        status: latest?.status ?? null,
        overThreshold:
          typeof thresholdMs === "number" &&
          typeof maxMs === "number" &&
          maxMs > thresholdMs,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function normalizeWindow(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const integer = Math.floor(value);
  return integer > 0 ? Math.min(integer, 500) : null;
}

export async function getUxSmokeDashboard(options: {
  window?: number | null;
} = {}): Promise<UxSmokeDashboard> {
  const dir = reportDir();
  const latestJsonPath = path.join(dir, "latest.json");
  const latestMarkdownPath = path.join(dir, "latest.md");
  const historyPath = path.join(dir, "history.jsonl");
  const latest = fs.existsSync(latestJsonPath)
    ? parseReport(fs.readFileSync(latestJsonPath, "utf8"))
    : null;
  const history = readHistory(historyPath);
  const trendWindow = normalizeWindow(options.window);
  const trendHistory = trendWindow ? history.slice(-trendWindow) : history;
  const trends = buildUxSmokeTrendSummary(trendHistory);
  const pageMetrics = getUxPageMetricTrends({
    limit: trendWindow ? trendWindow * 50 : undefined,
  });

  return {
    latest,
    trends,
    pageMetrics,
    historyCount: history.length,
    trendWindow,
    trendSampleCount: trendHistory.length,
    reportDir: dir,
    latestMarkdownPath,
    historyPath,
    missing: !latest,
  };
}
