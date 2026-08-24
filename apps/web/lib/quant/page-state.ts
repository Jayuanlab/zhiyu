import type { QuantPageState } from "./types";

function uniqueWarnings(warnings: string[]) {
  return Array.from(new Set(warnings.filter(Boolean)));
}

export function mergeQuantPageStateWithPrevious(input: {
  current: QuantPageState;
  previous: QuantPageState | null;
}): QuantPageState {
  const { current, previous } = input;
  if (!previous) return current;

  const usePreviousAccount = current.account === null && previous.account !== null;
  const usePreviousDashboard =
    current.dashboard === null && previous.dashboard !== null;

  if (!usePreviousAccount && !usePreviousDashboard) return current;

  const warnings = [...current.meta.warnings];
  if (usePreviousAccount) {
    warnings.push(
      "quant account refresh did not finish; using previous account snapshot",
    );
  }
  if (usePreviousDashboard) {
    warnings.push(
      "quant dashboard refresh did not finish; using previous dashboard snapshot",
    );
  }

  return {
    ...current,
    account: usePreviousAccount ? previous.account : current.account,
    dashboard: usePreviousDashboard ? previous.dashboard : current.dashboard,
    meta: {
      ...current.meta,
      account: usePreviousAccount
        ? {
            ...current.meta.account,
            ok: true,
            stale: true,
            refreshing: current.meta.account.refreshing ?? true,
          }
        : current.meta.account,
      dashboard: usePreviousDashboard
        ? {
            ...current.meta.dashboard,
            ok: true,
            stale: true,
            refreshing: current.meta.dashboard.refreshing ?? true,
          }
        : current.meta.dashboard,
      warnings: uniqueWarnings(warnings),
    },
  };
}
