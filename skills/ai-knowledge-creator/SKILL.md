---
name: ai-knowledge-creator
description: Research, verify, produce, and review source-backed AI knowledge content for a recurring creator workflow. Use for AI topic discovery, short-video scripting, publishing drafts, and post-publication learning; do not use for unsourced trend summaries or unreviewed public posting.
---

# AI Knowledge Creator

Turn recent AI developments into accurate, useful Chinese short-video content.

## Working method

1. Search a bounded recent window and record each source's publisher, URL, publication time, observation time, and source type.
2. Prefer primary evidence: official announcements and documentation, original papers, model cards, release notes, and source repositories. Use secondary reporting to discover or contextualize a story, not as the sole support for a technical claim.
3. Compare candidates with recent workshop memory. Select one topic only when it is timely, useful to the intended audience, supported by evidence, and meaningfully different from recent output.
4. Separate verified facts, interpretation, and opinion. Preserve uncertainty and disagreements between sources.
5. Write for spoken Chinese: lead with the practical consequence, explain what changed, show who it matters to, and close with a concrete takeaway. Avoid exaggerated claims, fake urgency, fabricated metrics, and unsupported predictions.
6. Create a vertical-video production package with title, description, topics, concise captions, narration, scene plan, source list, and AI-content disclosure.
7. Render locally before creating a platform draft. A render without a real local video path is a failure, not a completed draft.
   Act as the director: decide the narrative, visual concept, shot order, pacing and palette from the story. Supply `shot` for each scene. Choose `generated` for video-model footage, `title` for a short typographic beat, or `graphic` for an explanatory diagram; do not repeat a prescribed sequence. Explain each shot's purpose in `rationale`. Generated prompts specify subject, action, camera, lighting and continuity; keep each generated shot's narration under 15 seconds. Choose `motion`, `transition`, `background`, `foreground` and `accent` intentionally. Only graphic shots require `onScreen` (`process`, `comparison`, `takeaway`); comparisons require explicit sides. Real-world claims still need sources: generated imagery is illustrative, never a real screenshot or documentary evidence. A failed video-model call must not silently become a mock shot. Inspect the actual render before calling it finished. Do not implement or use approval-feedback-driven style learning in this phase; publishing remains owner-reviewed.
8. Keep upload and public publishing behind owner review. Record review outcomes and verified audience feedback for later topic selection.

## Source and content boundaries

- Do not present a repost, rumor, benchmark screenshot, or unattributed social post as confirmed fact.
- Do not copy long passages or reuse third-party video, music, images, logos, or voices without confirmed permission.
- Do not expose API keys, private messages, personal data, unpublished project information, or paid content.
- If no candidate clears the evidence and novelty threshold, report that outcome and skip production.
- When sources fail, report incomplete coverage separately from an adequately checked window with no qualifying candidates. Preserve the source URL, method, observation time and failure reason; never infer that no news exists from failed requests. A successful official RSS fallback is an index for discovering articles, not proof that each linked article was read.
- Treat earlier runtime failures in memory as historical observations. Recheck current tool results before repeating claims about missing dependencies or unavailable sources.
- Never treat a prepared upload, command plan, or pending approval as a successful public post.
