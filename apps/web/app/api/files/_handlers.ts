import { auth } from "@/app/(auth)/auth";
import { readBoundedJson } from "@/app/api/memory/_shared";
import { cleanupArtifactReference, readArtifact, readArtifactCurrent, resumeUploadedArtifact, saveArtifactRecord, saveUploadedArtifact } from "@/lib/memory/artifacts/service";
import { artifactHttpError, artifactHttpRange, artifactIdFromReference, artifactMultipart, exactArtifactReference, requireArtifactSameOrigin } from "@/lib/memory/artifacts/http";
import { getUserStorageUsage } from "@/lib/db/storageService";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";
import { ensureExtension, getExtensionFromContentType } from "@/lib/files/utils";
type Params = { params: Promise<{ id: string }> };
const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MemoryModuleError("invalid_memory_request", 400, "An object request is required");
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new MemoryModuleError("invalid_memory_request", 400, "Unexpected file request field");
}
export async function upload(request: Request) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  try {
    requireArtifactSameOrigin(request); const form = await artifactMultipart(request);
    if ([...form.keys()].some(key => !["file", "commandId", "createRecord", "artifactId", "expectedRevision"].includes(key)) || form.getAll("file").length !== 1)
      throw new MemoryModuleError("invalid_memory_request", 400, "Exactly one file and explicit upload metadata are required");
    if (["commandId", "createRecord", "artifactId", "expectedRevision"].some(key => form.getAll(key).length > 1)) throw new MemoryModuleError("invalid_memory_request", 400, "Upload metadata must have one unambiguous value");
    const file = form.get("file"), commandId = form.get("commandId") ?? request.headers.get("idempotency-key");
    if (!(file instanceof Blob) || typeof commandId !== "string" || !commandId.trim()) throw new MemoryModuleError("invalid_memory_request", 400, "A file and stable command ID are required");
    if (request.headers.has("idempotency-key") && form.has("commandId") && request.headers.get("idempotency-key") !== commandId) throw new MemoryModuleError("invalid_memory_request", 400, "Conflicting upload command IDs");
    const createRecord = form.get("createRecord"), saveRecord = ["true", "1", "on"].includes(String(createRecord));
    if (createRecord !== null && !["true", "1", "on", "false", "0", "off"].includes(String(createRecord))) throw new MemoryModuleError("invalid_memory_request", 400, "Invalid saved-file intent");
    const originalName = "name" in file && typeof file.name === "string" ? file.name : "upload", contentType = file.type.toLowerCase();
    const name = ensureExtension(originalName.normalize("NFC").replace(/[\u0000-\u001f\u007f/\\]/g, "-").trim().slice(0, 180) || "upload", getExtensionFromContentType(contentType));
    const artifactId = form.get("artifactId"), expectedRevision = form.get("expectedRevision"), data = new Uint8Array(await file.arrayBuffer());
    if (artifactId !== null && (typeof artifactId !== "string" || expectedRevision === null || typeof expectedRevision !== "string" || !/^\d+$/.test(expectedRevision)))
      throw new MemoryModuleError("invalid_memory_request", 400, "An exact existing manifest revision is required to resume an upload");
    if (artifactId === null && expectedRevision !== null) throw new MemoryModuleError("invalid_memory_request", 400, "A manifest ID is required with a resume revision");
    const saved = typeof artifactId === "string" ? await resumeUploadedArtifact(session.user.id, { commandId, artifactId, expectedRevision: Number(expectedRevision), data, saveRecord })
      : await saveUploadedArtifact(session.user.id, { commandId, name, contentType, data, saveRecord });
    const manifest = saved.manifest, url = manifest.url;
    return Response.json({ url, pathname: `artifact:${manifest.id}`, downloadUrl: url, blobPath: `artifact:${manifest.id}`,
      name: originalName, sanitizedName: manifest.name, contentType: manifest.contentType, size: manifest.sizeBytes,
      artifact: manifest, ref: saved.ref, receipt: saved.receipt, replayed: saved.replayed, creditsDeducted: 0,
      savedFile: manifest.userFileId ? { id: manifest.userFileId, name: manifest.name, contentType: manifest.contentType, sizeBytes: manifest.sizeBytes,
        savedAt: manifest.updatedAt, url, blobPathname: `artifact:${manifest.id}`, chatId: null, messageId: null, storageProvider: manifest.provider } : undefined,
      usage: await getUserStorageUsage(session.user.id, session.user.type), indexStatus: "not_requested" });
  } catch (error) { return artifactHttpError(error); }
}
export async function get(request: Request, { params }: Params) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  try {
    const { id } = await params, current = await readArtifactCurrent(session.user.id, { artifactId: id });
    if (current.status !== "ok") return Response.json({ error: "File unavailable" }, { status: 404 });
    const range = artifactHttpRange(request.headers.get("range"), current.record.sizeBytes), revision = new URL(request.url).searchParams.get("revision") ?? undefined;
    const read = await readArtifact(session.user.id, { artifactId: id, ...(revision ? { revision } : {}), ...(range ? { range } : {}) });
    if (read.status === "not_found") return Response.json({ error: "File unavailable" }, { status: 404 });
    if (read.status !== "ok") return Response.json({ error: "File is not available at the requested active version", code: read.code }, { status: 409 });
    const headers = new Headers({ "Content-Type": read.manifest.contentType, "Content-Length": String(read.bytes.byteLength),
      "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(read.manifest.name.replace(/[\r\n]/g, "")).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "Cache-Control": "private, no-store, no-transform", Pragma: "no-cache", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "sandbox",
      "Accept-Ranges": "bytes", "X-Memory-Read-Receipt": read.receipt.id, "X-Memory-Revision": read.ref.revision, ETag: `"${read.ref.revision}"` });
    if (range) headers.set("Content-Range", `bytes ${read.receipt.actualRange.start}-${read.receipt.actualRange.end - 1}/${read.receipt.totalLength}`);
    return new Response(new Uint8Array(read.bytes), { status: range ? 206 : 200, headers });
  } catch (error) { return artifactHttpError(error); }
}
export async function head(_request: Request, { params }: Params) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  try {
    const current = await readArtifactCurrent(session.user.id, { artifactId: (await params).id });
    if (current.status !== "ok") return new Response(null, { status: 404 });
    if (current.record.state !== "active") return new Response(null, { status: 409 });
    return new Response(null, { headers: { "Content-Type": current.record.contentType, "Content-Length": String(current.record.sizeBytes),
      "Cache-Control": "private, no-store", "X-Memory-Read-Receipt": current.receipt.id, "X-Memory-Revision": current.ref.revision } });
  } catch (error) { return artifactHttpError(error); }
}
export async function remove(request: Request, { params }: Params) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  try {
    requireArtifactSameOrigin(request); const id = (await params).id, body = object(request.body ? await readBoundedJson(request) : {});
    fields(body, ["commandId", "expectedRevision"]);
    if (body.commandId !== undefined && typeof body.commandId !== "string" || body.expectedRevision !== undefined && typeof body.expectedRevision !== "number")
      throw new MemoryModuleError("invalid_memory_request", 400, "Invalid file deletion command");
    const deleted = await cleanupArtifactReference(session.user.id, { artifactId: id, commandId: typeof body.commandId === "string" ? body.commandId : `file-delete:${id}`,
      expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined });
    return Response.json({ success: true, artifact: deleted.manifest, ref: deleted.ref, receipt: deleted.receipt, replayed: deleted.replayed,
      usage: await getUserStorageUsage(session.user.id, session.user.type) });
  } catch (error) { return artifactHttpError(error); }
}
export async function save(request: Request) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  try {
    requireArtifactSameOrigin(request); const body = object(await readBoundedJson(request));
    fields(body, ["artifactId", "commandId", "expectedRevision", "attachment", "chatId", "messageId", "storageProvider"]);
    if (["commandId", "chatId", "messageId", "storageProvider"].some(key => body[key] !== undefined && typeof body[key] !== "string") || body.expectedRevision !== undefined && typeof body.expectedRevision !== "number") throw new MemoryModuleError("invalid_memory_request", 400, "Invalid file save metadata");
    if (body.storageProvider && !["private_local", "private_blob"].includes(String(body.storageProvider))) throw new MemoryModuleError("artifact_legacy_uncontrolled", 410, "Legacy public objects and remote exports need an explicit import; no URL is fetched");
    const attachment = body.attachment ? object(body.attachment) : {};
    const artifactId = exactArtifactReference([body.artifactId, attachment.blobPath, attachment.url]);
    const saved = await saveArtifactRecord(session.user.id, { artifactId, commandId: typeof body.commandId === "string" ? body.commandId : `file-save:${artifactId}`,
      expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
      chatId: typeof body.chatId === "string" ? body.chatId : undefined, messageId: typeof body.messageId === "string" ? body.messageId : undefined });
    const manifest = saved.manifest;
    return Response.json({ file: { id: manifest.userFileId, name: manifest.name, contentType: manifest.contentType, sizeBytes: manifest.sizeBytes,
      savedAt: manifest.updatedAt, url: manifest.url, blobPathname: `artifact:${manifest.id}`, storageProvider: manifest.provider, chatId: body.chatId ?? null, messageId: body.messageId ?? null },
      artifact: manifest, ref: saved.ref, receipt: saved.receipt, replayed: saved.replayed, storageProvider: manifest.provider,
      usage: await getUserStorageUsage(session.user.id, session.user.type), creditsDeducted: 0, indexStatus: "not_requested" }, { status: 201 });
  } catch (error) { return artifactHttpError(error); }
}
export async function download(request: Request) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  try {
    const body = object(await readBoundedJson(request)); fields(body, ["fileId", "artifactId", "blobPath", "url", "chatId", "messageId"]);
    const id = exactArtifactReference([body.artifactId, body.fileId, body.blobPath, body.url]);
    const current = await readArtifactCurrent(session.user.id, { artifactId: id });
    if (current.status !== "ok") return Response.json({ error: "File unavailable" }, { status: 404 });
    if (current.record.state !== "active") return Response.json({ error: "File is not active", code: "artifact_not_active" }, { status: 409 });
    return Response.json({ downloadUrl: `/api/files/${id}`, ref: current.ref, receipt: current.receipt, access: "authenticated_owner_proxy" });
  } catch (error) { return artifactHttpError(error); }
}
export async function proxyDownload(request: Request) {
  const session = await auth(); if (!session?.user?.id) return unauthorized();
  const id = artifactIdFromReference(new URL(request.url).searchParams.get("path"));
  if (!id) return Response.json({ error: "Legacy paths have no controlled private manifest", code: "artifact_legacy_uncontrolled" }, { status: 410 });
  return get(request, { params: Promise.resolve({ id }) });
}
