import { readBoundedJson } from "@/app/api/memory/_shared";
import { NextResponse, type NextRequest } from "next/server";
import { bindMemoryDependencies, getMemoryDependencies, MemoryDependencyError, parseMemoryDependencyEntity } from "@/lib/memory/revision/dependencies";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";
type RouteContext = { params: Promise<{ entityKind: string; entityId: string }> };
function respond(error: unknown) {
  return error instanceof MemoryDependencyError ? NextResponse.json({ error: error.message, code: error.code }, { status: error.status }) : errorResponse(error, "Failed to process memory dependencies");
}
export async function GET(_request: NextRequest, context: RouteContext) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = await context.params, target = parseMemoryDependencyEntity(params.entityKind, params.entityId);
    return NextResponse.json(await getMemoryDependencies({ requester: { type: "chat", userId: user.userId, id: "brain-dependency-api" }, ...target }));
  } catch (error) { return respond(error); }
}
export async function POST(request: NextRequest, context: RouteContext) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const params = await context.params, target = parseMemoryDependencyEntity(params.entityKind, params.entityId);
    return NextResponse.json(await bindMemoryDependencies({ requester: { type: "chat", userId: user.userId, id: "brain-dependency-api" }, ...target, request: await readBoundedJson(request) }));
  } catch (error) { return respond(error); }
}
