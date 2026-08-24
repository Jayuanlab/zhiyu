const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const path = require("node:path");

const baseUrl = process.env.UX_SMOKE_BASE_URL || "http://127.0.0.1:3515";
const timeoutMs = Number(process.env.UX_SMOKE_TIMEOUT_MS || "30000");
const apiThresholdMs = Number(process.env.UX_SMOKE_API_THRESHOLD_MS || "800");
const slowApiThresholdMs = Number(
  process.env.UX_SMOKE_SLOW_API_THRESHOLD_MS || "2500",
);
const reportDir = path.resolve(
  process.env.UX_SMOKE_REPORT_DIR || path.join(process.cwd(), ".ux-smoke"),
);
const writeReport = process.env.UX_SMOKE_WRITE_REPORT !== "false";
const sessionCookie = process.env.UX_SMOKE_COOKIE?.trim();
const protectedStatus = sessionCookie ? 200 : [200, 401];

function expectedStatusText(expectedStatus) {
  return Array.isArray(expectedStatus)
    ? expectedStatus.join("/")
    : String(expectedStatus);
}

function isExpectedStatus(status, expectedStatus) {
  return Array.isArray(expectedStatus)
    ? expectedStatus.includes(status)
    : status === expectedStatus;
}

function readJsonFlags(value) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const meta = value.meta && typeof value.meta === "object" ? value.meta : {};
  const metaCache =
    meta.cache && typeof meta.cache === "object" ? meta.cache : {};
  const cache =
    value.cache && typeof value.cache === "object" ? value.cache : {};
  const warnings = Array.isArray(meta.warnings)
    ? meta.warnings.length
    : Array.isArray(value.warnings)
      ? value.warnings.length
      : 0;

  return {
    hit: Boolean(metaCache.hit ?? meta.hit ?? cache.hit),
    stale: Boolean(metaCache.stale ?? meta.stale ?? cache.stale),
    refreshing: Boolean(
      metaCache.refreshing ?? meta.refreshing ?? cache.refreshing,
    ),
    warningCount: warnings,
    selectedWorkshopId:
      typeof value.selectedWorkshopId === "string"
        ? value.selectedWorkshopId
        : null,
  };
}

async function fetchWithTiming(check) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  const url = `${baseUrl}${check.route}`;

  try {
    const response = await fetch(url, {
      method: check.method || "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json,text/html;q=0.8,*/*;q=0.5",
        ...(check.body ? { "Content-Type": "application/json" } : {}),
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      body: check.body ? JSON.stringify(check.body) : undefined,
    });
    const body = await response.text();
    let parsed = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }

    return {
      ...check,
      status: response.status,
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes: body.length,
      finalUrl: response.url,
      flags: readJsonFlags(parsed),
      json: parsed,
    };
  } catch (error) {
    return {
      ...check,
      status: "ERR",
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
      flags: {},
      json: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function formatFlags(flags) {
  const parts = [];
  if (flags.hit) {
    parts.push("hit");
  }
  if (flags.stale) {
    parts.push("stale");
  }
  if (flags.refreshing) {
    parts.push("refreshing");
  }
  if (typeof flags.warningCount === "number" && flags.warningCount > 0) {
    parts.push(`warnings=${flags.warningCount}`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

async function discoverWorkshopId() {
  const result = await fetchWithTiming({
    name: "workshop page-state discovery",
    route: "/api/page-state/workshop",
    expectedStatus: protectedStatus,
    thresholdMs: apiThresholdMs,
  });

  if (result.status !== 200) {
    return {
      workshopId: null,
      discovery: result,
    };
  }

  const explicitId =
    typeof process.env.UX_SMOKE_WORKSHOP_ID === "string"
      ? process.env.UX_SMOKE_WORKSHOP_ID.trim()
      : "";
  return {
    workshopId: explicitId || result.flags.selectedWorkshopId,
    discovery: result,
  };
}

function buildChecks(workshopId) {
  const checks = [
    {
      name: "quant page-state",
      route: "/api/page-state/quant",
      expectedStatus: protectedStatus,
      thresholdMs: apiThresholdMs,
    },
    {
      name: "workshop page-state",
      route: "/api/page-state/workshop",
      expectedStatus: protectedStatus,
      thresholdMs: apiThresholdMs,
    },
    {
      name: "quant paper account",
      route: "/api/quant/paper/account",
      expectedStatus: protectedStatus,
      thresholdMs: apiThresholdMs,
    },
    {
      name: "quant dashboard",
      route: "/api/quant/dashboard",
      expectedStatus: protectedStatus,
      thresholdMs: slowApiThresholdMs,
    },
    {
      name: "memory search",
      route: "/api/memory/search",
      method: "POST",
      body: { query: "ux performance smoke", limit: 5 },
      expectedStatus: protectedStatus,
      thresholdMs: slowApiThresholdMs,
    },
  ];

  if (workshopId) {
    checks.push({
      name: "workshop summary page-state",
      route: `/api/page-state/workshop/${encodeURIComponent(workshopId)}/summary`,
      expectedStatus: protectedStatus,
      thresholdMs: apiThresholdMs,
    });
    checks.push({
      name: "workshop summary refresh",
      route: `/api/page-state/workshop/${encodeURIComponent(workshopId)}/summary?refresh=1`,
      expectedStatus: protectedStatus,
      thresholdMs: slowApiThresholdMs,
    });
    checks.push({
      name: "workshop dashboard",
      route: `/api/workshops/${encodeURIComponent(workshopId)}/dashboard`,
      expectedStatus: protectedStatus,
      thresholdMs: slowApiThresholdMs,
    });
  }

  return checks;
}

async function runPass(label, checks) {
  console.log(`[ux-smoke] ${label}`);
  const results = [];
  for (const check of checks) {
    const result = await fetchWithTiming(check);
    results.push(result);
    console.log(
      `[ux-smoke] ${check.name} ${check.method || "GET"} ${check.route} -> ${result.status} (${result.elapsedMs}ms, ${result.bytes} bytes)${formatFlags(result.flags)}`,
    );
  }
  return results;
}

function validate(results) {
  const failures = [];
  for (const result of results) {
    if (!isExpectedStatus(result.status, result.expectedStatus)) {
      failures.push(
        `${result.name}: expected status ${expectedStatusText(
          result.expectedStatus,
        )}, got ${result.status}${result.error ? ` (${result.error})` : ""}`,
      );
      continue;
    }

    if (result.status === 401 && !sessionCookie) {
      continue;
    }

    if (result.elapsedMs > result.thresholdMs) {
      failures.push(
        `${result.name}: expected <= ${result.thresholdMs}ms, got ${result.elapsedMs}ms`,
      );
    }
  }
  return failures;
}

function resultForReport(result) {
  return {
    name: result.name,
    route: result.route,
    method: result.method || "GET",
    status: result.status,
    expectedStatus: result.expectedStatus,
    elapsedMs: result.elapsedMs,
    thresholdMs: result.thresholdMs,
    bytes: result.bytes,
    flags: result.flags,
    error: result.error ?? null,
  };
}

function markdownTable(results) {
  const rows = [
    "| Check | Status | ms | Threshold | Bytes | Flags |",
    "| --- | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const result of results) {
    rows.push(
      `| ${result.name} | ${result.status} | ${result.elapsedMs} | ${result.thresholdMs} | ${result.bytes} | ${formatFlags(result.flags).trim() || "-"} |`,
    );
  }
  return rows.join("\n");
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return sortedValues[Math.min(Math.max(index, 0), sortedValues.length - 1)];
}

function loadHistoryReports(historyPath) {
  if (!fs.existsSync(historyPath)) return [];
  const raw = fs.readFileSync(historyPath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((item) => item && typeof item === "object");
}

function buildTrendSummary(reports) {
  const samplesByName = new Map();
  for (const report of reports) {
    const generatedAt =
      typeof report.generatedAt === "string" ? report.generatedAt : null;
    const measured = Array.isArray(report.measured) ? report.measured : [];
    for (const result of measured) {
      if (
        !result ||
        typeof result.name !== "string" ||
        typeof result.elapsedMs !== "number"
      ) {
        continue;
      }
      const current = samplesByName.get(result.name) ?? [];
      current.push({
        generatedAt,
        elapsedMs: result.elapsedMs,
        thresholdMs:
          typeof result.thresholdMs === "number" ? result.thresholdMs : null,
        status: result.status,
      });
      samplesByName.set(result.name, current);
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

function trendMarkdownTable(trends) {
  if (!Array.isArray(trends) || trends.length === 0) {
    return "No history samples yet.";
  }
  const rows = [
    "| Check | Samples | Latest | p50 | p95 | p99 | Max | Threshold |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const trend of trends) {
    rows.push(
      `| ${trend.name} | ${trend.samples} | ${trend.latestMs ?? "-"} | ${trend.p50Ms ?? "-"} | ${trend.p95Ms ?? "-"} | ${trend.p99Ms ?? "-"} | ${trend.maxMs ?? "-"} | ${trend.thresholdMs ?? "-"} |`,
    );
  }
  return rows.join("\n");
}

function writeSmokeReport(report) {
  if (!writeReport) return null;
  fs.mkdirSync(reportDir, { recursive: true });
  const latestJsonPath = path.join(reportDir, "latest.json");
  const latestMarkdownPath = path.join(reportDir, "latest.md");
  const historyPath = path.join(reportDir, "history.jsonl");
  const json = `${JSON.stringify(report, null, 2)}\n`;
  fs.writeFileSync(latestJsonPath, json, "utf8");
  fs.appendFileSync(historyPath, `${JSON.stringify(report)}\n`, "utf8");
  const trends = buildTrendSummary(loadHistoryReports(historyPath));
  const enrichedReport = { ...report, trends };
  fs.writeFileSync(latestJsonPath, `${JSON.stringify(enrichedReport, null, 2)}\n`, "utf8");
  fs.writeFileSync(
    latestMarkdownPath,
    [
      `# UX Smoke Report`,
      "",
      `- generatedAt: ${report.generatedAt}`,
      `- baseUrl: ${report.baseUrl}`,
      `- mode: ${report.mode}`,
      `- status: ${report.passed ? "passed" : "failed"}`,
      `- workshopId: ${report.workshopId ?? "-"}`,
      `- apiThresholdMs: ${report.thresholds.apiThresholdMs}`,
      `- slowApiThresholdMs: ${report.thresholds.slowApiThresholdMs}`,
      "",
      "## Discovery",
      "",
      markdownTable([report.discovery]),
      "",
      "## Measured Hot Path",
      "",
      markdownTable(report.measured),
      "",
      "## History Trend",
      "",
      trendMarkdownTable(trends),
      "",
      report.failures.length > 0 ? "## Failures" : "",
      report.failures.length > 0
        ? report.failures.map((failure) => `- ${failure}`).join("\n")
        : "",
      "",
    ]
      .filter((line, index, lines) => line || lines[index - 1])
      .join("\n"),
    "utf8",
  );
  return { latestJsonPath, latestMarkdownPath, historyPath };
}

async function main() {
  console.log(`[ux-smoke] baseUrl=${baseUrl}`);
  console.log(
    `[ux-smoke] mode=${sessionCookie ? "authenticated business paths" : "unauthenticated proxy/auth paths"}`,
  );
  console.log(
    `[ux-smoke] thresholds: api<=${apiThresholdMs}ms slowApi<=${slowApiThresholdMs}ms timeout=${timeoutMs}ms`,
  );

  const { workshopId, discovery } = await discoverWorkshopId();
  console.log(
    `[ux-smoke] discovery /api/page-state/workshop -> ${discovery.status} (${discovery.elapsedMs}ms, ${discovery.bytes} bytes)${formatFlags(discovery.flags)}`,
  );
  if (!workshopId) {
    console.log(
      "[ux-smoke] workshop dashboard check skipped; no selected workshop id was available",
    );
  }

  const checks = buildChecks(workshopId);
  const warmup = await runPass("warmup pass", checks);
  const measured = await runPass("measured hot-path pass", checks);
  const failures = validate(measured);
  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    mode: sessionCookie ? "authenticated business paths" : "unauthenticated proxy/auth paths",
    passed: failures.length === 0,
    workshopId,
    thresholds: {
      apiThresholdMs,
      slowApiThresholdMs,
      timeoutMs,
    },
    discovery: resultForReport(discovery),
    warmup: warmup.map(resultForReport),
    measured: measured.map(resultForReport),
    failures,
  };
  const reportPaths = writeSmokeReport(report);
  if (reportPaths) {
    console.log(`[ux-smoke] report ${reportPaths.latestMarkdownPath}`);
  }

  if (failures.length > 0) {
    console.error("[ux-smoke] failed:");
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }

  console.log("[ux-smoke] passed");
}

main().catch((error) => {
  console.error("[ux-smoke] fatal:", error);
  process.exit(1);
});
