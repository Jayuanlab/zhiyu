import { describe, expect, it } from "vitest";
import { resolveNativePiUserConfig } from "@/lib/ai/native-pi-user-config";
describe("Pi user model configuration", () => {
  const anthropic = { apiKey: "user-key", baseUrl: "https://user-provider", model: "user-model" };
  it("keeps saved Anthropic credentials and protocol together, without inherited OpenAI routing", () => {
    expect(resolveNativePiUserConfig({ env: {apiKey:"old-key",model:"old-model",protocol:"openai-completions",providerId:"old-provider"},anthropic })).toEqual({...anthropic,protocol:"anthropic-messages"});
  });
  it("keeps saved OpenAI priority and never pairs it with an Anthropic protocol", () => {
    const openAI={...anthropic,model:"openai-model"};
    expect(resolveNativePiUserConfig({env:{protocol:"openai-responses",providerId:"env-provider"},openAI,anthropic})).toEqual({...openAI,protocol:"openai-completions"});
  });
  it("preserves request/env fallback when no user override exists", () => {
    expect(resolveNativePiUserConfig({env:{model:"env",apiKey:"env-key",protocol:"openai-responses"},request:{model:"requested"}})).toMatchObject({model:"requested",apiKey:"env-key",protocol:"openai-responses"});
  });
});
