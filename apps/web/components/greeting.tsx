"use client";

import type { UseChatHelpers } from "@ai-sdk/react";
import type { ChatMessage } from "@openzhiyu/shared";
import { motion } from "framer-motion";
import Link from "next/link";
import { memo, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { RemixIcon } from "./remix-icon";
import {
  getAllDefaultSuggestions,
  type SuggestedPrompt,
} from "./suggested-actions";
import { useChatContextOptional } from "./chat-context";
import { CHAT_SUGGESTIONS_SOURCE_WARNING } from "@/lib/ai/chat-suggestions-policy";

interface GreetingProps {
  chatId: string;
  sendMessage?: UseChatHelpers<ChatMessage>["sendMessage"];
  onSuggestionsReady?: (suggestions: SuggestedPrompt[]) => void;
  onSuggestionUsed?: (suggestionId: string) => void;
  onSuggestionClick?: (suggestion: SuggestedPrompt) => void;
  isAgentRunning?: boolean;
}

const PRODUCT_PATHS = [
  {
    label: "沉淀记忆",
    description: "摘要、待办与长期事实",
    href: "/knowledge-pipeline",
    icon: "brain",
    tone: "text-[var(--product-jade)] bg-[#E7F2F0]",
  },
  {
    label: "持续执行",
    description: "车间、任务与待确认",
    href: "/workshop",
    icon: "store_3",
    tone: "text-[var(--product-amber)] bg-[#F8EFE1]",
  },
] as const;

const SUGGESTION_ICONS: Record<string, string> = {
  wechatDigest: "wechat_2",
  memoryReview: "book_open",
  stockWorkshop: "stock",
  followUp: "list_checks",
};

export const Greeting = memo(function Greeting({
  chatId,
  sendMessage,
  onSuggestionsReady,
  onSuggestionUsed,
  onSuggestionClick,
  isAgentRunning = false,
}: GreetingProps) {
  const { t } = useTranslation();
  const chatContext = useChatContextOptional();
  const focusedInsights = chatContext?.focusedInsights ?? [];
  const hasFocusedInsights = focusedInsights.length > 0;

  const allSuggestions = useMemo(() => getAllDefaultSuggestions(t), [t]);

  useEffect(() => {
    if (
      allSuggestions.length > 0 &&
      onSuggestionsReady &&
      !hasFocusedInsights
    ) {
      onSuggestionsReady(allSuggestions);
    }
  }, [allSuggestions, onSuggestionsReady, hasFocusedInsights]);

  return (
    <div
      key={chatId}
      className="mx-auto flex min-h-full w-full max-w-4xl flex-col justify-center px-3 py-8 sm:px-6 sm:py-12"
    >
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: "easeOut" }}
      >
        <div className="flex items-center gap-2 text-xs font-medium text-[var(--product-jade)]">
          <span
            className="h-px w-6 bg-[var(--product-jade)]"
            aria-hidden="true"
          />
          知语工作台
        </div>
        <h2 className="mt-4 max-w-2xl text-[28px] font-semibold leading-tight text-foreground sm:text-4xl">
          {t("common.chatSubTitle")}
        </h2>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          {t(
            "common.chatSubDescription",
            "把消息变成记忆，把记忆交给持续工作的智能体。你也可以直接说出现在想完成的事。",
          )}
        </p>
      </motion.div>

      <nav
        aria-label="知语工作流"
        className="mt-8 grid overflow-hidden rounded-lg border border-border bg-[#F8FAF9] sm:grid-cols-3"
      >
        {PRODUCT_PATHS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="group flex min-w-0 items-center gap-3 border-b border-border px-4 py-3 text-foreground no-underline transition-colors hover:bg-white hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary sm:border-b-0 sm:border-r sm:last:border-r-0"
          >
            <span
              className={`flex size-9 shrink-0 items-center justify-center rounded-md ${item.tone}`}
            >
              <RemixIcon name={item.icon} size="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{item.label}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {item.description}
              </span>
            </span>
            <RemixIcon
              name="arrow_right_s"
              size="size-4"
              className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
        ))}
      </nav>

      <section className="mt-8" aria-labelledby="quick-start-title">
        <div className="mb-3 flex items-center justify-between gap-4">
          <h3
            id="quick-start-title"
            className="text-sm font-medium text-foreground"
          >
            直接交给知语
          </h3>
          <span className="text-xs text-muted-foreground">从真实工作开始</span>
        </div>
        <div
          data-testid="suggested-actions"
          className="grid gap-2 sm:grid-cols-2"
        >
          {allSuggestions.map((item) => (
            <SuggestionCard
              key={item.id}
              item={item}
              disabled={isAgentRunning}
              sendMessage={sendMessage}
              onSuggestionUsed={onSuggestionUsed}
              onSuggestionClick={onSuggestionClick}
              isAgentRunning={isAgentRunning}
            />
          ))}
        </div>
        <p role="status" className="mt-3 text-xs leading-5 text-muted-foreground">
          {CHAT_SUGGESTIONS_SOURCE_WARNING}
        </p>
      </section>
    </div>
  );
});

function SuggestionCard({
  item,
  sendMessage,
  onSuggestionUsed,
  onSuggestionClick,
  disabled,
  isAgentRunning,
}: {
  item: SuggestedPrompt;
  sendMessage?: UseChatHelpers<ChatMessage>["sendMessage"];
  onSuggestionUsed?: (suggestionId: string) => void;
  onSuggestionClick?: (suggestion: SuggestedPrompt) => void;
  disabled: boolean;
  isAgentRunning?: boolean;
}) {
  const chatContext = useChatContextOptional();
  const activeChatId = chatContext?.activeChatId;
  const contextSendMessage = chatContext?.sendMessage;

  const handleClick = async (event: React.MouseEvent) => {
    event.preventDefault();
    if (isAgentRunning || !activeChatId) return;

    onSuggestionUsed?.(item.id);
    if (onSuggestionClick) {
      onSuggestionClick(item);
      return;
    }

    const sendFn = contextSendMessage || sendMessage;
    if (!sendFn) return;

    try {
      await sendFn({
        role: "user",
        parts: [{ type: "text", text: item.title }],
      });
    } catch (error) {
      console.error("[SuggestionCard] Failed to send message:", error);
    }
  };

  return (
    <button
      type="button"
      className="group flex min-h-[72px] min-w-0 items-center gap-3 rounded-md border border-border bg-white px-3 py-3 text-left transition-[border-color,background-color] hover:border-primary/40 hover:bg-[#F8FAFD] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled || !activeChatId}
      onClick={handleClick}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted/60 text-foreground">
        <RemixIcon
          name={SUGGESTION_ICONS[item.id] ?? "sparkling_2"}
          size="size-4"
          aria-hidden="true"
        />
      </span>
      <span className="min-w-0 flex-1 text-sm font-medium leading-5 text-foreground">
        {item.title}
      </span>
      <RemixIcon
        name="arrow_right_up"
        size="size-4"
        className="shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
        aria-hidden="true"
      />
    </button>
  );
}
