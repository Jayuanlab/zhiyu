export type WorkshopEvent = {
  id: string;
  workshopId: string;
  runId: string | null;
  loopId?: string | null;
  loopRunId?: string | null;
  seq: number;
  type: string;
  title: string;
  body: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};
