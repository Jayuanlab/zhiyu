import { describe, expect, it, vi } from "vitest";

const register = vi.fn();

vi.mock("@openzhiyu/ai/agent/registry", () => ({
  getAgentRegistry: vi.fn(() => ({ register })),
}));

vi.mock("@/lib/ai/extensions", () => ({
  claudePlugin: { type: "claude" },
  piPlugin: { type: "pi" },
}));

import { registerPlugins } from "@/lib/ai/runtime/register-plugins";

describe("runtime plugin registration", () => {
  it("registers both Claude and Pi native providers", () => {
    registerPlugins();

    expect(register).toHaveBeenCalledWith({ type: "claude" });
    expect(register).toHaveBeenCalledWith({ type: "pi" });
  });
});
