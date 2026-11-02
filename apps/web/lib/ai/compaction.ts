import { generateText } from "ai";
import {
  triggerCompaction as trigger,
  triggerCompactionAsync as triggerAsync,
  type CompactionOptions,
} from "@openzhiyu/ai/agent/compaction";
import { createConfiguredTextModel } from "./model-configuration";

function ownerTransport<T extends CompactionOptions>(options: T & { userId?: string }): T {
  if (!options.userId) return options;
  return { ...options, complete: async ({ messages, system }) => {
    const model = await createConfiguredTextModel({ userId: options.userId!, purpose: "conversation_compaction" });
    const result = await generateText({ model, system, messages: messages as any });
    return { text: result.text, usage: { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens } };
  } };
}

export function triggerCompaction(options: CompactionOptions & { userId?: string }) {
  return trigger(ownerTransport(options));
}
export function triggerCompactionAsync(options: Parameters<typeof triggerAsync>[0] & { userId?: string }) {
  return triggerAsync(ownerTransport(options));
}
