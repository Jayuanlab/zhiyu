/**
 * Files API Routes
 *
 * Provides filesystem management interface
 */

import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { AppError } from "@openzhiyu/shared/errors";
import {
  createTaskSession,
  writeSessionFile,
} from "@/lib/files/workspace/sessions";
import { db } from "@/lib/db/client";
import { chat } from "@/lib/db/schema";
import { eq, and } from "drizzle-orm";
import { WorkspaceListingBoundaryError } from '@/lib/files/workspace/listing-boundary';
import { workspaceListing } from '@/lib/files/workspace/bounded-listing-service';
import { ListingCursorError } from '@/lib/files/workspace/bounded-listing';

// GET always uses a bounded owner-scoped scan. Legacy offset pages are rejected.
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) return new AppError("unauthorized:api", "Unauthorized").toResponse();
  try {
    const {searchParams} = new URL(req.url);
    const taskId = searchParams.get('taskId');
    const path = searchParams.get('path') || '';
    const mode = searchParams.get('pagination');
    if ((mode && mode !== 'bounded') || searchParams.has('page'))
      return NextResponse.json({error:'legacy_pagination_retired',detail:'Use nextCursor with cursor; offset pages are no longer supported.'},{status:400});
    if ((taskId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) || (!taskId && path))
      return NextResponse.json({error:'invalid_scope'},{status:400});
    return NextResponse.json(await workspaceListing.page(session.user.id,searchParams.get('cursor'),Number(searchParams.get('pageSize') ?? 50),taskId?{taskId,path}:undefined),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    if(error instanceof ListingCursorError)
      return NextResponse.json({error:error.code,resetRequired:[410,403,422].includes(error.status)},{status:error.status});
    if(error instanceof WorkspaceListingBoundaryError)
      return NextResponse.json({error:'Workspace path unavailable'},{status:403});
    return NextResponse.json({error:'Failed to list files'},{status:500});
  }
}

// POST /api/workspace/files - Write file
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return new AppError("unauthorized:api", "Unauthorized").toResponse();
  }

  try {
    const body = await req.json();
    const { taskId, path, content } = body;

    if (!taskId || !path) {
      return NextResponse.json(
        { error: "taskId and path are required" },
        { status: 400 },
      );
    }

    // Verify taskId belongs to current user
    const [chatRecord] = await db
      .select({ id: chat.id })
      .from(chat)
      .where(and(eq(chat.id, taskId), eq(chat.userId, session.user.id)))
      .limit(1);

    if (!chatRecord) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Ensure session directory exists
    createTaskSession(taskId);

    const success = writeSessionFile(taskId, path, content || "");

    if (success) {
      return NextResponse.json({
        success: true,
        message: "File written successfully",
      });
    }
    return NextResponse.json(
      { error: "Failed to write file" },
      { status: 500 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: "Failed to write file",
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
