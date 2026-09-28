/**
 * Password API Route
 *
 * Handles user password input for sudo commands from the native agent
 * Re-executes the command with the password via stdin
 */

import type { NextRequest } from "next/server";
import { auth } from "@/app/(auth)/auth";

import { takePasswordRequest, transformSudoCommand } from "@/lib/ai/native-password-state";

// Execute a command with password via stdin
async function executeCommandWithPassword(
  command: string,
  password: string,
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { spawn } = require("node:child_process");
  return new Promise((resolve) => {
    const child = spawn(command, [], {
      shell: true,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code: number | null) => {
      resolve({ stdout, stderr, exitCode: code ?? 0 });
    });

    // Write password after brief delay to ensure prompt is ready
    setTimeout(() => {
      child.stdin?.write(`${password}\n`);
      child.stdin?.end();
    }, 100);
  });
}

// POST /api/native/agent/password - Submit password for sudo command
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      toolUseID: string;
      password: string;
      originalCommand: string;
      cwd?: string;
    };

    console.log(
      "[PasswordAPI] Password submitted for toolUseID:",
      body.toolUseID,
    );

    // Validate required fields
    if (!body.toolUseID) {
      return Response.json(
        { error: "toolUseID is required" },
        { status: 400 },
      );
    }

    const responseHandler = takePasswordRequest(body.toolUseID, session.user.id);
    if (!responseHandler) return Response.json({ error: "Unknown or expired password request" }, { status: 404 });

    // User cancelled - resolve with null to let command fail gracefully
    if (!body.password) {
      responseHandler.resolve?.(null);
      return Response.json({ success: true, cancelled: true });
    }

    // Transform sudo command to use -S flag for stdin
    const transformedCmd = transformSudoCommand(responseHandler.command);

    // Execute with password via stdin
    const result = await executeCommandWithPassword(
      transformedCmd,
      body.password,
      responseHandler.cwd,
    );

    // Resolve pending request with result
    {
      responseHandler.resolve?.({
        password: body.password,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      });
    }

    return Response.json({ success: true, result });
  } catch (error) {
    console.error("[PasswordAPI] Password submission error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500 },
    );
  }
}
