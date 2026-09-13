import { NextResponse } from "next/server";
import { getAuthMode } from "@/lib/auth/request-boundary";

/** Compatibility URL for local clients; never creates an implicit login identity. */
function localOwnerRedirect(request: Request) {
  if (getAuthMode() !== "local_owner") {
    return NextResponse.json({ error: "Guest login is disabled in authenticated mode" }, { status: 403 });
  }
  return NextResponse.redirect(new URL("/", request.url));
}

export const GET = localOwnerRedirect;
export const POST = localOwnerRedirect;
