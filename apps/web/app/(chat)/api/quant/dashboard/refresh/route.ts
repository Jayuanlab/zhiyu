import { auth } from "@/app/(auth)/auth";
import { refreshQuantFullMarket } from "@/lib/quant/client";
import { invalidateQuantReadCache } from "@/lib/quant/cache";
import { NextResponse } from "next/server";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    invalidateQuantReadCache(["quant:dashboard"]);
    return NextResponse.json(await refreshQuantFullMarket());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Quant full-market refresh unavailable";
    return NextResponse.json(
      {
        error: message,
        hint: "Check the embedded quant Python environment and worker diagnostics.",
      },
      { status: 503 },
    );
  }
}
