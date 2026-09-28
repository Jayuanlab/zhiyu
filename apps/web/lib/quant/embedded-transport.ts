import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

type Pending = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

function quantEnvironment(quantDir: string) {
  const values: NodeJS.ProcessEnv = { ...process.env };
  const file = resolve(quantDir, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const separator = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      if (!/^QUANT_[A-Z0-9_]+$/.test(key) || values[key] !== undefined) continue;
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      values[key] = value;
    }
  }
  values.PYTHONUTF8 = "1";
  values.PYTHONIOENCODING = "utf-8";
  return values;
}

class EmbeddedQuantTransport {
  private child: ChildProcessWithoutNullStreams | null = null;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private detail = "not_started";
  private lastRequestAt: string | null = null;

  private start() {
    if (this.child) return this.child;
    const root = [process.cwd(), resolve(process.cwd(), "../..")]
      .find((candidate) => existsSync(resolve(candidate, "tools/quant-service/embedded_worker.py")));
    if (!root) throw new Error("quant_embedded_worker_missing");
    const quantDir = resolve(root, "tools/quant-service");
    const venv = resolve(quantDir, process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
    const python = process.env.QUANT_PYTHON_BIN || (existsSync(venv) ? venv : "python");
    const child = spawn(python, ["-u", "embedded_worker.py"], {
      cwd: quantDir,
      env: quantEnvironment(quantDir),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.detail = "starting";
    child.stdin.on("error", () => undefined);
    createInterface({ input: child.stdout }).on("line", (line) => {
      let message: { id?: number; status?: number; body?: string; error?: string };
      try { message = JSON.parse(line); } catch { this.close("quant_embedded_protocol_error"); return; }
      const pending = message.id == null ? undefined : this.pending.get(message.id);
      if (!pending || message.id == null) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error || !Number.isInteger(message.status)) pending.reject(new Error(message.error || "quant_embedded_protocol_error"));
      else {
        this.detail = "ready";
        pending.resolve(new Response(message.body ?? "", { status: message.status }));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const last = chunk.toString("utf8").trim();
      if (last) this.detail = last.slice(-500);
    });
    child.on("error", (error) => this.stop(`quant_embedded_start_failed: ${error.message}`, child));
    child.on("exit", (code) => this.stop(`quant_embedded_exited: ${code}`, child));
    return child;
  }

  private failAll(reason: string) {
    this.detail = reason;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private stop(reason: string, child: ChildProcessWithoutNullStreams) {
    if (this.child !== child) return;
    this.child = null;
    this.failAll(reason);
  }

  status() {
    return { mode: "embedded", running: this.child !== null && this.child.exitCode === null,
      pid: this.child?.pid ?? null, detail: this.detail, lastRequestAt: this.lastRequestAt,
      pending: this.pending.size };
  }

  close(reason = "quant_embedded_closed") {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAll(reason);
    child.stdin.end();
    child.kill();
  }

  async request(url: string | URL, init: RequestInit = {}): Promise<Response> {
    const parsed = new URL(url);
    const child = this.start();
    const id = ++this.sequence;
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = typeof init.body === "string" ? init.body : "";
    const timeout = 30_000;
    this.lastRequestAt = new Date().toISOString();
    return await new Promise<Response>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        init.signal?.removeEventListener("abort", onAbort);
        this.close("quant_embedded_timeout");
        rejectRequest(new Error("quant_embedded_timeout"));
      }, timeout);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectRequest(new Error("quant_embedded_aborted"));
      };
      if (init.signal?.aborted) { onAbort(); return; }
      init.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        timer,
        resolve: (response) => { init.signal?.removeEventListener("abort", onAbort); resolveRequest(response); },
        reject: (error) => { init.signal?.removeEventListener("abort", onAbort); rejectRequest(error); },
      });
      child.stdin.write(JSON.stringify({ id, method: init.method || "GET", path: parsed.pathname + parsed.search,
        headers, body }) + "\n", "utf8", (error) => {
        if (error && this.pending.has(id)) {
          const pending = this.pending.get(id)!;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(error);
        }
      });
    });
  }
}

const key = Symbol.for("zhiyu.quant.embeddedTransport");
const globals = globalThis as typeof globalThis & { [key: symbol]: EmbeddedQuantTransport | undefined };
const transport = globals[key] ?? (globals[key] = new EmbeddedQuantTransport());

export function getEmbeddedQuantStatus() { return transport.status(); }
export function closeEmbeddedQuant() { transport.close(); }

export function useQuantHttpTransport() {
  return process.env.QUANT_TRANSPORT === "http";
}

export function quantRequest(url: string | URL, init?: RequestInit) {
  return useQuantHttpTransport() ? fetch(url, init) : transport.request(url, init);
}
