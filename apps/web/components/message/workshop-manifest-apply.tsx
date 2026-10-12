"use client";

import { useEffect, useRef, useState } from "react";
import type { NativeConversationSourceMessage, WorkshopManifestHistoryReview } from "@/lib/ai/chat/native-conversation";
import { Button } from "@/components/ui/button";
import { WorkshopCreationReceipt } from "./workshop-creation-receipt";
import { WorkshopRunReceipt, findLatestChatWorkshopRunSource } from "./workshop-run-receipt";

const workshopIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
type ApplyReceipt = Record<string, unknown>;
type Props = {
  chatId: string;
  review: WorkshopManifestHistoryReview;
  messages: readonly NativeConversationSourceMessage[];
  disabled?: boolean;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function applyReceipt(value: unknown): ApplyReceipt | null {
  if (typeof value === "string") {
    if (value.length > 64_000) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  let result = record(value);
  if (result?.status === "success") result = record(result.result);
  if (!result) return null;
  const id = result.ok === true && result.status === "created_verified" ? record(result.workshop)?.id
    : result.ok === false && result.status === "created_readback_pending" ? result.workshopId : null;
  return typeof id === "string" && workshopIdPattern.test(id) ? result : null;
}

function matchesReview(receipt: ApplyReceipt, review: WorkshopManifestHistoryReview, manifestSha256: string) {
  return receipt.manifestSha256 === manifestSha256 &&
    (receipt.reviewAssistantMessageId === undefined || receipt.reviewAssistantMessageId === review.assistantMessageId) &&
    (receipt.reviewToolCallId === undefined || receipt.reviewToolCallId === review.toolUseId);
}

/** Historical business receipts inform display only; the server grants application authority. */
export function findWorkshopManifestApplyReceipt(messages: readonly NativeConversationSourceMessage[], chatId: string,
  review: WorkshopManifestHistoryReview, manifestSha256: string): ApplyReceipt | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || message.chatId && message.chatId !== chatId) continue;
    for (let partIndex = (message.parts?.length ?? 0) - 1; partIndex >= 0; partIndex--) {
      const part = record(message.parts![partIndex]);
      if (part?.type !== "tool-native" || part.toolName !== "applyWorkshopManifestYaml" ||
        (part.status !== "completed" && part.status !== "error")) continue;
      const receipt = applyReceipt(part.toolOutput);
      if (!receipt || !matchesReview(receipt, review, manifestSha256)) continue;
      if (receipt.status === "created_verified" && (part.status !== "completed" || part.isError === true)) continue;
      return receipt;
    }
  }
  return null;
}

export async function workshopManifestSha256(manifestYaml: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(manifestYaml));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

/** A direct owner action, with no model call, replacement YAML or extra confirmation dialog. */
export function WorkshopManifestApply({ chatId, review, messages, disabled = false }: Props) {
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<{ yaml: string; value: string } | null>(null);
  const [localReceipt, setLocalReceipt] = useState<ApplyReceipt | null>(null);
  const yaml = review.manifestYaml;

  useEffect(() => {
    if (review.state !== "valid" || !yaml || !review.toolUseId) return;
    let cancelled = false;
    // Hashing is read-only; POST happens exclusively in the owner's click handler.
    void workshopManifestSha256(yaml).then(value => { if (!cancelled) setHash({ yaml, value }); }).catch(() => {});
    return () => { cancelled = true; };
  }, [review.state, review.toolUseId, yaml]);

  if (review.state !== "valid" || !yaml || !review.toolUseId) return null;
  const manifestSha256 = hash?.yaml === yaml ? hash.value : null;
  const storedReceipt = manifestSha256 ? findWorkshopManifestApplyReceipt(messages, chatId, review, manifestSha256) : null;
  const receipt = manifestSha256 && localReceipt && matchesReview(localReceipt, review, manifestSha256) ? localReceipt : storedReceipt;
  const verified = receipt?.ok === true && receipt.status === "created_verified";
  const readbackPending = receipt?.status === "created_readback_pending";
  const createdWorkshop = verified ? record(receipt?.workshop) : null;
  const hasHistoryRunEntry = createdWorkshop && findLatestChatWorkshopRunSource(messages, chatId)?.workshop.id === createdWorkshop.id;

  async function apply() {
    if (inFlight.current || disabled || verified || !yaml || !review.toolUseId) return;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const exactHash = manifestSha256 ?? await workshopManifestSha256(yaml);
      setHash({ yaml, value: exactHash });
      const response = await fetch("/api/workshops/apply-reviewed-chat-manifest", {
        method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ chatId, reviewAssistantMessageId: review.assistantMessageId, reviewToolCallId: review.toolUseId, manifestSha256: exactHash }),
      });
      const body: unknown = await response.json();
      const result = applyReceipt(body);
      if (!response.ok || !result || !matchesReview(result, review, exactHash)) {
        const message = record(body)?.message;
        throw Error(typeof message === "string" && /[\u3400-\u9fff]/.test(message)
          ? message : "未能确认应用结果，请重试；如果配置已变化，请先刷新对话。");
      }
      setLocalReceipt(result);
    } catch (failure) {
      setError(failure instanceof Error && /[\u3400-\u9fff]/.test(failure.message)
        ? failure.message : "应用结果暂未确认，重试会核对同一份配置。");
    } finally {
      inFlight.current = false; setPending(false);
    }
  }

  return <div className="rounded-md border border-border bg-muted/20 px-3 py-3 text-sm" aria-busy={pending}>
    {receipt ? <WorkshopCreationReceipt toolName="applyWorkshopManifestYaml" status="completed" toolOutput={receipt} /> :
      <p className="mb-2 text-muted-foreground">配置已审核通过{review.title ? `：${review.title}` : ""}</p>}
    {!verified ? <Button type="button" size="sm" variant="outline" disabled={pending || disabled} onClick={() => { void apply(); }}>
      {pending ? "正在应用…" : readbackPending ? "重试核对结果" : error ? "重试应用" : "应用到车间"}
    </Button> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    {verified && receipt === localReceipt && createdWorkshop && !hasHistoryRunEntry ? <WorkshopRunReceipt
      key={`${chatId}/${String(createdWorkshop.id)}`} chatId={chatId} disabled={disabled}
      workshop={{ id: String(createdWorkshop.id), name: typeof createdWorkshop.name === "string" ? createdWorkshop.name : "当前智能体",
        status: typeof createdWorkshop.status === "string" ? createdWorkshop.status : "unknown" }}
    /> : null}
  </div>;
}
