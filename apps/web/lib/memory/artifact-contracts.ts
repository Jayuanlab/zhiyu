export type ArtifactRecordRef = { kind: "artifact"; id: string };
export type ArtifactVersionRef = { record: ArtifactRecordRef; revision: string };
export type ArtifactCurrentReadQuery = { purpose: "current"; ref: ArtifactRecordRef };
export type ArtifactEvidenceReadQuery = { purpose: "evidence"; ref: ArtifactVersionRef; range: { start: number; end: number } };
export type ArtifactCommand =
  | { kind: "artifact.begin"; commandId: string; name: string; contentType: string; sizeBytes: number; sha256: string }
  | { kind: "artifact.seal" | "artifact.cleanup"; commandId: string; artifactId: string; expectedRevision: number }
  | { kind: "artifact.activate"; commandId: string; artifactId: string; expectedRevision: number; saveRecord?: boolean; chatId?: string; messageId?: string };
export type ArtifactCommandResult = Awaited<ReturnType<typeof import("./artifacts/service").beginArtifact>>;
export type ArtifactReadResult = Awaited<ReturnType<typeof import("./artifacts/owner-query").readOwnerArtifact>>;
