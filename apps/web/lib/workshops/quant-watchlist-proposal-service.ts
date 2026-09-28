import { runAStockDataAction } from "./a-stock-data-client";
import {
  fetchQuantDashboard,
  fetchQuantPaperAccount,
  fetchQuantWatchlistConfig,
  updateQuantWatchlistConfig,
} from "@/lib/quant/client";
import { assertQuantDashboardUsableForControl } from "@/lib/quant/control-guards";
import { appendWorkshopEvent, type WorkshopWriteContext } from "./service";
import { upsertWorkshopReviewItemFromProposalEvent } from "./review-items";
import { resolveWatchlistProposal } from "./watchlist-proposals";

const QUANT_WATCHLIST_MAX_CODES = 30;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeQuantWatchlistCode(raw: string) {
  const compact = raw.trim().toUpperCase().replace(/\s+/g, "");
  if (!compact) return null;

  if (/^(SH|SZ|BJ)\d{6}$/.test(compact)) {
    return `${compact.slice(2)}.${compact.slice(0, 2)}`;
  }

  if (/^\d{6}\.(SH|SZ|BJ)$/.test(compact)) return compact;

  if (/^\d{6}$/.test(compact)) {
    if (/^[69]/.test(compact)) return `${compact}.SH`;
    if (/^[023]/.test(compact)) return `${compact}.SZ`;
    if (/^[48]/.test(compact)) return `${compact}.BJ`;
  }

  return null;
}

export function normalizeQuantWatchlistCodes(rawCodes: string[]) {
  const codes: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawCodes) {
    const code = normalizeQuantWatchlistCode(raw);
    if (!code) {
      invalid.push(raw);
      continue;
    }
    if (!seen.has(code)) {
      codes.push(code);
      seen.add(code);
    }
  }

  return { codes, invalid };
}

export function compactQuantWatchlistItem(item: Record<string, unknown>) {
  return {
    code: item.code,
    name: item.name,
    price: item.price,
    change_pct: item.change_pct ?? item.changePct,
    turnover_billion: item.turnover_billion ?? item.turnoverBillion,
    pe_ttm: item.pe_ttm ?? item.peTtm,
    turnover_rate: item.turnover_rate ?? item.turnoverRate,
    tags: Array.isArray(item.tags) ? item.tags : undefined,
    updated_at: item.updated_at ?? item.updatedAt,
  };
}

export function compactAStockQuoteAsWatchlistItem(
  code: string,
  quote: Record<string, unknown>,
  fetchedAt?: string,
) {
  return {
    code,
    name: quote.name,
    price: quote.price,
    change_pct: quote.changePct ?? quote.change_pct,
    turnover_billion: quote.turnoverBillion ?? quote.turnover_billion,
    pe_ttm: quote.peTtm ?? quote.pe_ttm,
    turnover_rate: quote.turnoverPct ?? quote.turnover_rate,
    updated_at: fetchedAt,
    source: "a-stock-data",
  };
}

export function quoteRecordForCode(
  data: Record<string, unknown>,
  code: string,
): Record<string, unknown> {
  const symbol = code.split(".")[0] ?? code;
  const value = data[code] ?? data[symbol];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export interface QuantPaperWatchlistChangeProposalInput {
  workshopId: string;
  userId: string;
  runId?: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  add: string[];
  remove: string[];
  keep: string[];
  reason: string;
  strategyFit: string;
  risk: string;
  evidenceSourceEventIds?: string[];
  source?: Record<string, unknown>;
  writeContext?: WorkshopWriteContext;
  withWriteContext?: <T>(
    write: (context: WorkshopWriteContext) => Promise<T>,
  ) => Promise<T>;
}

export interface QuantPaperWatchlistChangeProposalPayload {
  proposalId: string;
  status: string;
  before: string[];
  after: string[];
  add: Array<Record<string, unknown>>;
  remove: Array<Record<string, unknown>>;
  protectedRemove: Array<Record<string, unknown>>;
  validation: {
    ok: boolean;
    issues: string[];
    warnings: string[];
  };
  approvalRequired: boolean;
  eventId: string | null;
  appliedConfig: Awaited<ReturnType<typeof updateQuantWatchlistConfig>> | null;
  applyError: string | null;
}

async function appendWatchlistProposalEvent(
  input: Parameters<typeof appendWorkshopEvent>[0],
  context?: WorkshopWriteContext,
) {
  try {
    return context ? await context.append(input) : await appendWorkshopEvent(input);
  } catch (error) {
    console.warn("[QuantWatchlistProposal] failed to append proposal event", {
      workshopId: input.workshopId,
      runId: input.runId,
      loopId: input.loopId,
      loopRunId: input.loopRunId,
      type: input.type,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function proposeQuantPaperWatchlistChange(
  input: QuantPaperWatchlistChangeProposalInput,
): Promise<QuantPaperWatchlistChangeProposalPayload> {
  const [config, dashboard, account] = await Promise.all([
    fetchQuantWatchlistConfig(),
    fetchQuantDashboard(),
    fetchQuantPaperAccount(input.userId),
  ]);
  assertQuantDashboardUsableForControl(dashboard, "Watchlist control");

  const beforeCodes = config.codes
    .map((code) => normalizeQuantWatchlistCode(code))
    .filter((code): code is string => Boolean(code));
  const addInput = normalizeQuantWatchlistCodes(input.add);
  const removeInput = normalizeQuantWatchlistCodes(input.remove);
  const keepInput = normalizeQuantWatchlistCodes(input.keep);
  const keepSet = new Set(keepInput.codes);
  const removeSet = new Set(
    removeInput.codes.filter((code) => !keepSet.has(code)),
  );
  const addSet = new Set(addInput.codes);
  const warnings: string[] = [];
  const issues: string[] = [];

  if (addInput.invalid.length > 0) {
    issues.push(`Invalid add codes: ${addInput.invalid.join(", ")}`);
  }
  if (removeInput.invalid.length > 0) {
    issues.push(`Invalid remove codes: ${removeInput.invalid.join(", ")}`);
  }
  if (keepInput.invalid.length > 0) {
    issues.push(`Invalid keep codes: ${keepInput.invalid.join(", ")}`);
  }

  const beforeSet = new Set(beforeCodes);
  for (const code of addSet) {
    if (beforeSet.has(code)) {
      warnings.push(`${code} is already in the watchlist.`);
    }
  }
  const outOfScopeRemoveCodes: string[] = [];
  for (const code of removeSet) {
    if (!beforeSet.has(code)) {
      outOfScopeRemoveCodes.push(code);
    }
  }
  if (outOfScopeRemoveCodes.length > 0) {
    issues.push(
      [
        `Remove contains symbols outside the current active watchlist: ${outOfScopeRemoveCodes.join(", ")}.`,
        `Current active watchlist: ${beforeCodes.join(", ") || "-"}.`,
        "quantPaperProposeWatchlistChange cannot clean or archive candidate-pool-only symbols; log a candidate-pool maintenance decision or create a follow-up task instead.",
      ].join(" "),
    );
  }

  const positionCodes = new Set(
    account.positions
      .filter((position) => position.quantity > 0)
      .map((position) => normalizeQuantWatchlistCode(position.code))
      .filter((code): code is string => Boolean(code)),
  );
  const openOrderCodes = new Set(
    account.open_orders
      .filter((order) =>
        ["submitted", "partially_filled"].includes(order.status),
      )
      .map((order) => normalizeQuantWatchlistCode(order.code))
      .filter((code): code is string => Boolean(code)),
  );
  const protectedRemoveSet = new Set<string>();
  for (const code of removeSet) {
    if (positionCodes.has(code)) {
      protectedRemoveSet.add(code);
      warnings.push(
        `${code} has a paper position; it will remain in the quote universe as holding tracking.`,
      );
    }
    if (openOrderCodes.has(code)) {
      protectedRemoveSet.add(code);
      warnings.push(
        `${code} has an open paper order; it will remain in the quote universe until the order is resolved.`,
      );
    }
  }

  const effectiveRemoveSet = new Set(
    [...removeSet].filter((code) => !protectedRemoveSet.has(code)),
  );
  const afterCodes = beforeCodes.filter(
    (code) => !effectiveRemoveSet.has(code),
  );
  for (const code of addSet) {
    if (!afterCodes.includes(code)) afterCodes.push(code);
  }

  if (afterCodes.length === beforeCodes.length) {
    const same = afterCodes.every((code, index) => beforeCodes[index] === code);
    if (same && outOfScopeRemoveCodes.length === 0) {
      issues.push("No effective watchlist change requested.");
    }
  }
  if (afterCodes.length === 0) {
    issues.push("Watchlist cannot be empty.");
  }
  if (afterCodes.length > QUANT_WATCHLIST_MAX_CODES) {
    issues.push(
      `Watchlist has ${afterCodes.length} codes; max is ${QUANT_WATCHLIST_MAX_CODES}.`,
    );
  }

  const dashboardItems = new Map(
    dashboard.watchlist.map((item) => [item.code, asRecord(item)]),
  );
  const addedMissingFromDashboard = [...addSet].filter(
    (code) => !dashboardItems.has(code),
  );
  const quoteResult =
    addedMissingFromDashboard.length > 0
      ? await runAStockDataAction({
          action: "quote",
          args: { codes: addedMissingFromDashboard },
        })
      : null;
  if (quoteResult && !quoteResult.ok) {
    warnings.push(
      `Added-symbol quote check failed: ${quoteResult.error ?? "unknown error"}`,
    );
  }
  const quoteData = asRecord(quoteResult?.data);
  const addItems = [...addSet].map((code) => {
    const current = dashboardItems.get(code);
    if (current) return compactQuantWatchlistItem(current);
    return compactAStockQuoteAsWatchlistItem(
      code,
      quoteRecordForCode(quoteData, code),
      quoteResult?.fetchedAt,
    );
  });
  const removeItems = [...effectiveRemoveSet].map((code) => {
    const current = dashboardItems.get(code);
    return current ? compactQuantWatchlistItem(current) : { code };
  });
  const protectedRemoveItems = [...protectedRemoveSet].map((code) => {
    const current = dashboardItems.get(code);
    return current ? compactQuantWatchlistItem(current) : { code };
  });
  const validation = {
    ok: issues.length === 0,
    issues,
    warnings,
  };
  const proposalId = crypto.randomUUID();
  const status = validation.ok ? "pending_approval" : "invalid";
  const body = [
    `Status: ${status}`,
    `Before: ${beforeCodes.join(", ") || "-"}`,
    `After: ${afterCodes.join(", ") || "-"}`,
    `Add: ${[...addSet].join(", ") || "-"}`,
    `Remove: ${[...effectiveRemoveSet].join(", ") || "-"}`,
    protectedRemoveSet.size > 0
      ? `Protected remove kept: ${[...protectedRemoveSet].join(", ")}`
      : "",
    `Reason: ${input.reason}`,
    `Strategy fit: ${input.strategyFit}`,
    `Risk: ${input.risk}`,
    issues.length > 0 ? `Issues: ${issues.join("; ")}` : "",
    warnings.length > 0 ? `Warnings: ${warnings.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const eventInput: Parameters<typeof appendWorkshopEvent>[0] = {
      workshopId: input.workshopId,
      runId: input.runId ?? null,
      loopId: input.loopId ?? null,
      loopRunId: input.loopRunId ?? null,
      type: "watchlist_proposal",
      title: validation.ok
        ? "自选股调整提案待自动应用"
        : "自选股调整提案校验未通过",
      body,
      metadata: {
        provider: "quant-paper",
        kind: "watchlist_change_proposal",
        scope: "active_core_trading_watchlist",
        proposalId,
        status,
        before: beforeCodes,
        after: afterCodes,
        add: [...addSet],
        remove: [...effectiveRemoveSet],
        requestedRemove: [...removeSet],
        outOfScopeRemove: outOfScopeRemoveCodes,
        currentActiveWatchlist: beforeCodes,
        protectedRemove: [...protectedRemoveSet],
        keep: keepInput.codes,
        addItems,
        removeItems,
        protectedRemoveItems,
        reason: input.reason,
        strategyFit: input.strategyFit,
        risk: input.risk,
        validation,
        approvalRequired: false,
        autoApply: validation.ok,
        evidenceSourceEventIds: input.evidenceSourceEventIds ?? [],
        source: input.source ?? null,
        quoteCheck: quoteResult
          ? {
              ok: quoteResult.ok,
              sources: quoteResult.sources ?? [],
              fetchedAt: quoteResult.fetchedAt,
              error: quoteResult.error,
            }
          : null,
      },
    };

  const writeProposalEvent = async (context?: WorkshopWriteContext) => {
    const event = await appendWatchlistProposalEvent(eventInput, context);
    if (event) {
      await upsertWorkshopReviewItemFromProposalEvent(event, context?.db);
    }
    return event;
  };

  const event = input.withWriteContext
    ? await input.withWriteContext((context) => writeProposalEvent(context))
    : await writeProposalEvent(input.writeContext);

  const payload: QuantPaperWatchlistChangeProposalPayload = {
    proposalId,
    status,
    before: beforeCodes,
    after: afterCodes,
    add: addItems,
    remove: removeItems,
    protectedRemove: protectedRemoveItems,
    validation,
    approvalRequired: false,
    eventId: event?.id ?? null,
    appliedConfig: null,
    applyError: null,
  };

  if (validation.ok && event?.id) {
    try {
      const applied = await resolveWatchlistProposal({
        workshopId: input.workshopId,
        eventId: event.id,
        action: "apply",
        note: "校验通过，按临时策略自动应用自选股调整。",
      });
      payload.appliedConfig = applied.config;
      payload.status = "applied";
      payload.approvalRequired = false;
    } catch (error) {
      payload.applyError = error instanceof Error ? error.message : String(error);
      await resolveWatchlistProposal({
        workshopId: input.workshopId,
        eventId: event.id,
        action: "reject",
        note: `自动应用失败：${payload.applyError}`,
      }).catch(() => undefined);
      payload.status = "apply_failed";
      payload.approvalRequired = false;
    }
  } else {
    payload.approvalRequired = false;
  }

  return payload;
}
