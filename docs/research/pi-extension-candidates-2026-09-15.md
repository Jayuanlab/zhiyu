# Pi extension candidates for Zhiyu

Reviewed 2026-09-15. Static directory and source review only; nothing installed, enabled or benchmarked. These are community packages listed in Pi's directory, not automatically Pi-maintained components. Existing product boundaries and host authorization remain authoritative.

## Shortlist

| Candidate | Useful part | Suggested integration |
| --- | --- | --- |
| @bytetrue/pi-web-search | Multiple search providers and fetch diagnostics | First: selectively reuse providers behind Zhiyu's current search adapter |
| pi-web-research | Search, fetch, isolated reading, source-backed summaries | Second: evaluate as a research workflow inside an authorized workshop |
| pi-mcp-adapter | Lazy tool discovery, metadata cache, OAuth, lifecycle and status | Future MCP parity work; not immediate activation |
| @amaster.ai/pi-telemetry | Runtime event contracts and OTLP/Langfuse exporters | Reuse exporter layer if current observability lacks cross-stage traces |

## Search acquisition

The parent source investigation found @bytetrue/pi-web-search 0.4.0 with Bocha, Brave, Exa, Tavily, SearXNG, Jina, Firecrawl and Bing providers. The index exports createProvider and types but also imports Pi coding-agent ExtensionAPI. Search tool results identify the backend and attempted providers; large fetched output may spill to a temporary file. Zhiyu should preserve this diagnostic information and translate temporary paths into its own inspectable artifacts. Its current adapter already has Brave/DuckDuckGo, so adopt demonstrated gaps rather than another parallel search service. [Package source](https://github.com/ByteTrue/pi-package-mono/tree/main/packages/pi-web-search)

The parent source investigation found pi-web-research 1.0.1 separates search, fetch, tools and an isolated summarizer. Kagi/Wyna credentials are required for corresponding services. Comprehensive mode reads pages; default concise behavior is a search-result list and must not be represented as full-page research. Its workflow is a candidate for borrowing, not proof of superior research quality. [Source repository](https://github.com/wynainfo/pi-web-research)

## MCP

The directory describes proxy discovery instead of exposing every tool schema, lazy connections, metadata caching, direct-tool promotion, OAuth and supplied SDK configuration. Supplying config forms an isolated configuration snapshot rather than merging host files. [Directory](https://pi.dev/packages/pi-mcp-adapter)

Reviewed repository HEAD: 670bcfbab7de64b2c4f4ecfd7a4a89ae25088e1f. Its manifest is 2.33.0, MIT, and includes MCP client/core 2.0.0, schema validation, keyring and transport dependencies. The source exports createMcpAdapter plus status/approval contracts; its implementation depends on coding-agent ExtensionAPI, session lifecycle, tool registration and action methods. It is not a plain pi-agent-core plugin. [Manifest](https://github.com/nicobailon/pi-mcp-adapter/blob/670bcfbab7de64b2c4f4ecfd7a4a89ae25088e1f/package.json), [entry point](https://github.com/nicobailon/pi-mcp-adapter/blob/670bcfbab7de64b2c4f4ecfd7a4a89ae25088e1f/index.ts)

The parent verified Zhiyu currently explicitly disables Pi MCP/sandbox/external actions until migration parity. Therefore this package is a future implementation reference for configuration isolation, discovery and status, not a reason to enable arbitrary servers now. Host permissions must apply to the resolved underlying server/tool on every call, including proxy and scripting paths. Check cancellation, credentials, server cleanup and visible retry before rollout. [Current Pi adapter](../../apps/web/lib/ai/extensions/agent/pi/index.ts)

## Telemetry

The Pi directory lists @amaster.ai/pi-telemetry 0.1.15, Apache-2.0, with Langfuse and generic OpenTelemetry exporters. [Directory](https://pi.dev/packages/%40amaster.ai/pi-telemetry)

Reviewed repository HEAD: b137380136046547382cb8671c13de0b50876845. The fetched master manifest says 0.1.2-beta.15, which differs from the directory; do not assume this HEAD is the published release. Before adoption pin a release and inspect the matching tarball. Manifest exports root, config, langfuse, otel and extension subpaths; coding-agent is an optional peer. Root types define a publish/flush/close RuntimeEventExporter contract. Dependencies include pi-shared, Langfuse and OpenTelemetry SDK packages. [Manifest](https://github.com/TGYD-helige/pi/blob/b137380136046547382cb8671c13de0b50876845/packages/pi-telemetry/package.json), [contracts](https://github.com/TGYD-helige/pi/blob/b137380136046547382cb8671c13de0b50876845/packages/pi-telemetry/src/index.ts)

The otel module exports createTelemetryExporter, createOtelExporter and OtelRuntimeEventExporter. Configured payload inclusion defaults false; disabled export uses a no-op exporter. The coding-agent hook wrapper is separate. This offers a more plausible reuse boundary for Zhiyu core events than adopting the complete extension lifecycle. Map existing run/tool/model IDs and preserve application event storage; treat exported traces as observability, not business authority. Verify redaction and exporter outages before sending production data. [Exporter factory](https://github.com/TGYD-helige/pi/blob/b137380136046547382cb8671c13de0b50876845/packages/pi-telemetry/src/otel.ts), [hook wrapper](https://github.com/TGYD-helige/pi/blob/b137380136046547382cb8671c13de0b50876845/packages/pi-telemetry/src/extension.ts)

## Lower-priority alternative

@spences10/pi-telemetry provides local SQLite run/tool/provider metrics and eval correlation. Its create_telemetry_extension still returns an ExtensionAPI factory, and the inspected manifest requires Node >=24.15.0 plus three companion packages. It may inform test harness design, but adopting its own database/run schema is less attractive if Zhiyu already records these events. [Directory](https://pi.dev/packages/%40spences10/pi-telemetry), [source](https://github.com/spences10/my-pi/tree/main/packages/pi-telemetry)

## Decision rule

Reuse transport, provider and exporter implementations where they save verified work. Keep workshop ownership, Brain state, Loop scheduling, approval, original observations and desktop status in Zhiyu. No package here has been shown to be immediately installable into the current core-only runtime, nor has any benchmark established an accuracy or performance improvement.
