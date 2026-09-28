import { auth } from "@/app/(auth)/auth";
import { fetchQuantFullMarketStatus } from "@/lib/quant/client";
import { NextResponse } from "next/server";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json(await fetchQuantFullMarketStatus());
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Quant full-market status unavailable";
    return NextResponse.json(
      {
        error: message,
        hint: "Check the embedded quant Python environment and worker diagnostics.",
      },
      { status: 503 },
    );
  }
}
