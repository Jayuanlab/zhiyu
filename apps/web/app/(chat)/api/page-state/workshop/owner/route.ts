import { auth } from "@/app/(auth)/auth";
import { getOwnerWorkOverview } from "@/lib/workshops/owner-overview";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({error: "Unauthorized"}, {status: 401});
  try {
    const overview = await getOwnerWorkOverview(session.user.id);
    return NextResponse.json(overview, {headers: {"Cache-Control": "no-store"}});
  } catch (error) {
    console.error("[OwnerWorkOverview] GET error:", error);
    return NextResponse.json({error: "Owner work overview unavailable"}, {status: 503});
  }
}
