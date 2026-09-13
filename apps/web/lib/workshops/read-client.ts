export type WorkshopReadState = {
  url: string;
  status: 'loading' | 'ready' | 'refreshing' | 'degraded' | 'error';
  lastSuccess: number | null;
  error: string | null;
};
export const emptyWorkshopReads: readonly WorkshopReadState[] = [];

/** Component-scoped GET coordination. Data ownership stays with each projection. */
export function createWorkshopReadClient(fetchJson: <T>(url: string) => Promise<T>, now = Date.now) {
  const inFlight = new Map<string, Promise<unknown>>();
  const states = new Map<string, WorkshopReadState>();
  const listeners = new Set<() => void>();
  let snapshot = emptyWorkshopReads;
  function publish(state: WorkshopReadState) {
    states.set(state.url, state);
    snapshot = [...states.values()];
    listeners.forEach(listener => listener());
  }
  function read<T>(url: string): Promise<T> {
    const current = inFlight.get(url);
    if (current) return current as Promise<T>;
    const previous = states.get(url);
    const lastSuccess = previous?.lastSuccess ?? null;
    const request = Promise.resolve().then(() => fetchJson<T>(url)).then(value => {
      publish({url, status: 'ready', lastSuccess: now(), error: null});
      return value;
    }, error => {
      publish({url, status: lastSuccess === null ? 'error' : 'degraded', lastSuccess,
        error: error instanceof Error ? error.message : String(error)});
      throw error;
    }).finally(() => {if (inFlight.get(url) === request) inFlight.delete(url);});
    inFlight.set(url, request);
    publish({url, status: lastSuccess === null ? 'loading' : 'refreshing', lastSuccess, error: previous?.error ?? null});
    return request;
  }
  return {read, getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {listeners.add(listener); return () => {listeners.delete(listener);};}};
}
