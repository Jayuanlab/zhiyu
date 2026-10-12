import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prepareWorkflow } from './lib/platform-eval-v2-workflows.mjs';

const directory = path.resolve(process.cwd(), '../../.runtime/checks/platform-evidence-i1', `http-071-${randomUUID()}`);
await mkdir(directory, { recursive: true });
const fixture = await prepareWorkflow({ id: 'REAL-071', outputDir: directory });
let verification, cleanup;
try {
  if (fixture.status !== 'ready') throw Error(fixture.reason ?? 'Fixture not ready');
  for (const name of ['getWorkspace', 'prepareWorkspace', 'prepareWorkspace', 'getWorkspace', 'readLegacyWorkspaceHistory']) {
    const tool = fixture.tools.find(item => item.name === name);
    if (!tool) throw Error(`Missing fixture tool ${name}`);
    await tool.execute(`program-check-${name}-${randomUUID()}`, {});
  }
  verification = await fixture.verify({ answer: '' });
} finally { cleanup = await fixture.cleanup(); }
const result = { kind: 'program_verification_not_model_score', verification, cleanup };
await writeFile(path.join(directory, 'program-check.json'), JSON.stringify(result, null, 2), 'utf8');
process.stdout.write(JSON.stringify({ directory, status: verification?.status, cleanup: cleanup?.status }) + '\n');
if (!verification?.workflowExecutionPassed || cleanup?.status !== 'completed') process.exitCode = 1;
