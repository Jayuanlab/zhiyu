import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, isAbsolute } from "node:path";

const execFileAsync = promisify(execFile);

const DEFAULT_BINARY = "wx";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 16 * 1024 * 1024;

export type WechatLocalCommandResult = {
  stdout: string;
  stderr: string;
};

export type WechatLocalHealth = {
  ok: boolean;
  binary: string;
  version?: string;
  dataReady?: boolean;
  error?: string;
  stderr?: string;
  installed?: boolean;
  authorized?: boolean;
  status?: "disabled" | "init_required" | "available" | "failed";
};

export type WechatLocalOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type WechatLocalHistoryOptions = {
  signal?: AbortSignal;
  limit?: number;
  offset?: number;
  since?: string;
  until?: string;
  msgType?: string;
  withMeta?: boolean;
};

export type WechatLocalSearchOptions = {
  limit?: number;
  chats?: string[];
  since?: string;
  until?: string;
  msgType?: string;
  withMeta?: boolean;
};

export type WechatLocalNewMessagesOptions = {
  limit?: number;
  withMeta?: boolean;
};

export class WechatLocalCliError extends Error {
  code?: number | string;
  stderr?: string;
  stdout?: string;

  constructor(
    message: string,
    details: { code?: number | string; stderr?: string; stdout?: string } = {},
  ) {
    super(message);
    this.name = "WechatLocalCliError";
    this.code = details.code;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
  }
}

function getWxBinary() {
  return (
    process.env.WECHAT_LOCAL_WX_BINARY?.trim() ||
    process.env.WX_CLI_BINARY?.trim() ||
    DEFAULT_BINARY
  );
}

function managedReaderEnvironment(args: string[]) {
  // The installed runtime supplies this flag even while the component is disabled.
  // Developer-mode CLI use retains the existing environment and PATH fallback.
  if (process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED === undefined) return { ...process.env };
  const binary = getWxBinary();
  const directory = process.env.WECHAT_LOCAL_DATA_DIR?.trim();
  if (!isAbsolute(binary) || !directory || !isAbsolute(directory)) {
    throw new WechatLocalCliError("wechat_reader_private_paths_required");
  }
  const metadataOnly = args.length === 1 && args[0] === "--version";
  if (!metadataOnly) {
    if (process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== "true") {
      throw new WechatLocalCliError("wechat_reader_disabled");
    }
    if (process.env.WECHAT_LOCAL_AUTHORIZED !== "true") {
      throw new WechatLocalCliError("wechat_reader_init_required");
    }
    if (!["sessions", "history", "search", "unread", "new-messages"].includes(args[0])) {
      throw new WechatLocalCliError("wechat_reader_command_not_allowed");
    }
  }
  const token = process.env.WX_CLI_SESSION_TOKEN ?? "";
  if (!metadataOnly && token.length < 32) throw new WechatLocalCliError("wechat_reader_private_credential_required");
  const env: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV || "production" };
  for (const key of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "USERNAME", "USERDOMAIN", "PATH", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  // The patched, pinned CLI uses this directory for its config, keys, cache and
  // authenticated IPC. It must never fall back to a developer's ~/.wx-cli.
  return { ...env, WX_CLI_HOME: directory, WX_CLI_SESSION_TOKEN: token };
}

function timeoutMs(options?: WechatLocalOptions) {
  const raw =
    options?.timeoutMs ??
    Number.parseInt(process.env.WECHAT_LOCAL_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function maxBuffer(options?: WechatLocalOptions) {
  const raw =
    options?.maxBuffer ??
    Number.parseInt(process.env.WECHAT_LOCAL_MAX_BUFFER ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BUFFER;
}

function compactErrorText(value: unknown, max = 1_200) {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function appendLimit(args: string[], limit: number | undefined) {
  if (limit !== undefined) {
    args.push("-n", String(limit));
  }
}

function appendDateArgs(
  args: string[],
  input: { since?: string; until?: string; msgType?: string },
) {
  if (input.since) args.push("--since", input.since);
  if (input.until) args.push("--until", input.until);
  if (input.msgType) args.push("--type", input.msgType);
}

function appendMeta(args: string[], withMeta: boolean | undefined) {
  if (withMeta) args.push("--with-meta");
}

export async function runWechatLocalCommand(
  args: string[],
  options?: WechatLocalOptions,
): Promise<WechatLocalCommandResult> {
  const binary = getWxBinary();
  options?.signal?.throwIfAborted();
  const env = managedReaderEnvironment(args);
  try {
    const running = execFileAsync(binary, args, {
      signal: options?.signal,
      timeout: timeoutMs(options),
      maxBuffer: maxBuffer(options),
      windowsHide: true,
      env,
      ...(process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== undefined
        ? { cwd: args.length === 1 && args[0] === "--version" ? dirname(binary) : process.env.WECHAT_LOCAL_DATA_DIR }
        : {}),
    });
    const closed = new Promise<void>(resolve=>running.child.once('close',()=>resolve()));
    let result;
    try { result = await running; } finally { await closed; }
    return {
      stdout: result.stdout?.toString() ?? "",
      stderr: result.stderr?.toString() ?? "",
    };
  } catch (error) {
    const err = error as Error & {
      code?: number | string;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
    };
    const stderr = err.stderr?.toString() ?? "";
    const stdout = err.stdout?.toString() ?? "";
    throw new WechatLocalCliError(
      `wx-cli failed: ${compactErrorText(stderr || err.message)}`,
      {
        code: err.code,
        stderr,
        stdout,
      },
    );
  }
}

export async function runWechatLocalJson<T = unknown>(
  args: string[],
  options?: WechatLocalOptions,
): Promise<T> {
  const result = await runWechatLocalCommand(args, options);
  const raw = result.stdout.trim();
  if (!raw) {
    throw new WechatLocalCliError("wx-cli returned empty stdout", {
      stderr: result.stderr,
      stdout: result.stdout,
    });
  }
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new WechatLocalCliError(
      `wx-cli returned non-JSON stdout: ${compactErrorText(error)}`,
      {
        stderr: result.stderr,
        stdout: result.stdout.slice(0, 2_000),
      },
    );
  }
}

export async function getWechatLocalHealth(options?: {
  probeData?: boolean;
}): Promise<WechatLocalHealth> {
  const binary = getWxBinary();
  try {
    const version = await runWechatLocalCommand(["--version"], {
      timeoutMs: 10_000,
    });
    const health: WechatLocalHealth = {
      ok: true,
      binary,
      version: version.stdout.trim(),
      stderr: version.stderr.trim() || undefined,
      ...(process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== undefined ? {
        installed: true,
        authorized: process.env.WECHAT_LOCAL_AUTHORIZED === "true",
        status: process.env.ZHIYU_OPTIONAL_WECHAT_ENABLED !== "true" ? "disabled" as const : process.env.WECHAT_LOCAL_AUTHORIZED === "true" ? "available" as const : "init_required" as const,
      } : {}),
    };
    if (options?.probeData) {
      try {
        await getWechatLocalSessions({ limit: 1 });
        health.dataReady = true;
      } catch (error) {
        health.ok = false;
        health.dataReady = false;
        health.error = compactErrorText(error);
      }
    }
    return health;
  } catch (error) {
    return {
      ok: false,
      binary,
      error: compactErrorText(error),
      stderr: error instanceof WechatLocalCliError ? error.stderr : undefined,
    };
  }
}

export async function getWechatLocalSessions(input: {
  signal?: AbortSignal;
  limit?: number;
  withMeta?: boolean;
}) {
  const args = ["sessions", "--json"];
  appendLimit(args, input.limit);
  appendMeta(args, input.withMeta);
  return runWechatLocalJson(args,{signal:input.signal});
}

export async function getWechatLocalUnread(input: {
  limit?: number;
  filter?: string[];
  withMeta?: boolean;
}) {
  const args = ["unread", "--json"];
  appendLimit(args, input.limit);
  if (input.filter && input.filter.length > 0) {
    args.push("--filter", input.filter.join(","));
  }
  appendMeta(args, input.withMeta);
  return runWechatLocalJson(args);
}

export async function getWechatLocalNewMessages(
  input: WechatLocalNewMessagesOptions = {},
) {
  const args = ["new-messages", "--json"];
  appendLimit(args, input.limit);
  appendMeta(args, input.withMeta);
  return runWechatLocalJson(args);
}

export async function getWechatLocalHistory(
  chat: string,
  input: WechatLocalHistoryOptions = {},
) {
  const args = ["history", chat, "--json"];
  appendLimit(args, input.limit);
  if (input.offset !== undefined) args.push("--offset", String(input.offset));
  appendDateArgs(args, input);
  appendMeta(args, input.withMeta);
  return runWechatLocalJson(args,{signal:input.signal});
}

export async function searchWechatLocalMessages(
  keyword: string,
  input: WechatLocalSearchOptions = {},
) {
  const args = ["search", keyword, "--json"];
  appendLimit(args, input.limit);
  for (const chat of input.chats ?? []) {
    args.push("--in", chat);
  }
  appendDateArgs(args, input);
  appendMeta(args, input.withMeta);
  return runWechatLocalJson(args);
}
