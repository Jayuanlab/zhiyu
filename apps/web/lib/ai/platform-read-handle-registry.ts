import { randomBytes } from "node:crypto";

export type PlatformReadIdentity = {
  ownerId: string;
  requester: { kind: "chat" | "work" | "loop" | "tool"; id: string };
  turnId: string;
};
export type PlatformFieldReadBinding = PlatformReadIdentity & {
  source: string; id: string; fieldKey: string; contentHash: string;
};
export type PlatformFieldPageStartRead = { fieldPage: { readHandle: string } };
export type PlatformReadHandle = { readHandle: string; source: string; id: string; fieldKey: string; nextRead?: PlatformFieldPageStartRead };
/** Finite source/field pairs share the existing owner/turn/version pager. */
export function platformSupportsFieldPages(source: string, fieldKey: string) {
  return source === "loopRuns" && ["outputSummary", "verificationResult"].includes(fieldKey)
    || source === "workshopRuns" && fieldKey === "outputSummary";
}
/** A host-issued next action describes the existing pager scope; it grants no access or completion. */
export function platformFieldPageStartRead(binding: Pick<PlatformFieldReadBinding, "source" | "fieldKey" | "requester">, readHandle: string): PlatformFieldPageStartRead | undefined {
  return binding.requester.kind === "chat" && platformSupportsFieldPages(binding.source, binding.fieldKey)
    ? { fieldPage: { readHandle } } : undefined;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const sourceNames: Record<string, string> = {
  loopruns: "loopRuns", workshopruns: "workshopRuns", loops: "loops", chat: "chat", message: "message", messagev2: "message", chatmessages: "message",
};
const fields: Record<string, readonly string[]> = {
  // Stored run timestamp fields use the same owner/turn/version-bound whole-field reader.
  // This grants no temporal semantics, default read or P3 continuation.
  loopRuns: ["outputSummary", "verificationResult", "triggerReason", "startedAt", "completedAt"],
  workshopRuns: ["outputSummary"],
  loops: ["name", "goal", "triggerConfig"],
  chat: ["title"], message: ["textParts"],
};
export function platformWholeFieldKeys(source: string): readonly string[] {
  return fields[sourceNames[source.replaceAll("_", "").toLowerCase()]] ?? [];
}
export function platformWholeFieldSource(source: string) {
  return sourceNames[source.replaceAll("_", "").toLowerCase()];
}
function identityKey(identity: PlatformReadIdentity) {
  if (!identity || typeof identity.ownerId !== "string" || !identity.ownerId.trim()
    || typeof identity.turnId !== "string" || !identity.turnId.trim()
    || !identity.requester || !["chat", "work", "loop", "tool"].includes(identity.requester.kind)
    || typeof identity.requester.id !== "string" || !identity.requester.id.trim()) throw Error("Invalid platform read handle identity");
  return JSON.stringify([identity.ownerId, identity.requester.kind, identity.requester.id, identity.turnId]);
}

/** Opaque per-turn references are lookup aids, never authority to read a record. */
export class PlatformReadHandleRegistry {
  private readonly identity: PlatformReadIdentity;
  private readonly identityKey: string;
  private readonly handles = new Map<string, { binding: PlatformFieldReadBinding; expiresAt: number }>();
  private readonly keys = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private closed = false;

  constructor(identity: PlatformReadIdentity, options: { now?: () => number; ttlMs?: number } = {}) {
    this.identityKey = identityKey(identity);
    this.identity = { ...identity, requester: { ...identity.requester } };
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 15 * 60 * 1000) throw Error("Invalid platform read handle lifetime");
  }
  register(input: { source: string; id: string; fieldKey: string; contentHash: string }): PlatformReadHandle {
    if (this.closed) throw Error("Platform read handle registry is closed");
    if (!platformWholeFieldKeys(input.source).includes(input.fieldKey) || !uuid.test(input.id) || !hash.test(input.contentHash)) throw Error("Unsupported platform field handle");
    const key = JSON.stringify([input.source, input.id, input.fieldKey, input.contentHash]);
    let handle = this.keys.get(key);
    const now = this.now();
    if (!Number.isFinite(now)) throw Error("Invalid platform read handle clock");
    if (handle && this.handles.get(handle)!.expiresAt <= now) { this.handles.delete(handle); this.keys.delete(key); handle = undefined; }
    if (!handle) {
      if (this.handles.size >= 64) throw Error("Platform read handle capacity reached");
      handle = `pfr_${randomBytes(24).toString("base64url")}`;
      this.handles.set(handle, { binding: { ...this.identity, requester: { ...this.identity.requester }, ...input }, expiresAt: now + this.ttlMs });
      this.keys.set(key, handle);
    }
    const nextRead = platformFieldPageStartRead({ ...input, requester: this.identity.requester }, handle);
    return { readHandle: handle, source: input.source, id: input.id, fieldKey: input.fieldKey, ...(nextRead ? { nextRead } : {}) };
  }
  resolve(handle: string, identity: PlatformReadIdentity): PlatformFieldReadBinding {
    if (this.closed || identityKey(identity) !== this.identityKey || typeof handle !== "string") throw Error("Invalid platform read handle scope");
    const entry = this.handles.get(handle);
    const now = this.now();
    if (!entry || !Number.isFinite(now) || entry.expiresAt <= now) throw Error("Unknown or expired platform read handle");
    return { ...entry.binding, requester: { ...entry.binding.requester } };
  }
  assertIdentity(identity: PlatformReadIdentity) {
    if (this.closed || identityKey(identity) !== this.identityKey) throw Error("Invalid platform read handle scope");
  }
  close() { this.closed = true; this.handles.clear(); this.keys.clear(); }
}

/** Validate the raw request before normalization can hide an illegal mixed branch. */
export function validatePlatformReadHandleRequest(params: Record<string, unknown>) {
  if (Object.hasOwn(params, "fieldPage")) {
    const value = params.fieldPage;
    if (Object.keys(params).length !== 1 || !value || typeof value !== "object" || Array.isArray(value)) throw Error("invalid_field_page_request");
    const page = value as Record<string, unknown>;
    if (typeof page.readHandle !== "string" || !/^pfr_[A-Za-z0-9_-]{32}$/.test(page.readHandle)
      || Object.keys(page).some(key => !["readHandle", "cursor"].includes(key))
      || page.cursor !== undefined && (typeof page.cursor !== "string" || !/^pfp_[A-Za-z0-9_-]{32}$/.test(page.cursor))) throw Error("invalid_field_page_request");
    return;
  }
  if (!Object.hasOwn(params, "readHandle")) return;
  if (typeof params.readHandle !== "string" || !/^pfr_[A-Za-z0-9_-]{32}$/.test(params.readHandle)
    || Object.keys(params).some(key => key !== "readHandle")) throw Error("readHandle must be the only platform read parameter");
}
