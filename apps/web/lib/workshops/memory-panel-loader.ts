export type WorkshopMemoryQualityState<TReport> = {
  workshopId: string;
  status: 'loading' | 'ready' | 'error';
  report: TReport | null;
  error: string | null;
};

/** Quality diagnostics are optional; the memory list owns its own completion and failure. */
export function loadWorkshopMemoryPanel<TMemory, TReport>(input: {
  workshopId: string;
  read: <T>(url: string) => Promise<T>;
  isCurrent: () => boolean;
  onQuality: (state: WorkshopMemoryQualityState<TReport>) => void;
}): Promise<{ memories: TMemory[] }> {
  const publishQuality = (state: Omit<WorkshopMemoryQualityState<TReport>, 'workshopId'>) => {
    if (input.isCurrent()) input.onQuality({ workshopId: input.workshopId, ...state });
  };
  publishQuality({ status: 'loading', report: null, error: null });
  const memories = input.read<{ memories: TMemory[] }>(`/api/workshops/${input.workshopId}/memories`);
  void input.read<TReport>(`/api/workshops/${input.workshopId}/memory-recall-quality?days=7`).then(
    report => publishQuality({ status: 'ready', report, error: null }),
    error => publishQuality({ status: 'error', report: null,
      error: error instanceof Error ? error.message : String(error) }),
  );
  return memories;
}
