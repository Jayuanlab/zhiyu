import {
  fetchDouyinPublisherHealth,
  getDouyinLoginPlan,
} from "@/lib/douyin/client";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const plan = await getDouyinLoginPlan();
    return NextResponse.json(plan);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to create Douyin login plan.";
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      execute?: boolean;
    };
    if (!body.execute) {
      const plan = await getDouyinLoginPlan();
      return NextResponse.json(plan);
    }

    const health = await fetchDouyinPublisherHealth();
    if (!health.publisher_cli_available) {
      return NextResponse.json(
        {
          ok: false,
          platform: "douyin",
          action: "login",
          started: false,
          error:
            health.message ||
            "Douyin publisher CLI is not available, so the login QR code cannot be opened.",
          install_hint: health.install_hint,
          health,
        },
        { status: 503 },
      );
    }

    const { spawn } = await import("node:child_process");
    const { dirname, join } = await import("node:path");
    const { existsSync } = await import("node:fs");

    function publisherPath() {
      let current = process.cwd();
      for (let index = 0; index < 6; index += 1) {
        const candidate = join(
          current,
          "tools",
          "douyin-publisher",
          "publisher.py",
        );
        if (existsSync(candidate)) return candidate;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      return join(process.cwd(), "tools", "douyin-publisher", "publisher.py");
    }

    const script = publisherPath();
    const child = spawn(
      process.env.DOUYIN_PUBLISHER_PYTHON_BIN || process.env.PYTHON || "python",
      [script, "login", "--execute"],
      {
        cwd: dirname(script),
        env: {
          ...process.env,
          PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
          PYTHONUTF8: process.env.PYTHONUTF8 || "1",
        },
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
    return NextResponse.json({
      ok: true,
      platform: "douyin",
      action: "login",
      started: true,
      message:
        "Douyin login command started. Scan the QR code in the browser or generated image if the uploader opens one.",
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start Douyin login.";
    return NextResponse.json({ ok: false, error: message }, { status: 503 });
  }
}
