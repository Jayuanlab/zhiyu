import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/(auth)/auth";
import { getAuthMode, requestBoundary } from "@/lib/auth/request-boundary";

export async function proxy(request: NextRequest) {
  const mode = getAuthMode();
  const reason = requestBoundary(request, mode);
  if (reason) {
    const commandId = crypto.randomUUID();
    console.warn(JSON.stringify({ event: "request_denied", commandId, reasonCode: reason, policyVersion: "identity-v1", mode, path: request.nextUrl.pathname }));
    return NextResponse.json({ error: reason, commandId }, { status: 403 });
  }
  if (mode === "local_owner" || request.nextUrl.pathname.startsWith("/api/auth/")) return NextResponse.next();
  // NextAuth's Request overload returns middleware, not a Session.
  return auth((authenticatedRequest: NextRequest & { auth: { user?: { id?: string } } | null }) => {
    if (authenticatedRequest.auth?.user?.id) return NextResponse.next();
    if (request.nextUrl.pathname.startsWith("/api/")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.next(); // Public login UI; page loaders enforce their own session.
  })(request);
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",
    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
