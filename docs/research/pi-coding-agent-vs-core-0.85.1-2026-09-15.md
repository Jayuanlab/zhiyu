# Pi coding-agent versus agent-core at 0.85.1

Reviewed 2026-09-15 against release commit d981de1229ef899957bbe968bc8dcda02a21f477. This supersedes any earlier simplified statement that core has only a model/tool loop while persistence, tools, skills, retry and compaction exist exclusively in coding-agent. No installation or runtime benchmark was performed.

## Three distinct surfaces

1. Zhiyu currently instantiates the low-level Agent for each adapter run. The parent verified no AgentHarness/createAgentSession use in the inspected runtime paths. Host services provide Brain injection and context budgeting/compaction.
2. The full agent-core package exports substantially more than Agent: AgentHarness, session repositories/storage, compaction and branch summary machinery, skills/templates, tool factories and telemetry contracts.
3. coding-agent supplies an assembled coding-oriented host, ExtensionAPI runtime, Node defaults, resource discovery, settings/model authentication and user-facing execution modes. Its SDK factory currently constructs Agent plus AgentSession; it is not simply a rename of core AgentHarness.

Sources: [local adapter](../../packages/ai/src/agent/runtime/pi-agent-adapter.ts), [core exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/index.ts), [coding SDK factory](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts).

## Capability matrix

| Area | Full agent-core 0.85.1 | coding-agent 0.85.1 integration |
| --- | --- | --- |
| Model/tool loop | Agent, streaming, cancellation, queueing, tools | AgentSession combines these with host lifecycle and commands |
| Extensions | Harness hooks and host-supplied components; not the same public ExtensionAPI | Discover/load extensions, ExtensionRunner, tools, commands, shortcuts, flags, UI and provider/session hooks |
| File/shell tools | Read/write/edit/bash factories depend on execution context interfaces | Ready local Node operations, coding/read-only tool sets, grep/find/ls/PowerShell factories and rendering helpers |
| Resource discovery | Skill/template/system-prompt primitives | DefaultResourceLoader discovers package/project/global extensions, skills, templates, themes and AGENTS/CLAUDE context |
| Sessions | StorageBackedSession, MemorySessionRepo, JsonlSessionRepo, commits and fork primitives | SessionManager defaults and AgentSessionRuntime new/resume/fork/import operations |
| Compaction/retry | AgentHarness implements threshold/overflow compaction and retry transitions | AgentSession exposes integrated compaction/retry controls and events, driven by SettingsManager |
| Models/auth/settings | Model abstractions and configurable harness/model policies | ModelRuntime/registry, credential integration, settings files, model restoration and thinking-level selection |
| User interface | Host-neutral runtime objects/events | Terminal UI, print/JSON, RPC, selectors, themes, command expansion and editor components |

The coding-agent export surface verifies the assembled modules and execution modes; presence does not establish that every module is needed by Zhiyu. [Coding-agent exports](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/index.ts)

## Core capabilities are implemented, not merely names

Core session exports include JsonlSessionRepo, MemorySessionRepo and StorageBackedSession plus commit and fork operations. Core tool factories expose read/write/edit/bash using the ExecutionToolContext abstractions. Consequently persistence and basic coding tools are not exclusive reasons to migrate. [Sessions](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/session/index.ts), [tools](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/tools/index.ts), [execution interfaces](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/types.ts)

In the core drive implementation, checkpoint handling calls prepareCompactionThreshold and moves into summary work when necessary. Response handling schedules exponential retries for retryable failures and prepares one overflow compaction recovery when eligible. Structural handling runs compaction and summary retry processing. These were verified in executable control flow, not inferred only from exported types. [Checkpoint](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/checkpoint.ts), [response](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/response.ts), [structural operations](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/runtime/drive/structural.ts)

AgentHarness also has a distinct lane/operation/suspension model. Its API contains development-stage/error surfaces, so no claim of production maturity or full parity follows from this inspection. [Harness contract](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/agent/src/harness/agent-harness.ts)

## What the coding SDK lets a host customize

createAgentSession accepts cwd, agentDir, ModelRuntime/model, thinking level, tool allowlist, denylist, custom tools, ResourceLoader, SessionManager and SettingsManager. Default tools are read/bash/edit/write unless settings change them. noTools: builtin disables defaults while retaining extension/custom tools; noTools: all starts without enabled tools if no explicit allowlist is supplied. An explicit tools list selects only those names, and excludeTools applies afterward. Disabling tools is not equivalent to preventing extension code loading or OS access. [Factory options and selection logic](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/sdk.ts)

A custom ResourceLoader can replace discovery entirely. DefaultResourceLoader supports noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles, explicit extensionFactories, added paths and content overrides. Context discovery checks AGENTS.override.md, AGENTS.md and CLAUDE.md variants up directory ancestry. Thus adopting the SDK does not require accepting arbitrary project/global resources, but the host must explicitly configure discovery and trust. [Resource loader](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/resource-loader.ts)

The SDK is importable in-process; a CLI subprocess is not required. AgentSessionRuntime owns replacement operations. After replacement, the consumer must subscribe to the new session and rebind extension UI/actions as needed. Terminal-oriented extension UIs do not automatically become a desktop Web interface. [SDK guide](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/sdk.md)

## Implication for Zhiyu

The largest distinctive reason to consider coding-agent is reuse of the Pi extension/resource host and its assembled coding-session experience. For session persistence, retries, compaction and tools, first compare using more of the installed core package against adopting the higher-level host. Either path requires mapping Zhiyu identity, permissions, Brain, events, cancellation, source diagnostics and desktop feedback. Installing coding-agent does not supply workshop governance, a Loop scheduler or business memory ownership.
