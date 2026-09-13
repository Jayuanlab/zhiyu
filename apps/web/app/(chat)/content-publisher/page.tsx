"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RemixIcon } from "@/components/remix-icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  DouyinCommandPlan,
  DouyinDraftCreateResult,
  DouyinDraftListResult,
  DouyinPublisherHealth,
} from "@/lib/douyin/types";
import { cn } from "@/lib/utils";

type JsonResult = Record<string, unknown>;

interface DraftSummary {
  id: string;
  title: string;
  status: string;
  video_path: string;
  scheduled_at?: string | null;
  updated_at: string;
}

interface DraftFormState {
  title: string;
  description: string;
  topics: string;
  videoPath: string;
  coverPath: string;
  scheduledAt: string;
  aiGenerated: boolean;
}

const initialForm: DraftFormState = {
  title: "",
  description: "",
  topics: "",
  videoPath: "",
  coverPath: "",
  scheduledAt: "",
  aiGenerated: true,
};

function commandText(command?: string[]) {
  return command?.join(" ") || "暂无命令";
}

function statusText(status?: string) {
  if (!status) return "未知";
  const map: Record<string, string> = {
    draft: "草稿",
    prepared: "已生成计划",
    published: "已发布",
    failed: "失败",
  };
  return map[status] ?? status;
}

function formatTime(value?: string | null) {
  if (!value) return "未定时";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function resultLine(result: JsonResult | null) {
  if (!result) return "";
  const statusLabel =
    typeof result.account_status_label === "string"
      ? result.account_status_label
      : typeof result.account_status === "string"
        ? result.account_status
        : "";
  const stdout = typeof result.stdout === "string" ? result.stdout.trim() : "";
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  const code =
    typeof result.exit_code === "number" ? `退出码 ${result.exit_code}` : "";
  return [statusLabel ? `账号状态：${statusLabel}` : "", stdout, stderr, code]
    .filter(Boolean)
    .join(" / ");
}

export default function ContentPublisherPage() {
  const [health, setHealth] = useState<DouyinPublisherHealth | null>(null);
  const [loginPlan, setLoginPlan] = useState<DouyinCommandPlan | null>(null);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [form, setForm] = useState<DraftFormState>(initialForm);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [checkResult, setCheckResult] = useState<JsonResult | null>(null);
  const [planByDraft, setPlanByDraft] = useState<Record<string, DouyinCommandPlan>>(
    {},
  );

  const loadAll = useCallback(async () => {
    const [healthResult, loginResult, draftsResult] = await Promise.allSettled([
      fetch("/api/douyin/health", { cache: "no-store" }).then(
        async (response) => (await response.json()) as DouyinPublisherHealth,
      ),
      fetch("/api/douyin/login", { cache: "no-store" }).then(
        async (response) => (await response.json()) as DouyinCommandPlan,
      ),
      fetch("/api/douyin/drafts", { cache: "no-store" }).then(
        async (response) => (await response.json()) as DouyinDraftListResult,
      ),
    ]);

    if (healthResult.status === "fulfilled") {
      setHealth(healthResult.value);
    }
    if (loginResult.status === "fulfilled") {
      setLoginPlan(loginResult.value);
    }
    if (draftsResult.status === "fulfilled") {
      setDrafts(
        Array.isArray(draftsResult.value.drafts) ? draftsResult.value.drafts : [],
      );
    }

    const errors = [healthResult, loginResult, draftsResult]
      .filter((result) => result.status === "rejected")
      .map((result) =>
        result.status === "rejected" && result.reason instanceof Error
          ? result.reason.message
          : "加载失败",
      );
    if (errors.length > 0) setMessage(errors.join("；"));
  }, []);

  useEffect(() => {
    void loadAll().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : "加载发布工具失败");
    });
  }, [loadAll]);

  const healthTone = useMemo(() => {
    if (!health) return "muted";
    if (health.ok && health.publisher_cli_available) return "ok";
    return "warn";
  }, [health]);

  async function startLogin() {
    setBusy("login");
    setMessage("");
    try {
      const response = await fetch("/api/douyin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execute: true }),
      });
      const body = (await response.json()) as {
        message?: string;
        error?: string;
        install_hint?: string;
      };
      if (!response.ok || body.error) {
        throw new Error(
          [body.error ?? "启动登录失败", body.install_hint]
            .filter(Boolean)
            .join(" "),
        );
      }
      setMessage("已启动登录，请在打开的浏览器里完成抖音账号授权。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "启动登录失败");
    } finally {
      setBusy(null);
    }
  }

  async function checkAccount() {
    setBusy("check");
    setMessage("");
    try {
      const response = await fetch("/api/douyin/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execute: true }),
      });
      const body = (await response.json()) as DouyinCommandPlan;
      setCheckResult(
        ({
          ...(body.result ?? {}),
          account_valid: body.account_valid,
          account_status: body.account_status,
          account_status_label: body.account_status_label,
        }) as JsonResult,
      );
      setMessage(
        body.account_valid
          ? "账号检测完成：有效。"
          : body.ok
            ? `账号检测完成：${body.account_status_label ?? "未知"}。`
            : body.error ?? "账号未登录或检测失败。",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "账号检测失败");
    } finally {
      setBusy(null);
    }
  }

  async function createDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("draft");
    setMessage("");
    try {
      const response = await fetch("/api/douyin/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim(),
          topics: form.topics
            .split(/[,，\s]+/)
            .map((item) => item.trim())
            .filter(Boolean),
          video_path: form.videoPath.trim(),
          cover_path: form.coverPath.trim() || undefined,
          scheduled_at: form.scheduledAt.trim() || undefined,
          ai_generated: form.aiGenerated,
          source: { created_from: "content_publisher_page" },
        }),
      });
      const body = (await response.json()) as DouyinDraftCreateResult;
      if (!response.ok || body.error) throw new Error(body.error ?? "保存草稿失败");
      setMessage(`草稿已保存：${body.draft.title}`);
      setForm(initialForm);
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存草稿失败");
    } finally {
      setBusy(null);
    }
  }

  async function prepareUpload(draftId: string, execute: boolean) {
    setBusy(`${execute ? "publish" : "plan"}:${draftId}`);
    setMessage("");
    try {
      const endpoint = execute
        ? `/api/douyin/drafts/${draftId}/publish`
        : `/api/douyin/drafts/${draftId}/prepare-upload`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ execute }),
      });
      const body = (await response.json()) as DouyinCommandPlan;
      if (!response.ok || body.error) {
        throw new Error(body.error ?? (execute ? "执行上传失败" : "生成计划失败"));
      }
      setPlanByDraft((current) => ({ ...current, [draftId]: body }));
      setMessage(execute ? "上传命令已执行，请查看平台结果。" : "上传计划已生成。");
      await loadAll();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "操作失败");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-6">
        <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RemixIcon name="video" size="size-4" />
              <span>内容发布工具</span>
            </div>
            <h1 className="text-3xl font-semibold tracking-normal">抖音发布台</h1>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              先沉淀草稿和命令计划，再由你或智能体在授权边界内触发上传。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void loadAll()}>
              <RemixIcon name="refresh" size="size-4" className="mr-1.5" />
              刷新
            </Button>
            <Button
              variant="outline"
              onClick={() => void startLogin()}
              disabled={busy === "login" || health?.publisher_cli_available === false}
            >
              <RemixIcon name="qr_code" size="size-4" className="mr-1.5" />
              启动登录
            </Button>
            <Button onClick={() => void checkAccount()} disabled={busy === "check"}>
              <RemixIcon name="shield_check" size="size-4" className="mr-1.5" />
              检查账号
            </Button>
          </div>
        </header>

        {message ? (
          <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-foreground">
            {message}
          </div>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
          <div className="rounded-md border border-border bg-card p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-medium">账号与环境</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  登录状态来自本机 social-auto-upload 配置。
                </p>
              </div>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs",
                  healthTone === "ok" && "bg-emerald-100 text-emerald-700",
                  healthTone === "warn" && "bg-amber-100 text-amber-700",
                  healthTone === "muted" && "bg-muted text-muted-foreground",
                )}
              >
                {healthTone === "ok" ? "可用" : healthTone === "warn" ? "需处理" : "加载中"}
              </span>
            </div>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">账号</dt>
                <dd className="min-w-0 truncate">{health?.account ?? "default"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">工具状态</dt>
                <dd>{health?.publisher_cli_available ? "已接入" : "未接入"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">配置文件</dt>
                <dd>{health?.sau_conf_exists ? "已找到" : "未找到"}</dd>
              </div>
              <div className="space-y-1">
                <dt className="text-muted-foreground">登录命令</dt>
                <dd className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  {commandText(loginPlan?.command ?? health?.login_command)}
                </dd>
              </div>
              {checkResult ? (
                <div className="space-y-1">
                  <dt className="text-muted-foreground">检测结果</dt>
                  <dd className="break-all rounded-md bg-muted px-3 py-2 text-xs">
                    {resultLine(checkResult) || JSON.stringify(checkResult)}
                  </dd>
                </div>
              ) : null}
            </dl>
          </div>

          <form
            onSubmit={(event) => void createDraft(event)}
            className="rounded-md border border-border bg-card p-5"
          >
            <div className="mb-4">
              <h2 className="text-lg font-medium">新建发布草稿</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                视频路径使用本机绝对路径，保存后可以先生成上传计划。
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="douyin-title">标题</Label>
                <Input
                  id="douyin-title"
                  value={form.title}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, title: event.target.value }))
                  }
                  placeholder="例如：今日市场复盘"
                  required
                />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="douyin-video-path">视频路径</Label>
                <Input
                  id="douyin-video-path"
                  value={form.videoPath}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      videoPath: event.target.value,
                    }))
                  }
                  placeholder="D:\\videos\\demo.mp4"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="douyin-topics">话题</Label>
                <Input
                  id="douyin-topics"
                  value={form.topics}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, topics: event.target.value }))
                  }
                  placeholder="财经, 人工智能"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="douyin-cover-path">封面路径</Label>
                <Input
                  id="douyin-cover-path"
                  value={form.coverPath}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      coverPath: event.target.value,
                    }))
                  }
                  placeholder="可留空"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="douyin-scheduled-at">定时发布时间</Label>
                <Input
                  id="douyin-scheduled-at"
                  value={form.scheduledAt}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      scheduledAt: event.target.value,
                    }))
                  }
                  placeholder="2026-07-30 20:00"
                />
              </div>
              <label className="flex items-center gap-2 self-end rounded-md border border-border px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.aiGenerated}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      aiGenerated: event.target.checked,
                    }))
                  }
                />
                AI 生成内容
              </label>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="douyin-description">正文</Label>
                <Textarea
                  id="douyin-description"
                  value={form.description}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      description: event.target.value,
                    }))
                  }
                  rows={5}
                  placeholder="写入视频简介、免责声明或内容说明。"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button type="submit" disabled={busy === "draft"}>
                <RemixIcon name="save" size="size-4" className="mr-1.5" />
                保存草稿
              </Button>
            </div>
          </form>
        </section>

        <section className="rounded-md border border-border bg-card">
          <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
            <div>
              <h2 className="text-lg font-medium">发布草稿</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                先看命令计划，再决定是否执行上传。
              </p>
            </div>
            <span className="text-sm text-muted-foreground">{drafts.length} 条</span>
          </div>
          {drafts.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-muted-foreground">
              还没有草稿。
            </div>
          ) : (
            <div className="divide-y divide-border">
              {drafts.map((draft) => {
                const plan = planByDraft[draft.id];
                return (
                  <article key={draft.id} className="grid gap-4 px-5 py-4 lg:grid-cols-[1fr_auto]">
                    <div className="min-w-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="truncate text-base font-medium">{draft.title}</h3>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                          {statusText(draft.status)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(draft.scheduled_at)}
                        </span>
                      </div>
                      <p className="break-all text-sm text-muted-foreground">
                        {draft.video_path}
                      </p>
                      {plan ? (
                        <div className="break-all rounded-md bg-muted px-3 py-2 font-mono text-xs">
                          {commandText(plan.command)}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap items-start justify-end gap-2">
                      <Button
                        variant="outline"
                        onClick={() => void prepareUpload(draft.id, false)}
                        disabled={busy === `plan:${draft.id}`}
                      >
                        <RemixIcon name="terminal" size="size-4" className="mr-1.5" />
                        生成计划
                      </Button>
                      <Button
                        onClick={() => void prepareUpload(draft.id, true)}
                        disabled={busy === `publish:${draft.id}`}
                      >
                        <RemixIcon name="upload" size="size-4" className="mr-1.5" />
                        执行上传
                      </Button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
