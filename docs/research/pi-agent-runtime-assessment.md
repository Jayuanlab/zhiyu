# Pi agent runtime assessment

Checked: 2026-09-06. Scope: current official upstream documentation, not a tested migration or a benchmark. The historical `badlogic/pi-mono` links currently redirect to `earendil-works/pi`; current main examples use `@earendil-works/*`. A concrete implementation must pin and inspect a released package version rather than assume older `@mariozechner/*` examples still match.

## Verified capabilities

| Layer | Current documented responsibility | Implication |
| --- | --- | --- |
| `pi-ai` | Provider/model abstraction, streaming, tool schemas, serializable conversation context; Anthropic, OpenAI, Google, DeepSeek, Moonshot, MiniMax, OpenRouter and OpenAI-compatible services are among supported providers. | Enables provider choice, but provider support is not proof of equal model quality, reliability, or cost. |
| `pi-agent-core` | Stateful model/tool loop with event streaming, custom message conversion, context transformation, cancellation, steering, follow-ups, and programmable tool execution. | Suitable as an execution component beneath an application-owned business controller. |
| `pi-coding-agent` | Embeddable session SDK and coding application with resource discovery, built-in tools, compaction, retries, and session management. | Faster route when migrating an existing coding-agent-style harness; more defaults to control. |

Sources: [pi-ai README](https://github.com/earendil-works/pi/blob/main/packages/ai/README.md), [agent core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md), [coding-agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

Agent core currently documents `beforeToolCall` for blocking and `afterToolCall` for result processing. Parallel tool execution is the default; sequential execution can be required globally or by a tool. `shouldStopAfterTurn` stops after a completed turn. `Agent.subscribe()` awaits listeners; low-level loop streams are observational and do not await asynchronous consumers as barriers. A separate SQLite session backend package exists; do not describe current core as simply lacking all persistence facilities. [Agent core README](https://github.com/earendil-works/pi/blob/main/packages/agent/README.md)

The coding SDK provides persistent and in-memory `SessionManager` options, continuing/opening sessions, tree branches, and restoring externally stored entries. `createAgentSession()` supports custom tools and selectable built-ins. Defaults include read, bash, edit, and write; `noTools: "builtin"` disables default built-ins while preserving custom/extension tools. `excludeTools` is applied after the tool allowlist. Default resource loading discovers extensions and configuration, so a production integration needs deliberate resource ownership. [Coding-agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)

Pi explicitly omits built-in MCP, subagents, and permission popups. These can be supplied through extensions or application code. Its extension interface exposes tool registration and lifecycle events; packages execute with system access. This is a customization surface, not a ready-made business authorization or operating-system isolation boundary. [Coding-agent README](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md)

Claude Agent SDK already integrates tools, hooks, subagents, MCP, permissions and resumable/forkable sessions. Replacing it means deciding which integrated behaviors to preserve and testing equivalents, not merely changing the model request API. [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)

Claude's `allowedTools` grants automatic approval and is not by itself an exclusive tool inventory. Current permission documentation distinguishes whole-tool denies (remove the definition) from pattern denies (block matching calls), and recommends `PreToolUse` when every call must be gated regardless of earlier permission resolution. Preserve the application's own deny-first policy independently of backend-specific options. [Claude permissions](https://code.claude.com/docs/en/agent-sdk/permissions)

## Engineering judgment for long-running business agents

Inference: Pi is a reasonable strategic option when model portability and direct ownership of the tool loop are actual requirements. It is not evidence that simply replacing Claude SDK will improve reasoning, lower total cost, or solve durable workflow recovery. No comparative benchmark was conducted here.

Keep the controlled object, fresh observations, immutable source events, structured business state, schedule, heartbeat, approvals, action deduplication, audit trail, and recovery logic in Zhiyu. An LLM transcript or provider session ID must not become the authoritative order, memory, outbox, or Loop state.

Evaluate two adapters: agent core for an application-owned controller, and coding-agent SDK when retained session/compaction functionality materially reduces work. Keep a Claude adapter available during rollout. Translate runtime events into a stable application event contract and record runtime/provider/model plus explicit failure and degradation details.

Start with a read-only workshop workload. Compare same-model runs first to isolate harness behavior. Require tests for deny precedence, absent unauthorized tools, stale observations, cancellation, crash/restart, duplicate actions, and approval resume. Side-effecting tools should pass through the existing domain guard and idempotency layer; selecting sequential execution alone cannot guarantee safety. Expose last run, next wakeup, heartbeat, pending approval and failure reason. Roll back by selecting the previous adapter for new runs while retaining business state and historical transcripts.

These recommendations apply the repository's [engineering principles](../architecture/engineering-cybernetics-guiding-principles.md); they are a proposed migration boundary, not claims that either SDK supplies the complete control system.
