import { existsSync, statSync } from "node:fs";
import { auth } from "@/app/(auth)/auth";
import { getDb, initDb, isDbInitialized } from "@/lib/db/adapters";
import {
  interactionEvents,
  interactionMemories,
  loops,
  ragDocuments,
  userFiles,
  workshopEvents,
  workshops,
} from "@/lib/db/schema";
import {
  TAURI_DATA_DIR,
  TAURI_DB_PATH,
  TAURI_LOGS_PATH,
  TAURI_STORAGE_PATH,
  getDatabaseUrl,
  isTauriMode,
} from "@/lib/env";
import {
  fetchQuantStorageDiagnostics,
  getQuantServiceUrl,
} from "@/lib/quant/client";
import { getEmbeddedQuantStatus, useQuantHttpTransport } from "@/lib/quant/embedded-transport";
import { count } from "drizzle-orm";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function fileInfo(path: string) {
  if (!path || !existsSync(path)) {
    return { path, exists: false };
  }
  const stat = statSync(path);
  return {
    path,
    exists: true,
    isDirectory: stat.isDirectory(),
    sizeBytes: stat.isFile() ? stat.size : null,
    modifiedAt: stat.mtime.toISOString(),
  };
}

function maskDatabaseUrl(value: string) {
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value;
  }
}

async function countTable(key: string, label: string, table: unknown) {
  try {
    const db = isDbInitialized() ? getDb() : initDb();
    const rows = await (db as any).select({ value: count() }).from(table);
    return {
      key,
      label,
      count: Number(rows?.[0]?.value ?? 0),
    };
  } catch (error) {
    return {
      key,
      label,
      count: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getCoreTableCounts() {
  return Promise.all([
    countTable("workshops", "智能体车间", workshops),
    countTable("workshop_events", "车间工作记录", workshopEvents),
    countTable("loops", "自动任务", loops),
    countTable("interaction_events", "主人知识库原始证据", interactionEvents),
    countTable("interaction_memories", "主人知识库记忆候选", interactionMemories),
    countTable("rag_documents", "RAG 文档", ragDocuments),
    countTable("user_files", "用户文件", userFiles),
  ]);
}

async function getExternalStoreDiagnostics() {
  try {
    return {
      quant: {
        available: true,
        ...(useQuantHttpTransport() ? { url: getQuantServiceUrl() } : { runtime: getEmbeddedQuantStatus() }),
        diagnostics: await fetchQuantStorageDiagnostics(),
      },
    };
  } catch (error) {
    return {
      quant: {
        available: false,
        ...(useQuantHttpTransport() ? { url: getQuantServiceUrl() } : { runtime: getEmbeddedQuantStatus() }),
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tauri = isTauriMode();
  return NextResponse.json({
    mode: tauri ? "tauri_sqlite" : "server_postgres",
    isTauriMode: tauri,
    env: {
      IS_TAURI: process.env.IS_TAURI ?? null,
      TAURI_MODE: process.env.TAURI_MODE ?? null,
      TAURI_DB_PATH_SET: Boolean(process.env.TAURI_DB_PATH),
      TAURI_DATA_DIR_SET: Boolean(process.env.TAURI_DATA_DIR),
      POSTGRES_URL_SET: Boolean(process.env.POSTGRES_URL),
      DATABASE_URL_SET: Boolean(process.env.DATABASE_URL),
    },
    database: tauri
      ? fileInfo(TAURI_DB_PATH)
      : { url: maskDatabaseUrl(getDatabaseUrl()) },
    paths: tauri
      ? {
          data: fileInfo(TAURI_DATA_DIR),
          storage: fileInfo(TAURI_STORAGE_PATH),
          logs: fileInfo(TAURI_LOGS_PATH),
        }
      : null,
    coreTables: await getCoreTableCounts(),
    externalStores: await getExternalStoreDiagnostics(),
  });
}
