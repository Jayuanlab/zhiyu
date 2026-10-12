/** Offline regression using the original failed run and unchanged candidates.
 * No database, provider, new read, production event or business submission. */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseGroundedResearchFinalJson } from "../lib/workshops/grounded-final-json";
import { selectWorkshopResearchQuotes, resolveWorkshopResearchQuoteRefs } from "../lib/workshops/research-quote-selection";
import { verifyAndBuildGroundedResearchReport, type GroundedResearchSnapshot } from "../lib/workshops/grounded-research-report";
import type { WorkshopResearchEvidenceEvent } from "../lib/workshops/research-evidence-verification";

const folder = "../../docs/verification/artifacts/deepseek-report-rerun-2026-10-09/";
const runId = "932aae63-2b4c-8813-a763-9384865a506b";
const observed = JSON.parse(await readFile(`${folder}run-${runId}-latest.json`, "utf8"));
assert.equal(observed.databaseReadOnly, true);
assert.equal(observed.run.status, "failed");
const candidateBytes = await readFile(`${folder}candidate-${runId}-2.txt`, "utf8");
const candidate = parseGroundedResearchFinalJson(candidateBytes) as {
  researchEvidence: { reportVersion: string; works: Array<{ sourceId: string; supportedClaims: Array<{
    kind: string; claim: string; locator: string; quote: string; evidenceEventId: string;
  }> }>; gaps: string[] };
};
assert(candidate);
const context = observed.captured.pinnedResearchContext;
const coverage = observed.derivedVerification.coverage;
const events: WorkshopResearchEvidenceEvent[] = observed.pages.flatMap((page: any) => page.windows.map((window: any) => ({
  id: window.eventId, runId, type: "source_checked", metadata: { receiptAuthority: "runtime", toolName: "webReadPage",
    method: "jina_defuddle", ok: true, url: page.url, finalUrl: page.url, evidenceId: page.evidenceId,
    contentHash: page.contentHash, ...window },
})));
const scope = createHash("sha256").update(`workshop:${observed.workId}`).digest("hex");
const snapshots: GroundedResearchSnapshot[] = [];
for (const source of coverage) {
  const snapshot = JSON.parse(await readFile(`.data/web-read-evidence/${scope}/${source.evidenceId}/snapshot.json`, "utf8"));
  snapshots.push({ ...snapshot, sourceId: source.sourceId });
}
const selections = [];
const works = [];
for (const work of candidate.researchEvidence.works) {
  const source = coverage.find((value: any) => value.sourceId === work.sourceId);
  assert(source);
  const selected = await selectWorkshopResearchQuotes({ ...context, workshopId: observed.workId, runId, events,
    url: source.urls[0], evidenceId: source.evidenceId,
    queries: work.supportedClaims.map(claim => ({ text: claim.quote.slice(0, 60) })),
  });
  selections.push(selected);
  const selectionEventId = `offline-fixture-selection-${work.sourceId}`;
  events.push({ id: selectionEventId, runId, type: "research_quote_selected", metadata: {
    ...selected, workshopId: observed.workId, receiptAuthority: "runtime", toolName: "webReadPage", offlineFixture: true,
  } });
  works.push({ sourceId: work.sourceId, supportedClaims: work.supportedClaims.map((claim, queryIndex) => ({
    kind: claim.kind, claim: claim.claim, locator: claim.locator,
    quoteRef: { selectionEventId, index: selected.candidates.findIndex(value => value.queryIndex === queryIndex) },
  })) });
}
const refReport = { researchEvidence: { ...candidate.researchEvidence, works } };
const resolved = resolveWorkshopResearchQuoteRefs(refReport, { workshopId: observed.workId, runId, events, snapshots, coverage });
const checked = resolved.ok ? verifyAndBuildGroundedResearchReport({ report: resolved.report, runId, events, snapshots, coverage }) : resolved;
assert.equal(checked.ok, false, "selection_must_not_approve_unchanged_bad_claims");
assert.equal(await readFile(`${folder}candidate-${runId}-2.txt`, "utf8"), candidateBytes);
const receipt = { at: new Date().toISOString(), runId, offlineFixture: true, productionMutation: false, modelCalls: 0,
  selected: selections.map(selection => ({ sourceId: selection.sourceId, count: selection.candidates.length,
    gaps: selection.gaps, candidates: selection.candidates })),
  resolved: resolved.ok, originalClaimGate: { ok: checked.ok, issues: checked.issues },
  originalCandidateUnchanged: true,
};
await writeFile(folder + "quote-protocol-real-source-review53.json", JSON.stringify(receipt, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ resolved: receipt.resolved, selections: receipt.selected.map(value => ({ sourceId: value.sourceId, count: value.count, gaps: value.gaps })),
  originalClaimsAccepted: receipt.originalClaimGate.ok, originalCandidateUnchanged: true, productionMutation: false }));
