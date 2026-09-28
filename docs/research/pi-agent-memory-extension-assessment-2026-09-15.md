# pi-agent-memory integration assessment

Reviewed: 2026-09-15. User confirmed the package name `pi-agent-memory`. This is static source inspection, not an installation, benchmark, or production validation. No application code changed.

## Identity and baseline

The Pi directory lists version 0.3.4, author artemisai-dev, license AGPL-3.0, and links to ArtemisAI/pi-mem. Being listed in the official directory does not make it a Pi-maintained implementation. The similarly named jayzeng/pi-memory is a different Markdown/qmd extension. [Pi package listing](https://pi.dev/packages/pi-agent-memory)

`git ls-remote` resolved the reviewed repository HEAD to `6b0c958379c3e922a3ab25d156ab2530e878036b`. The package manifest declares the old `@mariozechner/pi-coding-agent` and `@mariozechner/pi-ai` peers, extensions and skills, and AGPL-3.0. This is not a drop-in package for Zhiyu's `@earendil-works/pi-agent-core` integration. The published tarball was not independently compared byte-for-byte. [Pinned manifest](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/pi-agent/package.json)

## What the extension actually does

The roughly 400-line extension is an HTTP adapter to a separate claude-mem worker, defaulting to localhost:37777. It initializes sessions before prompts, injects project context, submits tool observations, requests summaries at agent end, exposes memory_recall, and provides a status command. Project scope is an environment override or the working-directory basename with a prefix, not a user/workshop authorization model. Tool results are capped at 1,000 characters. Only memory_recall is excluded by the bridge itself. Observation POSTs are fire-and-forget without response-status checking or durable retries; awaited reads have timeouts. Failed memory_recall HTTP reads become the same no-match text used for empty results. These are bridge-level findings, not claims that the worker lacks persistence. [Pinned extension source](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/pi-agent/extensions/pi-mem.ts)

The worker applies configurable tool exclusions, prompt privacy checks and memory-tag stripping before queuing observations. It starts a background agent to consume the queue. Some observation-storage failures return HTTP 200 with a failure payload, which the fire-and-forget bridge does not inspect. [Session routes](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/src/services/worker/http/routes/SessionRoutes.ts)

Model responses are parsed into observations and session summaries, written in a database transaction, and then confirmed against the processing queue. Chroma indexing runs asynchronously and can fail independently. This is an actual extraction pipeline, not simply a tool that writes a string. [Response processor](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/src/services/worker/agents/ResponseProcessor.ts)

The database defines durable pending messages with processing state and retry counters, plus session, observation and summary storage. This is useful worker-side recovery; it does not cover a request lost before reaching the worker. [Session store](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/src/services/sqlite/SessionStore.ts)

The actual unified search route calls SearchManager.search. Its inspected implementation uses direct SQLite for filter-only requests and Chroma for text queries. Missing Chroma yields a semantic-search-unavailable response; zero Chroma matches explicitly do not trigger an FTS5 fallback. Therefore README claims about hybrid search must not be presented as an unconditional functioning fallback. [Search routes](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/src/services/worker/http/routes/SearchRoutes.ts), [Search implementation](https://github.com/ArtemisAI/pi-mem/blob/6b0c958379c3e922a3ab25d156ab2530e878036b/src/services/worker/SearchManager.ts)

## Decision for Zhiyu

Recommendation: evolve the existing shared Brain service and its thin Pi/Claude tools. Do not replace it with this standalone extension backend merely to gain memory.

The parent investigation verified that existing Brain policies already handle user and owner scopes, permissions and expiry; review operations exist; both runtimes use the shared memory/context path; workshop execution already injects Brain context and records selection/error evidence. Workshop memory writes pass host guards, persist data, mirror into Brain, and record an event. These are existing integration assets, not proposed new features. See [Brain policy](../../apps/web/lib/brain/policy.ts), [memory review](../../apps/web/lib/brain/memory-review.ts), and [workshop executor](../../apps/web/lib/workshops/executor.ts).

Directly adopting the extension would require adapting its coding-agent hooks, translating business scopes, aligning user correction/deletion across stores, and exposing worker health in the desktop UI. Unless configured otherwise, existing memory-read tools could be recaptured as fresh observations, producing duplicated derived evidence. Automatic capture should preserve original event IDs and explicitly distinguish retrieved memory from new facts.

Borrow the proven ideas where gaps are demonstrated: asynchronous extraction from durable observations, compact recall followed by detail reads, lifecycle summaries, and recovery-aware processing. Keep authorization, provenance, correction, expiry and authoritative storage in Brain. If claude-mem's extraction/search is later evaluated, place it behind a controlled provider boundary with visible degradation and deletion propagation, rather than allow a second uncontrolled memory source.

Before any implementation, compare current Brain behavior with a candidate on the same desktop tasks: useful recall, cross-workshop isolation, denied access, repeated observations, correction propagation, expired facts, worker outage, retry duplication and visible recovery. These remain proposed checks; no runtime quality claim follows from this source review.
