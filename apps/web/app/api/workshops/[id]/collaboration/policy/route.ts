import { auth } from "@/app/(auth)/auth";
import { NextResponse, type NextRequest } from "next/server";
import { getWorkshop } from "@/lib/workshops/service";
import { listCollaborationPeers } from "@/lib/workshops/collaboration";
import { getWorkCommandVersion, WorkCommandConflict } from "@/lib/work-runtime/command-ledger";
import { updateWork } from "@/lib/work-runtime";

export const dynamic = "force-dynamic";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown, maxItems: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > maxItems || value.some((part) => typeof part !== "string" || !part.trim() || part.length > maxLength)) return null;
  return [...new Set(value.map((part: string) => part.trim()))];
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const work = await getWorkshop(session.user.id, id);
  if (!work) return NextResponse.json({ error: "work_not_found" }, { status: 404 });
  return NextResponse.json({
    policy: record(record(work.modelConfig).collaboration),
    commandVersion: await getWorkCommandVersion(session.user.id, id),
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const offeredCapabilities = strings(body.offeredCapabilities, 20, 80);
    const acceptedKinds = strings(body.acceptedKinds, 3, 20);
    const allowedRecipients = strings(body.allowedRecipients, 50, 40);
    if (!offeredCapabilities || !acceptedKinds || !allowedRecipients
        || acceptedKinds.some((kind) => !["notice", "consult", "delegate"].includes(kind))
        || !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0
        || typeof body.commandId !== "string" || !/^[a-zA-Z0-9_.:-]{8,120}$/.test(body.commandId)) {
      return NextResponse.json({ error: "invalid_policy" }, { status: 400 });
    }
    const peers = await listCollaborationPeers(session.user.id, id);
    const peerIds = new Set(peers.map((peer: { id: string }) => peer.id));
    if (allowedRecipients.some((recipient) => !peerIds.has(recipient))) {
      return NextResponse.json({ error: "recipient_not_owned" }, { status: 403 });
    }
    const work = await getWorkshop(session.user.id, id);
    if (!work) return NextResponse.json({ error: "work_not_found" }, { status: 404 });
    const current = record(work.modelConfig);
    const previous = record(current.collaboration);
    const configuredTools = Array.isArray(current.allowedTools)
      ? current.allowedTools.filter((name): name is string => typeof name === "string") : [];
    const collaborationTools = [
      "workshopListColleagues", "workshopReadCollaborationInbox",
      ...(allowedRecipients.length ? ["workshopLogEvent", "workshopAskColleague", "workshopRespondCollaboration"] : []),
      ...(acceptedKinds.length ? ["workshopRespondCollaboration"] : []),
    ];
    const boundary = record(work.boundaryPolicy);
    const denied = new Set([
      ...(Array.isArray(current.disallowedTools) ? current.disallowedTools : []),
      ...(Array.isArray(boundary.hardDeniedActions) ? boundary.hardDeniedActions : []),
    ].filter((name): name is string => typeof name === "string")
      .map((name) => (name.split("__").pop() ?? name).toLowerCase()));
    const result = await updateWork({
      userId: session.user.id, workId: id, source: "owner",
      reason: "Owner updated internal collaboration policy.",
      commandId: body.commandId, expectedVersion: body.expectedVersion,
      patch: { modelConfig: {
        ...current,
        ...(configuredTools.length ? { allowedTools: [...new Set([...configuredTools, ...collaborationTools.filter((name) => !denied.has(name.toLowerCase()))])] } : {}),
        collaboration: { ...previous, offeredCapabilities, acceptedKinds, allowedRecipients },
      } },
    });
    return NextResponse.json({
      policy: record(record(result.workshop.modelConfig).collaboration),
      commandVersion: await getWorkCommandVersion(session.user.id, id),
    });
  } catch (error) {
    if (error instanceof WorkCommandConflict) return NextResponse.json({ error: error.code }, { status: error.status });
    console.error("[CollaborationPolicyAPI]", error);
    return NextResponse.json({ error: "policy_update_failed" }, { status: 500 });
  }
}
