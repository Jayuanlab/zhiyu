// vite.config.ts
import { defineConfig } from "vitest/config";
import path from "node:path";

const alias = (p: string) => path.resolve(__dirname, p);

export default defineConfig({
  resolve: {
    alias: [
      { find: "@openzhiyu/shared/model-center", replacement: alias("../../packages/shared/src/model-center.ts") },
      { find: "@openzhiyu/shared/model-configuration", replacement: alias("../../packages/shared/src/model-configuration.ts") },
      // Specific paths first (higher priority)
      {
        find: "@openzhiyu/shared/errors",
        replacement: alias("../../packages/shared/src/errors.ts"),
      },
      {
        find: "@openzhiyu/security/token-encryption",
        replacement: alias("../../packages/security/src/token-encryption.ts"),
      },
      {
        find: "@openzhiyu/security/url-validator",
        replacement: alias("../../packages/security/src/url-validator.ts"),
      },
      // agent subpaths - must be before the shorter @openzhiyu/agent alias
      {
        find: "@openzhiyu/agent/types",
        replacement: alias("../../packages/ai/src/agent/types.ts"),
      },
      {
        find: "@openzhiyu/agent/registry",
        replacement: alias("../../packages/ai/src/agent/registry.ts"),
      },
      {
        find: "@openzhiyu/agent/sandbox",
        replacement: alias("../../packages/ai/src/agent/sandbox/index.ts"),
      },
      {
        find: "@openzhiyu/agent/plugin",
        replacement: alias("../../packages/ai/src/agent/plugin.ts"),
      },
      {
        find: "@openzhiyu/agent/base",
        replacement: alias("../../packages/ai/src/agent/base.ts"),
      },
      // agent/ai subpaths - must be before the shorter @openzhiyu/agent/ai alias
      {
        find: "@openzhiyu/agent/ai/request-context",
        replacement: alias("../../packages/ai/src/agent/ai/request-context.ts"),
      },
      {
        find: "@openzhiyu/agent/ai/providers",
        replacement: alias("../../packages/ai/src/agent/ai/providers.ts"),
      },
      {
        find: "@openzhiyu/agent/ai/router",
        replacement: alias("../../packages/ai/src/agent/ai/router.ts"),
      },
      {
        find: "@openzhiyu/agent/ai/tokens",
        replacement: alias("../../packages/ai/src/agent/ai/tokens.ts"),
      },
      {
        find: "@openzhiyu/agent/ai/*",
        replacement: alias("../../packages/ai/src/agent/ai/*"),
      },
      {
        find: "@openzhiyu/agent/ai",
        replacement: alias("../../packages/ai/src/agent/ai/index.ts"),
      },
      // @openzhiyu/ai/agent subpaths - must be before @openzhiyu/ai/*
      {
        find: "@openzhiyu/ai/agent/context",
        replacement: alias("../../packages/ai/src/agent/context"),
      },
      {
        find: "@openzhiyu/ai/agent/compaction",
        replacement: alias("../../packages/ai/src/agent/compaction"),
      },
      {
        find: "@openzhiyu/ai/agent/registry",
        replacement: alias("../../packages/ai/src/agent/registry"),
      },
      {
        find: "@openzhiyu/ai/agent/billing",
        replacement: alias("../../packages/ai/src/agent/billing"),
      },
      {
        find: "@openzhiyu/ai/agent/model",
        replacement: alias("../../packages/ai/src/agent/model"),
      },
      {
        find: "@openzhiyu/ai/agent/routing",
        replacement: alias("../../packages/ai/src/agent/routing"),
      },
      {
        find: "@openzhiyu/ai/agent/sandbox",
        replacement: alias("../../packages/ai/src/agent/sandbox"),
      },
      {
        find: "@openzhiyu/ai/agent/plugin",
        replacement: alias("../../packages/ai/src/agent/plugin.ts"),
      },
      {
        find: "@openzhiyu/ai/agent/types",
        replacement: alias("../../packages/ai/src/agent/types.ts"),
      },
      {
        find: "@openzhiyu/ai/agent/ai",
        replacement: alias("../../packages/ai/src/agent/index.ts"),
      },
      {
        find: /^@openzhiyu\/ai\/agent\/(.+)$/,
        replacement: `${alias("../../packages/ai/src/agent")}/$1`,
      },
      {
        find: "@openzhiyu/ai/agent",
        replacement: alias("../../packages/ai/src/agent/index.ts"),
      },
      // @openzhiyu/ai subpaths - store and memory
      {
        find: "@openzhiyu/ai/store",
        replacement: alias("../../packages/ai/src/store/index.ts"),
      },
      {
        find: "@openzhiyu/ai/memory",
        replacement: alias("../../packages/ai/src/memory/index.ts"),
      },
      // @openzhiyu/ai/* wildcard - matches single segment subpaths
      {
        find: /^@openzhiyu\/ai\/(.+)$/,
        replacement: `${alias("../../packages/ai/src")}/$1`,
      },
      {
        find: "@openzhiyu/ai",
        replacement: alias("../../packages/ai/src/index.ts"),
      },
      {
        find: "@openzhiyu/audit",
        replacement: alias("../../packages/audit/src/index.ts"),
      },

      // Package roots
      {
        find: "@openzhiyu/mcp",
        replacement: alias("../../packages/ai/mcp/src/index.ts"),
      },
      // rag subpaths - must be before the shorter @openzhiyu/rag alias
      {
        find: "@openzhiyu/rag/universal-embeddings",
        replacement: alias("../../packages/ai/rag/src/universal-embeddings.ts"),
      },
      {
        find: /^@openzhiyu\/rag\/(.+)$/,
        replacement: `${alias("../../packages/ai/rag/src")}/$1`,
      },
      {
        find: "@openzhiyu/rag",
        replacement: alias("../../packages/ai/rag/src/index.ts"),
      },
      {
        find: "@openzhiyu/runtime-api/rag",
        replacement: alias("../../packages/runtime-api/src/rag.ts"),
      },
      {
        find: "@openzhiyu/runtime-api/*",
        replacement: alias("../../packages/runtime-api/src/*"),
      },
      {
        find: "@openzhiyu/runtime-api",
        replacement: alias("../../packages/runtime-api/src/index.ts"),
      },
      {
        find: "@openzhiyu/runtime-worker/jobs",
        replacement: alias("../../packages/runtime-worker/src/jobs.ts"),
      },
      {
        find: "@openzhiyu/runtime-worker/*",
        replacement: alias("../../packages/runtime-worker/src/*"),
      },
      {
        find: "@openzhiyu/runtime-worker",
        replacement: alias("../../packages/runtime-worker/src/index.ts"),
      },
      // i18n subpaths - must be before the shorter @openzhiyu/i18n alias
      {
        find: "@openzhiyu/i18n/locales",
        replacement: alias("../../packages/i18n/src/locales"),
      },
      {
        find: "@openzhiyu/i18n/*",
        replacement: alias("../../packages/i18n/src/*"),
      },
      {
        find: "@openzhiyu/i18n",
        replacement: alias("../../packages/i18n/src/index.ts"),
      },




      {
        find: "@openzhiyu/indexeddb/extractor",
        replacement: alias("../../packages/indexeddb/src/extractor.ts"),
      },
      {
        find: "@openzhiyu/indexeddb/*",
        replacement: alias("../../packages/indexeddb/src/*"),
      },
      {
        find: "@openzhiyu/indexeddb",
        replacement: alias("../../packages/indexeddb/src/index.ts"),
      },
      {
        find: "@openzhiyu/sqlite/*",
        replacement: alias("../../packages/sqlite/src/*"),
      },
      {
        find: "@openzhiyu/sqlite",
        replacement: alias("../../packages/sqlite/src/index.ts"),
      },

      {
        find: "@openzhiyu/shared/errors",
        replacement: alias("../../packages/shared/src/errors.ts"),
      },
      {
        find: "@openzhiyu/shared/ref",
        replacement: alias("../../packages/shared/src/ref.ts"),
      },
      {
        find: "@openzhiyu/shared/utils",
        replacement: alias("../../packages/shared/src/utils.ts"),
      },
      {
        find: "@openzhiyu/shared/soul",
        replacement: alias("../../packages/shared/src/soul.ts"),
      },
      {
        find: "@openzhiyu/shared/*",
        replacement: alias("../../packages/shared/src/*"),
      },
      {
        find: "@openzhiyu/shared",
        replacement: alias("../../packages/shared/src/index.ts"),
      },
      {
        find: "@openzhiyu/security/key-manager",
        replacement: alias("../../packages/security/src/key-manager.ts"),
      },
      {
        find: "@openzhiyu/security",
        replacement: alias("../../packages/security/src/index.ts"),
      },
      {
        find: "@openzhiyu/storage/adapters",
        replacement: alias("../../packages/storage/src/adapters"),
      },
      {
        find: "@openzhiyu/storage/adapters/local-fs",
        replacement: alias("../../packages/storage/src/adapters/local-fs.ts"),
      },
      {
        find: "@openzhiyu/storage/adapters/vercel-blob",
        replacement: alias(
          "../../packages/storage/src/adapters/vercel-blob.ts",
        ),
      },
      {
        find: "@openzhiyu/storage/*",
        replacement: alias("../../packages/storage/src/*"),
      },
      {
        find: "@openzhiyu/storage",
        replacement: alias("../../packages/storage/src/local.ts"),
      },


      // Telegram integrations (specific paths first, then general)































      {
        find: "@openzhiyu/agent",
        replacement: alias("../../packages/ai/src/agent/index.ts"),
      },
      {
        find: "@openzhiyu/insights",
        replacement: alias("../../packages/insights/src/index.ts"),
      },

      { find: "@", replacement: alias(".") },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    include: [
      "tests/unit/*.test.ts",
      "tests/api/*.test.ts",
      "tests/api/*.smoke.ts",
    ],
    exclude: ["node_modules", ".next", "out"],
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "lcov"],
      reportsDirectory: "./coverage/unit",
    },
  },
});
