import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertAuthBinding } from "./scripts/auth-bind-policy.mjs";
import { AtomicDevelopmentAssetsPlugin } from "./scripts/atomic-development-assets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const weixinLoggerShimPath = path.resolve(
  __dirname,
  "lib/weixin/openclaw-shims/logger.ts",
);
const weixinRedactShimPath = path.resolve(
  __dirname,
  "lib/weixin/openclaw-shims/redact.ts",
);

const nextConfig = {
  // Review builds use an isolated output directory while the current server stays up.
  distDir: /^\d{2}$/.test(process.env.ZHIYU_REVIEW_BUILD ?? "")
    ? `.tmp/next-review-${process.env.ZHIYU_REVIEW_BUILD}` : ".next",
  // Performance optimization option
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1"],

  // Include @tencent-weixin/openclaw-weixin TypeScript source (src/cdn/, src/api/types.ts)
  // in Next.js SWC compilation so we can directly import its CDN utility modules and protocol types
  transpilePackages: [
    "@openzhiyu/shared",
    "@openzhiyu/indexeddb",
    "@openzhiyu/sqlite",
    "@openzhiyu/insights",
    "@openzhiyu/ai",
    "@openzhiyu/hooks",
    "@openzhiyu/mcp",
    "@openzhiyu/runtime-api",
    "@openzhiyu/runtime-worker",
    "@openzhiyu/search",
    "@openzhiyu/search/brave",
    "@openzhiyu/ai/agent/sandbox",
    "@openzhiyu/ai/agent/sandbox/types",
    "@openzhiyu/ai/agent/sandbox/plugin",
    "@openzhiyu/ai/agent/sandbox/registry",
    "@openzhiyu/ai/agent/sandbox/providers/native",
    "@openzhiyu/ai/agent/sandbox/providers/claude",
    "@openzhiyu/ai/agent/sandbox/providers/vercel",
  ],

  // Output mode: Tauri production builds need standalone mode to support API routes
  // Note: Dev mode should not use standalone because `next dev` serves from source files directly
  // Only enable standalone output for production builds (NODE_ENV=production)
  output:
    process.env.IS_TAURI === "true" && process.env.NODE_ENV === "production"
      ? "standalone"
      : undefined,

  // Exclude files that don't need tracing (WhatsApp/Telegram session directories)
  // Also exclude Windows user profile paths to avoid EPERM on protected directories
  // Note: use "*" key to apply to all routes, and forward-slash globs for cross-platform compatibility
  outputFileTracingExcludes: {
    "*": [
      "**/.wwebjs_auth/**",
      "**/AppData/**",
      "**/Application Data/**",
      "**/AzureFunctionsTools/**",
      "**/cli_x64/**",
      // Exclude the cli_x64 directory entry itself (not just its contents)
      // Without this, "**/cli_x64/**" matches files inside but not the directory node,
      // which then leaks into the copy list with its absolute path on Windows
      "**/cli_x64",
      // Exclude Rust toolchain and related Windows SDK paths that leak in via native module tracing
      "**/.rustup/**",
      "**/.cargo/**",
      "**/stable-x86_64-pc-windows-msvc/**",
    ],
  },
  // sqlite-vec selects its native binary dynamically, which Next's static
  // tracer cannot discover reliably. Include the JS loader and whichever
  // platform package is installed for the current build machine.
  outputFileTracingIncludes: {
    "*": [
      "../../node_modules/sqlite-vec/**/*",
      "../../node_modules/sqlite-vec-darwin-arm64/**/*",
      "../../node_modules/sqlite-vec-darwin-x64/**/*",
      "../../node_modules/sqlite-vec-linux-arm64/**/*",
      "../../node_modules/sqlite-vec-linux-x64/**/*",
      "../../node_modules/sqlite-vec-windows-x64/**/*",
    ],
  },

  productionBrowserSourceMaps: false,

  // Skip type checking during development (controlled via environment variable)
  typescript: {
    // ⚠️ Only skip when SKIP_TYPE_CHECK=true, production builds still check
    ignoreBuildErrors: process.env.SKIP_TYPE_CHECK === "true",
  },

  // Serverless external package configuration - for packages like puppeteer, better-sqlite3 that need native modules
  // Note: bufferutil and utf-8-validate are optional dependencies of ws, no need to declare them here
  serverExternalPackages: [
    "@larksuiteoapi/node-sdk",
    "better-sqlite3",
    // sqlite-vec resolves and loads a platform-specific native extension at
    // runtime. Bundling it rewrites import.meta.resolve under Turbopack.
    "sqlite-vec",
    "sqlite-vec-darwin-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-arm64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-windows-x64",
    "bindings", // better-sqlite3 dependency
    "prebuild-install", // better-sqlite3 dependency
    "@photon-ai/imessage-kit",
    "@earendil-works/pi-coding-agent",
    "puppeteer",
    "puppeteer-core",
    "playwright",
    "playwright-core",
    "rimraf",
    "jszip",
    "xlsx",
    "pdf-parse",
    "mammoth",
    "chromadb",
    "@chroma-core/default-embed",
    "@chroma-core/ai-embeddings-common",
    "@huggingface/transformers",
    "pdfjs-dist",
    "officeparser",
    "discord.js",
    "zlib-sync",
    "thread-stream",
    "pino",
    "ws",
    // Baileys v7 media processing (audio-decode pulls in @eshaz/web-worker which uses dynamic import)
    "audio-decode",
    "@wasm-audio-decoders/common",
    "@wasm-audio-decoders/flac",
    "@eshaz/web-worker",
    "@eshaz/web-core",
    // ioredis-mock uses fengari (Lua interpreter) which requires dynamic imports
    "ioredis-mock",
    "fengari",
    "fengari-web",
  ],

  // Experimental features - performance improvements
  experimental: {
    // Support max 100MB request body (for large file uploads)
    proxyClientMaxBodySize: "100mb",
    // Optimize bundle size
    optimizePackageImports: [
      "@radix-ui/react-icons",
      "react-icons",
      "framer-motion",
      // AI related packages imported on demand
      "@ai-sdk/react",
      "langchain",
      "openai",
      // Newly added optimizations
      "ai",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-select",
      "@radix-ui/react-tooltip",
      "react-markdown",
      "date-fns",
      // Large SDKs - dynamic imports
      "stripe",
      "@anthropic-ai/sdk",
      "recharts",
    ],
  },

  // Turbopack path alias: fixes build failures due to missing util files in upstream packages
  turbopack: {
    resolveAlias: {
      "@tencent-weixin/openclaw-weixin/src/util/logger.js":
        weixinLoggerShimPath,
      "@tencent-weixin/openclaw-weixin/src/util/redact.js":
        weixinRedactShimPath,
    },
  },

  images: {
    // Disable Next.js image optimization to avoid image loading issues in standalone mode
    // Set minimum cache TTL to 7 days
    minimumCacheTTL: 604800,
    // Only disable optimization for Tauri builds
    unoptimized: process.env.IS_TAURI === "true",
    remotePatterns: [
      {
        hostname: "avatar.vercel.sh",
      },
      {
        hostname: "camo.githubusercontent.com",
      },
      {
        hostname: "links.haoyou.tech",
      },
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },

  webpack: (config, { isServer }) => {
    // Keep the large dev compilation cache out of the Node heap. The cache
    // directory is inside the workspace, so it avoids Windows profile EPERM
    // issues while preventing next dev from ballooning to multi-GB memory use.
    if (process.env.NODE_ENV === "development") {
      if (!isServer) config.plugins.push(new AtomicDevelopmentAssetsPlugin());
      config.cache = {
        type: "filesystem",
        cacheDirectory: path.resolve(__dirname, nextConfig.distDir, "cache/webpack"),
      };
    }

    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      "@tencent-weixin/openclaw-weixin/src/util/logger.js":
        weixinLoggerShimPath,
      "@tencent-weixin/openclaw-weixin/src/util/redact.js":
        weixinRedactShimPath,
    };

    // Sentry source maps upload in production
    if (
      process.env.SENTRY_AUTH_TOKEN &&
      process.env.NODE_ENV === "production" &&
      !isServer
    ) {
      const SentryWebpackPlugin = require("@sentry/webpack-plugin");
      config.plugins.push(
        new SentryWebpackPlugin({
          org: process.env.SENTRY_ORG,
          project: process.env.SENTRY_PROJECT,
          authToken: process.env.SENTRY_AUTH_TOKEN,
          include: "./.next/static",
          ignore: ["node_modules"],
          setCommits: { auto: true },
        }),
      );
    }

    if (isServer) {
      config.externals = config.externals ?? [];
      config.externals.push({
        "thread-stream/test": "commonjs empty",
      });
      config.ignoreWarnings = [
        {
          module: /fluent-ffmpeg/,
          message: /the request of a dependency is an expression/,
        },
        {
          module: /thread-stream\/test/,
          message: /./,
        },
        // Ignore warnings about ws optional dependencies that can't be externalized (bufferutil, utf-8-validate)
        {
          module: /ws/,
          message: /can't be external/,
        },
        // Ignore warnings about bufferutil and utf-8-validate that can't be resolved
        {
          module: /bufferutil/,
          message: /can't be external/,
        },
        {
          module: /utf-8-validate/,
          message: /can't be external/,
        },
      ];
    } else {
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = config.resolve.fallback ?? {};
      config.resolve.fallback["zlib-sync"] = false;
      config.resolve.fallback["thread-stream"] = false;
      config.resolve.fallback["audio-decode"] = false;
      config.resolve.fallback["@eshaz/web-worker"] = false;
      config.resolve.fallback["@wasm-audio-decoders/common"] = false;
      config.resolve.fallback["@wasm-audio-decoders/flac"] = false;
    }

    // Ignore ws optional native dependencies (skip when not installed)
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...config.resolve.alias,
      bufferutil: false,
      "utf-8-validate": false,
    };

    config.module.rules.forEach((rule) => {
      if (
        rule.test &&
        (rule.test.toString().includes("jsx") ||
          rule.test.toString().includes("tsx") ||
          rule.test.toString().includes("js") ||
          rule.test.toString().includes("ts"))
      ) {
        rule.exclude = [...(rule.exclude || []), /marketing/];
      }
    });

    return config;
  },
};

// Security headers for all routes
const securityHeaders = [
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  {
    key: "Content-Security-Policy",
    value:
      "default-src 'self'; script-src 'self' 'unsafe-eval' 'unsafe-inline' tauri: https://d3js.org https://unpkg.com https://cdn.tailwindcss.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.tailwindcss.com; img-src 'self' data: https: http: blob:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: http: wss: tauri: ipca: https://unpkg.com https://cdn.tailwindcss.com https://fonts.googleapis.com; frame-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
  },
];

const configuredNext = {
  ...nextConfig,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
      ...(process.env.NODE_ENV === "development" ? [{
        // Dev chunks keep stable URLs while their contents are replaced. Avoid
        // concurrent Chromium cache writes when multiple tabs load a large chunk.
        source: "/_next/static/:path*",
        headers: [{key: "Cache-Control", value: "no-store, max-age=0"}],
      }] : []),
    ];
  },
};

export default function configure(phase) {
  if (["phase-development-server", "phase-production-server"].includes(phase)) {
    assertAuthBinding(process.env.AUTH_MODE, process.argv);
  }
  return configuredNext;
}
