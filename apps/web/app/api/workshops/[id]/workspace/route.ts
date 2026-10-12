import { auth } from "@/app/(auth)/auth";
import { getWorkshop, appendWorkshopEvent } from "@/lib/workshops/service";
import { listLoopsForWorkshop } from "@/lib/loops/service";
import { inspectWorkspace, prepareWorkspace } from "@/lib/workshops/workspace";
import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function handle(request: NextRequest, context: Context, prepare: boolean) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  if (prepare && request.headers.has("X-Work-Actor") && request.headers.get("X-Work-Actor") !== userId) {
    return NextResponse.json({ error: "actor_changed" }, { status: 409 });
  }
  const { id } = await context.params;
  // No caller-supplied directory, owner or Loop IDs are accepted.
  let authorized = false;
  try {
    const workshop = await getWorkshop(userId, id);
    if (!workshop) return NextResponse.json({ error: "Workshop not found" }, { status: 404 });
    authorized = true;
    const loops = await listLoopsForWorkshop({ userId, workshopId: id, limit: 200 });
    if (prepare) {
      const before = await Promise.all([
        inspectWorkspace({ userId, workshopId: id }),
        ...loops.map(loop => inspectWorkspace({ userId, workshopId: id, loopId: loop.id })),
      ]);
      const pending = before.filter(space => space.status !== "ready");
      if (pending.length) {
        await appendWorkshopEvent({ workshopId: id, type: "workspace_preparation_requested",
          title: "主人请求准备长期工作空间", metadata: { actorId: userId, loopIds: pending.flatMap(space => space.loopId ? [space.loopId] : []) } });
        await prepareWorkspace({ userId, workshopId: id });
        for (const loop of loops) await prepareWorkspace({ userId, workshopId: id, loopId: loop.id });
        await appendWorkshopEvent({ workshopId: id, type: "workspace_prepared",
          title: "车间与 Loop 长期空间已准备", metadata: { actorId: userId, loopIds: loops.map(loop => loop.id), stateAuthority: "database" } });
      }
    }
    const [space, loopSpaces] = await Promise.all([
      inspectWorkspace({ userId, workshopId: id }),
      Promise.all(loops.map(async loop => ({
        ...await inspectWorkspace({ userId, workshopId: id, loopId: loop.id }), name: loop.name,
      }))),
    ]);
    return NextResponse.json({ workspace: space, loops: loopSpaces, loopsTruncated: loops.length === 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (prepare && authorized) {
      try {
        await appendWorkshopEvent({ workshopId: id, type: "workspace_preparation_failed",
          title: "长期工作空间准备失败", body: message, metadata: { actorId: userId } });
      } catch (auditError) {
        console.error("[WorkshopWorkspaceAPI] Failure audit unavailable", auditError);
        return NextResponse.json({ error: message, warning: "Workspace failure audit could not be saved" }, { status: 500 });
      }
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest, context: Context) { return handle(request, context, false); }
export async function POST(request: NextRequest, context: Context) { return handle(request, context, true); }
