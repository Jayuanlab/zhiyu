/**
 * Plugin Registration
 *
 * Registers agent plugins. This module is loaded separately to avoid
 * circular dependency issues during module initialization.
 */

import { getAgentRegistry } from "@openzhiyu/ai/agent/registry";
import { claudePlugin, piPlugin } from "@/lib/ai/extensions";

// Register native agent plugins.
// This must be called AFTER all modules are loaded to avoid circular deps
export function registerPlugins() {
  const registry = getAgentRegistry();
  registry.register(claudePlugin);
  registry.register(piPlugin);
}
