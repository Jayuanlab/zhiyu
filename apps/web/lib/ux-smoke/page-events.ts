import "server-only";

import fs from "node:fs";
import path from "node:path";

export type UxPageMetricName =
  | "route_visible_ms"
  | "route_duration_ms"
  | "initial_navigation_ms";

export type UxPageMetricInput = {
  name: UxPageMetricName;
  path: string;
  valueMs: number;
  at?: string;
  metadata?: Record<string, unknown>;
};

export type UxPageMetricRecord = UxPageMetricInput & {
  receivedAt: string;
  userId: string;
};

export type UxPageMetricTrend = {
  path: string;
  name: UxPageMetricName;
  samples: number;
  latestMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
};

const MAX_BATCH_SIZE = 20;
const MAX_PATH_LENGTH = 300;
const MAX_VALUE_MS = 24 * 60 * 60 * 1000;

function reportDir() {
  return path.resolve(process.cwd(), ".ux-smoke");
}

export function getUxPageMetricsPath() {
  return path.join(reportDir(), "page-events.jsonl");
}

function percentile(sortedValues: number[], percentileValue: number) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

function isMetricName(value: unknown): value is UxPageMetricName {
  return (
    value === "route_visible_ms" ||
    value === "route_duration_ms" ||
    value === "initial_navigation_ms"
  );
}

function sanitizeMetric(
  input: unknown,
): Omit<UxPageMetricInput, "metadata"> & {
  metadata?: Record<string, unknown>;
} | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const name = value.name;
  const metricPath = value.path;
  const valueMs = value.valueMs;
  if (!isMetricName(name)) return null;
  if (typeof metricPath !== "string" || !metricPath.startsWith("/")) {
    return null;
  }
  if (
    typeof valueMs !== "number" ||
    !Number.isFinite(valueMs) ||
    valueMs < 0 ||
    valueMs > MAX_VALUE_MS
  ) {
    return null;
  }

  const metadata =
    value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? Object.fromEntries(
          Object.entries(value.metadata as Record<string, unknown>).filter(
            ([key, metadataValue]) =>
              key.length <= 60 &&
              (typeof metadataValue === "string" ||
                typeof metadataValue === "number" ||
                typeof metadataValue === "boolean" ||
                metadataValue === null),
          ),
        )
      : undefined;

  return {
    name,
    path: metricPath.slice(0, MAX_PATH_LENGTH),
    valueMs: Math.round(valueMs),
    at: typeof value.at === "string" ? value.at.slice(0, 40) : undefined,
    metadata,
  };
}

export function normalizeUxPageMetricBatch(input: unknown) {
  const rawEvents =
    input && typeof input === "object" && Array.isArray((input as { events?: unknown }).events)
      ? (input as { events: unknown[] }).events
      : Array.isArray(input)
        ? input
        : [input];

  return rawEvents
    .slice(0, MAX_BATCH_SIZE)
    .map(sanitizeMetric)
    .filter((event): event is UxPageMetricInput => Boolean(event));
}

export function appendUxPageMetricEvents(options: {
  userId: string;
  events: UxPageMetricInput[];
}) {
  if (options.events.length === 0) return 0;
  const dir = reportDir();
  fs.mkdirSync(dir, { recursive: true });
  const receivedAt = new Date().toISOString();
  const lines = options.events
    .map((event) =>
      JSON.stringify({
        ...event,
        userId: options.userId,
        receivedAt,
      } satisfies UxPageMetricRecord),
    )
    .join("\n");
  fs.appendFileSync(getUxPageMetricsPath(), `${lines}\n`, "utf8");
  return options.events.length;
}

function parseRecord(value: string) {
  try {
    const parsed = JSON.parse(value) as UxPageMetricRecord;
    return parsed && typeof parsed === "object" && isMetricName(parsed.name)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function readRecentPageMetricRecords(limit: number) {
  const pageMetricsPath = getUxPageMetricsPath();
  if (!fs.existsSync(pageMetricsPath)) return [];
  const lines = fs
    .readFileSync(pageMetricsPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines
    .slice(-Math.max(limit, 1))
    .map(parseRecord)
    .filter((record): record is UxPageMetricRecord => Boolean(record));
}

export function getUxPageMetricTrends(options: { limit?: number } = {}) {
  const limit =
    typeof options.limit === "number" && Number.isFinite(options.limit)
      ? Math.min(Math.max(Math.floor(options.limit), 1), 5000)
      : 1000;
  const records = readRecentPageMetricRecords(limit);
  const grouped = new Map<string, UxPageMetricRecord[]>();

  for (const record of records) {
    const key = `${record.path}\u0000${record.name}`;
    const group = grouped.get(key) ?? [];
    group.push(record);
    grouped.set(key, group);
  }

  const trends: UxPageMetricTrend[] = Array.from(grouped.values()).map((group) => {
    const sorted = group.map((record) => record.valueMs).sort((left, right) => left - right);
    const latest = group[group.length - 1];
    return {
      path: latest.path,
      name: latest.name,
      samples: group.length,
      latestMs: latest.valueMs,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted[sorted.length - 1] ?? null,
    };
  });

  return {
    path: getUxPageMetricsPath(),
    sampleCount: records.length,
    trends: trends.sort((left, right) => {
      const byPath = left.path.localeCompare(right.path);
      return byPath === 0 ? left.name.localeCompare(right.name) : byPath;
    }),
  };
}
