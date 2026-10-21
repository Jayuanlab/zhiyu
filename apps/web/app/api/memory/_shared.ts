import { auth } from "@/app/(auth)/auth";
import { NextResponse } from "next/server";
import { createOwnerMemoryClient } from "@/lib/memory";
import { MemoryModuleError } from "@/lib/memory/kernel/errors";

/** Apply the transport budget before buffering/parsing JSON, including chunked bodies. */
export async function readBoundedJson(request: Request): Promise<unknown> {
  const limit = 1024 * 1024;
  const claimed = request.headers.get("content-length");
  if (claimed && Number(claimed) > limit) throw new MemoryModuleError("memory_request_too_large", 413, "Memory request exceeds the transport budget");
  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("JSON body is required");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel().catch(() => undefined);
        throw new MemoryModuleError("memory_request_too_large", 413, "Memory request exceeds the transport budget");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let decoded: string;
  try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new MemoryModuleError("invalid_memory_request", 400, "JSON must contain valid UTF-8"); }
  return JSON.parse(decoded);
}

export async function ownerMemoryRequest(request: Request, execute: (client: ReturnType<typeof createOwnerMemoryClient>, body: unknown) => Promise<unknown>) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await readBoundedJson(request);
    const result = await execute(createOwnerMemoryClient(session.user.id), body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof MemoryModuleError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Invalid JSON", code: "invalid_memory_request" }, { status: 400 });
    // Do not expose SQL, request bodies, private content or connection details.
    return NextResponse.json({ error: "Memory request could not be completed", code: "memory_request_failed" }, { status: 503 });
  }
}
