# Jev: primary-source overview

Checked: 2026-09-22. This is documentation research, not a local model benchmark. No business code was changed.

## What it is

Jev is TypeSafe AI's first public System One model, announced on September 15, 2026. The company describes a new architecture, parallel sampling, and Reinforcement Learning for Calibrated Decisions (RLCD). These are vendor descriptions; the reviewed announcement does not disclose a reproducible architecture or training recipe. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

The interface takes state plus narrow questions and returns constrained decisions. Choice selects among supplied options; Score evaluates descriptive levels; Noul returns a yes/no probability. Choice and Score additionally return confidence derived from their probability distributions. Questions in a batch are evaluated independently against the same state. [Introduction](https://docs.typesafe.ai/introduction), [Confidence](https://docs.typesafe.ai/confidence)

System One is intended for fast, focused judgments within code-controlled workflows. Jev currently accepts text, including text represented as JSON. It does not generate prose, code, or reasoning explanations, and does not support image, audio, or video input. Calibration concerns groups of predictions and does not guarantee an individual answer is correct. [System One](https://docs.typesafe.ai/concepts/system-one), [AI primer](https://docs.typesafe.ai/introduction/machine-learning-primer)

## Claims and limits

The launch's 193.6x speed and 444.6x cost improvements refer to the company's workflow evaluation. The announcement says these may be near the upper end of real-world gains. Its reference answers use other models, and the workflows were built by its capabilities team. These are not established speedups for this project's memory pipeline. The claimed absence of hallucinations is grounded in schema-conforming output; it is not proof of factual correctness. [Launch announcement](https://typesafe.ai/blog/introducing-system-one-models-and-jev)

The official Jev 1.13 limitations page, reviewed by the vendor on September 17, explicitly lists literal interpretation, unreliable counting and date comparison, multi-hop indirection, irrelevant context, adversarial content, and inconsistent identities across separately phrased questions. It recommends arithmetic in code, focused state, and a generative model for generation. This directly rules out treating type safety as a correctness or prompt-injection guarantee. [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Papers, weights, and open code

No public Jev/RLCD technical paper or model-weight download was identified in the reviewed announcement, documentation index, or official GitHub organization. This is a bounded search result, not proof that none exists anywhere. Public SDKs, skills, and an LLM-backed interface adapter are visible; their availability does not mean Jev's weights or training implementation are open. The organization's LLaDA fork also does not establish that Jev uses a diffusion architecture. [Documentation index](https://docs.typesafe.ai/llms.txt), [official GitHub organization, linked from the docs](https://github.com/typesafe-ai)

## Related integration and memory project

The coordinating researcher verified Vercel's September 18 release note: AI Gateway exposes `typesafe-ai/jev` through AI SDK 7's `experimental_evaluate`, with Choice, Score, and Boolean operations. [Vercel release note](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway)

The coordinating researcher also checked the separate community project `jev-memory`: its author uses Jev for write, recall, and eviction gates while preserving stored text verbatim. It is not the official Jev model. Verbatim storage avoids rewriting text but does not establish that the input facts or gate decisions are correct. [Community repository](https://github.com/NicolasMontone/jev-memory)

## Relevance to this project (engineering inference)

Potential experiments are passage relevance, reranking, evidence sufficiency, and choosing whether to retrieve more context. These would complement retrieval and answer generation, not replace either. Official examples already cover passage classification and citation checking. Any claimed improvement to answer sufficiency must be tested against this project's unchanged evaluation set, with latency, false rejection, and fallback behavior measured. [RAG passage classification](https://docs.typesafe.ai/cookbooks/classifying_rag_passages), [citation checking](https://docs.typesafe.ai/cookbooks/citation_check)
