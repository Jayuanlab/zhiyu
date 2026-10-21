import { NextResponse, type NextRequest } from "next/server";
import { deleteBrainAccessGrant as revokeBrainAccess } from "@/lib/memory/governance/access-grants";
import { errorResponse, requireMemoryUser } from "@/app/api/memory/owner-route-helpers";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireMemoryUser();
  if (user.error) return user.error;
  try {
    const { id } = await params;
    const result = await revokeBrainAccess({
      userId: user.userId,
      grantId: id,
    });
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error, "Failed to revoke Brain grant");
  }
}
