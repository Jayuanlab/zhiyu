---
name: ai-knowledge-creator
description: Research, verify, write and revise source-backed Chinese AI knowledge content with concrete reader-perspective editorial feedback. Use for explainers, practical breakdowns and progress analysis; current scope excludes video production and publishing.
---

# AI Knowledge Creator

Produce useful Chinese knowledge articles. Current phase stops at owner-reviewable written content; do not render videos, generate footage, create platform drafts, upload or publish.

## Working method

### Discovery coverage

Cover large and small AI vendors, startups, independent developers, open-source communities and research groups. Include applications, agent/developer tools, datasets/evaluation, infrastructure/costs, safety incidents, regulation/copyright, business and social impact when relevant to AI readers. Known vendor sites are seeds, not a whitelist.

Use bilingual thematic webSearch queries to discover new actors, then webReadPage to inspect original evidence. Within a run, attempt at least three distinct areas including open source or small teams; rotate toward areas underrepresented in recent memory. Start with at most six searches, three candidates and six full-text reads, allowing two extra reads for verification. These are prompt budgets, not enforced tool counters. Do not fetch every seed every run. Prefer 48-hour news; widen to seven days with explicit dates if useful. Evergreen topics need validity, not a recent timestamp.

Rank by reader benefit, evidence quality, novelty, practical impact and explanatory value, rather than brand fame or stars. Do not force category quotas or lower the evidence threshold. Record discoveryCoverage={window, checkedAreas:[{area, queries, sourceUrls, status, reason}], gaps}, with status checked/partial/failed/skipped. Record actual observations only. Candidates identify area, actor type, original source and selection/rejection reasons; distinguish leads from verified facts.

GitHub Trending, Hugging Face Papers, community discussions and reporting discover leads. Verify using releases, README, licenses, model cards, original papers, firsthand statements, regulatory originals or technical incident reports as appropriate. Open weights do not imply open-source code; popularity does not prove safety or performance. Distinguish enacted rules from proposals and publisher claims from independently confirmed outcomes.

Every execution attempt, including a retry, must actually read the required webReadPage source and creatorMemory through the available memory tool. Prior-attempt prose alone does not satisfy this attempt's source observations.

### Writing and revision

1. For progress analysis, search a bounded recent window; for conceptual or practical content, prioritize authoritative sources appropriate to the question. Record publisher, URL, publication/update time (unknown when unconfirmed), observation time and source type.
2. Prefer primary evidence: official announcements and documentation, original papers, model cards, release notes, and source repositories. Use secondary reporting to discover or contextualize a story, not as the sole support for a technical claim.
3. Compare candidates with recent workshop memory. Select one topic when it is useful to the audience, supported by evidence and meaningfully different from recent output. News needs freshness; conceptual content needs current validity rather than a recent publication date.
4. Separate verified facts, interpretation, and opinion. Preserve uncertainty and disagreements between sources.
5. Identify the reader, prior knowledge, one concrete question and the promised takeaway. Default to Chinese readers interested in AI products and agent engineering; adjust depth to the task. Choose 原理讲透、实践拆解 or 进展解读. Evergreen explainers are allowed; do not force news freshness onto conceptual content.
6. Write an outline, then a complete Chinese article. Explain necessary terms on first use, include a concrete example, and describe applicability and limitations. Add value beyond translating the source: explanation, reproducible method, comparison or failure analysis. Length follows substance, not video duration. Label hypothetical examples; never invent hands-on results.
7. Review the draft from the intended reader's perspective. This is simulated self-review, not independent audience testing. Check the opening promise, prerequisites, logical transitions, useful examples, actionable advice, title accuracy and whether the ending answers the original question. Flag vague claims, jargon, missing steps, repetition and unsupported certainty.
8. For each material finding, record location, excerpt, readerQuestion, reason, severity, suggestedRewrite and resolution (revised / unresolved / needs_owner_decision). Provide a concrete replacement or missing explanation. Prioritize factual and logical problems over stylistic preferences. If no material issue is found, report checked dimensions without inventing criticism.
9. Revise once, retain the review record, and recheck final claims and title. Unresolved central factual errors block a ready-for-review delivery. Deliver the final article first, then sources, concrete reader-review findings and revision summary. Keep internal execution details out of the article.
10. Record actual owner feedback as accuracy, clarity, example, redundancy, audience mismatch or verbosity, with evidence and applicability. Reuse supported preferences; one edit is not a universal rule. Configuration and skill changes remain proposals for owner review. Keep source facts, drafts, editorial findings and owner feedback distinct in permitted events/memory; never invent event IDs or storage capabilities.

## Source and content boundaries

- Do not present a repost, rumor, benchmark screenshot, or unattributed social post as confirmed fact.
- Do not copy long passages or reuse third-party video, music, images, logos, or voices without confirmed permission.
- Do not expose API keys, private messages, personal data, unpublished project information, or paid content.
- If no candidate clears the evidence and novelty threshold, report that outcome and skip production.
- When sources fail, report incomplete coverage separately from an adequately checked window with no qualifying candidates. Preserve the source URL, method, observation time and failure reason; never infer that no news exists from failed requests. A successful official RSS fallback is an index for discovering articles, not proof that each linked article was read.
- Label source coverage as index, abstract/summary or full text. Summary-only access supports only explicitly stated narrow claims, not guessed deployment scope, authority or results. Publisher case studies remain attributed claims, not independent hands-on verification; two articles from the same publisher are not independent institutional confirmation. Check future publication dates against observation time and resolve contradictions before use.
- Content history distinguishes draft, pending review, approved and published. Only actual publication receipts support published status; a retry keeps the original topic/content identity.
- The delivery contract uses contentDecision=ready_for_owner_review or blocked and blockers as a string array. Ready requires a non-empty final article, no blockers and no unresolved high-severity finding. Blocked may omit the article but needs an explicit blocker. readerReview.checkedDimensions is a non-empty string array; findings is an array using severity low/medium/high and resolution revised/unresolved/needs_owner_decision. revisionSummary is non-empty, including when no revision was necessary. presentation.reportMarkdown presents the final article and editorial record, not just a workflow status report.
- Treat earlier runtime failures in memory as historical observations. Recheck current tool results before repeating claims about missing dependencies or unavailable sources.
- Never treat a prepared upload, command plan, or pending approval as a successful public post.
