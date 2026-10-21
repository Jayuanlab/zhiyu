export type EvidenceSourceRow = Record<string, unknown>;
export type ObservationEvidenceRow = {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceEventId?: unknown;
  content: string;
  observedAt: unknown;
  contentHash: string;
  trustLevel?: unknown;
  metadata?: unknown;
};

/** Internal exact lookups. This port does not authorize broader discovery. */
export interface EvidenceSourceReader {
  readObservations(input: { userId: string; ids: string[] }): Promise<ObservationEvidenceRow[]>;
  readInteractionEvents(input: { userId: string; ids: string[] }): Promise<EvidenceSourceRow[]>;
  readRawMessages(input: { userId: string; numericIds: number[]; messageIds: string[] }): Promise<EvidenceSourceRow[]>;
  readWorkshopEvents(input: { userId: string; workshopId: string; ids: string[] }): Promise<EvidenceSourceRow[]>;
}
