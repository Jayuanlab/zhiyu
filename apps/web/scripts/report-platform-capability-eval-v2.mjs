/** Offline reporting only; does not load credentials, call a model, or alter original result files. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadV2Evaluation, writeV2EvaluationReport } from './judge-platform-capability-eval-v2.mjs';

export async function main(args = process.argv.slice(2)) {
  const value = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const summary = await writeV2EvaluationReport(loadV2Evaluation(value('folder'), value('run-folder')));
  console.log(JSON.stringify({ suiteVersion: summary.suiteVersion, total: summary.total, qaGraded: summary.qa.semanticallyGraded, workflowCount: summary.workflows.total, originalAuxiliaryWorkflowOutcomes: summary.workflows.originalAuxiliaryWorkflowOutcomes, adjudicatedWorkflowOutcomes: summary.workflows.adjudicatedWorkflowOutcomes, independentAgentAdjudicatedComplete: summary.workflows.independentAgentAdjudicatedComplete, humanCertified: false }));
  return summary;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
