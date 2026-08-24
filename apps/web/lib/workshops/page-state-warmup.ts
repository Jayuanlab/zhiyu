import "server-only";

const warmups = new Set<string>();

function warmupKey(userId: string, workshopId: string) {
  return `${userId}:${workshopId}`;
}

function warmupDelayMs() {
  const configured = Number(process.env.WORKSHOP_PAGE_STATE_WARMUP_DELAY_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 500;
}

export function scheduleWorkshopDashboardWarmup(input: {
  userId: string;
  workshopId: string;
  run: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  delayMs?: number;
}): boolean {
  const key = warmupKey(input.userId, input.workshopId);
  if (warmups.has(key)) return false;

  warmups.add(key);
  setTimeout(() => {
    Promise.resolve()
      .then(input.run)
      .catch((error) => {
        input.onError?.(error);
      })
      .finally(() => {
        warmups.delete(key);
      });
  }, input.delayMs ?? warmupDelayMs());

  return true;
}

export function clearWorkshopDashboardWarmups() {
  warmups.clear();
}
