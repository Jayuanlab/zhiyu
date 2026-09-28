import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {spawn} from 'node:child_process';
import postgres from 'postgres';
import { parse } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readMigrationFiles } from 'drizzle-orm/migrator';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(web, '../..');
if(process.argv.some(arg=>arg.startsWith('--report-prefix=')))throw Error('Use --record-prefix, not --report-prefix');
const reportPrefixOverride=process.argv.find(arg=>arg.startsWith('--record-prefix='))?.slice('--record-prefix='.length);
const reviewStageOverride=process.argv.find(arg=>arg.startsWith('--review-stage='))?.slice('--review-stage='.length);
if(reviewStageOverride!==undefined&&!/^\d{2}$/.test(reviewStageOverride))throw Error('Invalid review stage');
if(reportPrefixOverride!==undefined&&!/^[A-Za-z0-9-]{1,64}$/.test(reportPrefixOverride))throw Error('Invalid report prefix');
const env = {};
for (const file of [path.join(root, '.env'), path.join(web, '.env')]) {
  if (fs.existsSync(file)) Object.assign(env, parse(fs.readFileSync(file)));
}
Object.assign(env, process.env);
const url = new URL(env.ZHIYU_TEST_ADMIN_URL || env.POSTGRES_URL || env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('Test database administration requires loopback');
const name = `zhiyu_test_${randomUUID().replaceAll('-', '')}`;
url.pathname = '/postgres';
const admin = postgres(url.toString(), {max: 1, onnotice: () => {}});
const report = {startedAt: new Date().toISOString(), database: name, checks: [], cleanup: false};
const projectionCheck = process.argv.includes('--projection');
const quantBrowserCheck = process.argv.includes('--quant-browser');
const wechatCheck = process.argv.includes('--wechat');
const identityCheck = process.argv.includes('--identity');
const eventProductionCheck = process.argv.includes('--events-production');
const eventCheck = process.argv.includes('--events') || eventProductionCheck;
const commandProductionCheck = process.argv.includes('--commands-production');
const lifecycleProductionCheck = process.argv.includes('--lifecycle-production');
const decisionsProductionCheck = process.argv.includes('--loop-decisions-production');
const creationProductionCheck = process.argv.includes('--loop-creation-production');
const creationCheck = process.argv.includes('--loop-creation') || creationProductionCheck;
const runAcceptanceProductionCheck = process.argv.includes('--run-acceptance-production');
const runAcceptanceCheck = process.argv.includes('--run-acceptance') || runAcceptanceProductionCheck;
const proposalProductionCheck = process.argv.includes('--loop-proposals-production');
const proposalCheck = process.argv.includes('--loop-proposals') || proposalProductionCheck;
const configurationProductionCheck = process.argv.includes('--configuration-writes-production');
const manifestProductionCheck = process.argv.includes('--manifest-lifecycle-production');
const identityConfigProductionCheck = process.argv.includes('--configuration-identity-production');
const rejectionProductionCheck = process.argv.includes('--command-rejections-production');
const clientActionsCheck = process.argv.includes('--client-actions-production');
const wakeupSuggestionProductionCheck = process.argv.includes('--wakeup-suggestion-production');
const wakeupSuggestionFocus = process.argv.includes('--wakeup-suggestion-focus');
const executionHeartbeatProductionCheck = process.argv.includes('--execution-heartbeat-production');
const outboxAttemptCheck=process.argv.includes('--outbox-attempt');
const loopExecutionCheck=process.argv.includes('--loop-execution');
const loopAcceptanceCheck=process.argv.includes('--loop-acceptance');
const executionHeartbeatCheck = process.argv.includes('--execution-heartbeat') || executionHeartbeatProductionCheck;
const wakeupSuggestionCheck = process.argv.includes('--wakeup-suggestion') || wakeupSuggestionProductionCheck || wakeupSuggestionFocus;
const brainRecordProductionCheck = process.argv.includes('--brain-record-write-production') || wakeupSuggestionProductionCheck;
const brainRecordCheck = process.argv.includes('--brain-record-write') || brainRecordProductionCheck || wakeupSuggestionCheck;
const legacyMemoryProductionCheck = process.argv.includes('--legacy-memory-production') || brainRecordProductionCheck;
const legacyMemoryCheck = process.argv.includes('--legacy-memory') || legacyMemoryProductionCheck || brainRecordCheck;
const runSnapshotProductionCheck = process.argv.includes('--run-snapshot-production') || legacyMemoryProductionCheck;
const runSnapshotCheck = process.argv.includes('--run-snapshot') || runSnapshotProductionCheck || legacyMemoryCheck;
const brainMemoryReviewProductionCheck = process.argv.includes('--brain-memory-review-production') || runSnapshotProductionCheck;
const brainMemoryReviewCheck = process.argv.includes('--brain-memory-review') || brainMemoryReviewProductionCheck || runSnapshotCheck;
const brainMemoryWriteProductionCheck = process.argv.includes('--brain-memory-write-production') || brainMemoryReviewProductionCheck;
const brainMemoryWriteCheck = process.argv.includes('--brain-memory-write') || brainMemoryWriteProductionCheck || brainMemoryReviewCheck;
const legacyRunWriteProductionCheck = process.argv.includes('--legacy-run-write-production') || brainMemoryWriteProductionCheck;
const legacyRunWriteCheck = process.argv.includes('--legacy-run-write') || legacyRunWriteProductionCheck || brainMemoryWriteCheck;
const controlWriteProductionCheck = process.argv.includes('--workshop-control-write-production') || legacyRunWriteProductionCheck;
const controlWriteCheck = process.argv.includes('--workshop-control-write') || controlWriteProductionCheck || legacyRunWriteCheck;
const executionGuardCheck = process.argv.includes('--execution-guard') || controlWriteCheck;
const executionContextCheck = process.argv.includes('--execution-context') || executionGuardCheck;
const commandFenceCheck = process.argv.includes('--command-execution-fence') || executionContextCheck;
const runCompletionCheck = process.argv.includes('--run-completion') || commandFenceCheck;
const executionLeasesCheck = process.argv.includes('--execution-leases') || runCompletionCheck;
const clientCommandsCheck = process.argv.includes('--client-commands-production') || clientActionsCheck;
const manifestExportProductionCheck = process.argv.includes('--manifest-export-production') || clientCommandsCheck;
const manifestExportCheck = process.argv.includes('--manifest-export') || manifestExportProductionCheck;
const loopAliasesProductionCheck = process.argv.includes('--loop-aliases-production') || manifestExportProductionCheck;
const loopAliasesCheck = process.argv.includes('--loop-aliases') || loopAliasesProductionCheck || manifestExportCheck;
const rejectionCheck = process.argv.includes('--command-rejections') || rejectionProductionCheck || loopAliasesCheck;
const identityConfigCheck = process.argv.includes('--configuration-identity') || identityConfigProductionCheck || rejectionCheck;
const manifestCheck = process.argv.includes('--manifest-lifecycle') || manifestProductionCheck || identityConfigCheck;
const configurationCheck = process.argv.includes('--configuration-writes') || configurationProductionCheck || manifestCheck;
const decisionsCheck = process.argv.includes('--loop-decisions') || decisionsProductionCheck;
const lifecycleCheck = process.argv.includes('--lifecycle') || lifecycleProductionCheck;
const commandBusinessCheck = process.argv.includes('--commands-business') || commandProductionCheck;
const commandCheck = process.argv.includes('--commands') || commandBusinessCheck || lifecycleCheck || decisionsCheck || creationCheck || runAcceptanceCheck || proposalCheck || configurationCheck || executionLeasesCheck;
let client;
let created = false;
try {
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  created = true;
  url.pathname = `/${name}`;
  client = postgres(url.toString(), {max: 1, onnotice: () => {}});
  const db = drizzle(client);
  const dialect = new PgDialect();
  const folder = path.join(web, 'lib/db/migrations');
  const migrations = readMigrationFiles({migrationsFolder: folder});
  const journal = JSON.parse(fs.readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8'));
  const baseline = journal.entries.findIndex(entry => entry.tag === '0120_add_brain_memory_tables');
  if (baseline < 1) throw Error('Missing migration baseline');
  await dialect.migrate(migrations.slice(0, baseline), db._.session, {migrationsTable: '__drizzle_migrations'});
  report.checks.push({name: 'empty database to previous baseline', passed: true});
  await client.unsafe('CREATE TABLE test_fixture_sentinel (id int PRIMARY KEY)');
  await client.unsafe('INSERT INTO test_fixture_sentinel VALUES (1)');
  let legacyEventWorkId;
  if (eventCheck) {
    const legacyUserId = randomUUID(); legacyEventWorkId = randomUUID();
    await client`INSERT INTO "User" (id,email) VALUES (${legacyUserId},'legacy-events@example.invalid')`;
    await client`INSERT INTO workshops (id,user_id,name,mission) VALUES (${legacyEventWorkId},${legacyUserId},'legacy','migration regression')`;
    await client`INSERT INTO workshop_events (workshop_id,seq,type,title) VALUES (${legacyEventWorkId},42,'observation','legacy event')`;
  }
  let briefLegacy;
  let modelRepairFixture;
  if(process.argv.includes('--model-repair')||process.argv.includes('--model-repair-legacy')){
    const {prepareModelRepair}=await import('../tests/integration/model-schema-repair.mjs');
    modelRepairFixture=await prepareModelRepair({client,web,legacy:process.argv.includes('--model-repair-legacy')});
  }
  if(process.argv.includes('--brief-categories-legacy')){
    const {prepareLegacyBriefCategory}=await import('../tests/integration/brief-category-schema.mjs');
    briefLegacy=await prepareLegacyBriefCategory({client,web});
  }
  await dialect.migrate(migrations, db._.session, {migrationsTable: '__drizzle_migrations'});
  const tables = await client`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  for (const required of ['brain_memories', 'harness_components', 'work_harness_snapshots', 'work_evaluation_runs', 'insight_brief_categories']) {
    if (!tables.some(row => row.table_name === required)) throw Error(`Missing expected table: ${required}`);
  }
  report.checks.push({name: 'upgrade to current schema', passed: true, migrations: migrations.length});
  const before = await client.unsafe('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  await dialect.migrate(migrations, db._.session, {migrationsTable: '__drizzle_migrations'});
  const after = await client.unsafe('SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations');
  const rows = await client.unsafe('SELECT id FROM test_fixture_sentinel');
  if (before[0].count !== after[0].count || rows.length !== 1 || rows[0].id !== 1) throw Error('Repeat migration changed fixture or journal');
  report.checks.push({name: 'repeat migration preserves data and journal', passed: true});
  if(process.argv.includes('--build-migration-separation')){
    const {checkBuildMigrationSeparation}=await import('../tests/integration/build-migration-separation.mjs');
    report.checks.push(await checkBuildMigrationSeparation({web,env,databaseUrl:url.toString(),client,build:process.argv.includes('--verify-production-build')}));
  }
  {
    const {inspectPostgresModelCoverage}=await import('../tests/integration/postgres-model-coverage.mjs');
    const coverage=await inspectPostgresModelCoverage(client);report.checks.push(coverage);
    if(!coverage.passed)throw Error('Migrated database differs from exported PostgreSQL model tables, columns or nullability');
  }
  if(modelRepairFixture){
    const {checkModelRepair,checkMemoryQualityHttp}=await import('../tests/integration/model-schema-repair.mjs');
    report.checks.push(await checkModelRepair({client,web,fixture:modelRepairFixture}));
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const http=await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'12A-schema',reviewStage:'68',browserCheck:checkMemoryQualityHttp});
    report.checks.push({...http,name:'development memory quality HTTP verification'});
  }
  if(process.argv.includes('--brief-categories')||process.argv.includes('--brief-categories-legacy')){
    const {checkBriefCategorySchema,checkBriefCategoryHttp}=await import('../tests/integration/brief-category-schema.mjs');
    report.checks.push(await checkBriefCategorySchema({client,web,legacy:briefLegacy}));
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const httpCheck=await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'12A-brief',reviewStage:'68',browserCheck:checkBriefCategoryHttp});
    report.checks.push({...httpCheck,name:'development brief category HTTP verification'});
  }
  if(process.argv.includes('--workspace-default-browser')){
    const {checkWorkspaceDefaultBrowser}=await import('../tests/integration/workspace-default-browser.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'12G-default',reviewStage:'68',browserCheck:checkWorkspaceDefaultBrowser}));
  }
  if(process.argv.includes('--workspace-secondary-browser')){
    const {checkWorkspaceSecondaryBrowser}=await import('../tests/integration/workspace-secondary-browser.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'12F-secondary',reviewStage:'68',browserCheck:checkWorkspaceSecondaryBrowser}));
  }
  if(process.argv.includes('--workspace-picker-browser')){
    const {checkWorkspacePickerBrowser}=await import('../tests/integration/workspace-picker-browser.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'12E-picker',reviewStage:'68',browserCheck:checkWorkspacePickerBrowser}));
  }
  if(process.argv.includes('--workspace-bounded-browser')){
    const {checkWorkspaceBoundedBrowser}=await import('../tests/integration/workspace-bounded-browser.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'12D-workspace',reviewStage:'68',browserCheck:checkWorkspaceBoundedBrowser}));
  }
  if(process.argv.includes('--workspace-bounded-listing')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{const {checkWorkspaceBoundedListing}=await import('../tests/integration/workspace-bounded-listing.check.ts');report.checks.push(await checkWorkspaceBoundedListing(client));}
    finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--brain-recall-feedback-browser')){
    const {checkRecallFeedbackBrowser}=await import('../tests/integration/brain-recall-feedback-browser.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'11L-browser',reviewStage:'68',browserCheck:checkRecallFeedbackBrowser}));
  }
  if(process.argv.includes('--brain-query-retry')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{const {checkQueryRetry}=await import('../tests/integration/brain-query-retry.check.ts');report.checks.push(await checkQueryRetry(client));}
    finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--brain-recall-feedback')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{const {checkRecallFeedback}=await import('../tests/integration/brain-recall-feedback.check.ts');report.checks.push(await checkRecallFeedback(client));}
    finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--brain-evidence-quality')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{const {checkEvidenceQuality}=await import('../tests/integration/brain-evidence-quality.check.ts');report.checks.push(await checkEvidenceQuality(client));}
    finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--brain-evidence-owner')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{const {checkEvidenceOwner}=await import('../tests/integration/brain-evidence-owner.check.ts');report.checks.push(await checkEvidenceOwner(client));}
    finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--brain-recall-boundaries')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{const {checkRecallBoundaries}=await import('../tests/integration/brain-recall-boundaries.check.ts');report.checks.push(await checkRecallBoundaries(client));}
    finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--canonical-backfill-browser')){
    const {checkBrainBackfillBrowser}=await import('../tests/integration/brain-backfill-browser.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'11F-browser',reviewStage:'68',browserCheck:checkBrainBackfillBrowser}));
  }
  if(process.argv.includes('--canonical-backfill-http')){
    const {checkBrainBackfillHttp}=await import('../tests/integration/brain-backfill-http.mjs');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'11D-http',reviewStage:'68',browserCheck:checkBrainBackfillHttp}));
  }
  if(process.argv.includes('--canonical-backfill-batches')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{
      const {checkCanonicalBatches}=await import('../tests/integration/brain-canonical-batches.check.ts');
      report.checks.push(await checkCanonicalBatches(client,web));
    }finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--canonical-backfill-preview')){
    process.env.NODE_ENV='test';process.env.ZHIYU_TEST_MODE='integration';process.env.ZHIYU_TEST_DATABASE_URL=url.toString();process.env.POSTGRES_URL=url.toString();process.env.DATABASE_URL=url.toString();
    try{
      const {checkCanonicalBackfill}=await import('../tests/integration/brain-canonical-backfill.check.ts');
      report.checks.push(await checkCanonicalBackfill(client,web));
      const {checkBrainMemoryWrites}=await import('../tests/integration/brain-memory-write.check.ts');
      report.checks.push(await checkBrainMemoryWrites(client));
    }finally{const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');await closePostgresDb();}
  }
  if(process.argv.includes('--build-production')){
    if(!reviewStageOverride)throw Error('Isolated build requires --review-stage');
    const buildOwner=randomUUID();
    await client`INSERT INTO "User"(id,email) VALUES (${buildOwner},'isolated-build@example.invalid')`;
    const build=spawn(process.execPath,[path.join(web,'scripts/build-review.mjs'),reviewStageOverride],{
      cwd:web,windowsHide:true,stdio:'inherit',env:{...env,POSTGRES_URL:url.toString(),DATABASE_URL:url.toString(),AUTH_MODE:'local_owner',DEV_USER_ID:buildOwner,
        ENABLE_LOCAL_SCHEDULER:'false',ENABLE_STARTUP_LISTENERS:'false',WORK_HARNESS_EVOLUTION_ENABLED:'false',REPORT_QUALITY_EVALUATOR_ENABLED:'false',TAURI_MODE:'false',IS_TAURI:'false'}
    });
    const code=await new Promise((resolve,reject)=>{build.once('error',reject);build.once('exit',resolve);});
    if(code!==0)throw Error(`Isolated production build exited ${code}`);
    report.checks.push({name:'production build against isolated database',passed:true,stage:reviewStageOverride});
  }
  if(process.argv.includes('--runtime-host')){
    const {checkRuntimeHostStore}=await import('../tests/integration/runtime-host-store.mjs');
    report.checks.push(await checkRuntimeHostStore({client,databaseUrl:url.toString()}));
  }
  if(process.argv.includes('--paper-tick-store')){
    const {checkPaperTickStore}=await import('../tests/integration/paper-tick-store.mjs');
    report.checks.push(await checkPaperTickStore({client,databaseUrl:url.toString()}));
  }
  if(process.argv.includes('--runtime-status-read')){
    const {checkRuntimeStatusRead}=await import('../tests/integration/runtime-status-read.mjs');
    report.checks.push(await checkRuntimeStatusRead({client,databaseUrl:url.toString()}));
  }
  if(process.argv.includes('--interaction-reviews-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkInteractionReviewsBrowser}=await import('../tests/integration/interaction-reviews-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'09Q',reviewStage:'68',browserCheck:checkInteractionReviewsBrowser}));
  }
  if(process.argv.includes('--workbench-layout-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkbenchLayoutBrowser}=await import('../tests/integration/workbench-layout-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10B',reviewStage:'68',browserCheck:checkWorkbenchLayoutBrowser}));
  }
  if(process.argv.includes('--workshop-location-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopLocationBrowser}=await import('../tests/integration/workshop-location-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10C-location',reviewStage:'68',browserCheck:checkWorkshopLocationBrowser}));
  }
  if(process.argv.includes('--workshop-read-state-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopReadStateBrowser}=await import('../tests/integration/workshop-read-state-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10I-read-state',reviewStage:'68',browserCheck:checkWorkshopReadStateBrowser}));
  }
  if(process.argv.includes('--workshop-record-evidence-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopRecordEvidenceBrowser}=await import('../tests/integration/workshop-record-evidence-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10H-record-evidence',reviewStage:'68',browserCheck:checkWorkshopRecordEvidenceBrowser}));
  }
  if(process.argv.includes('--review-commands-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkReviewCommandsBrowser}=await import('../tests/integration/review-commands-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'06F-review',reviewStage:'68',browserCheck:checkReviewCommandsBrowser}));
  }
  if(process.argv.includes('--outbox-dismiss-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkOutboxDismissBrowser}=await import('../tests/integration/outbox-dismiss-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'07-dismiss',reviewStage:'68',browserCheck:checkOutboxDismissBrowser}));
  }
  if(process.argv.includes('--workshop-review-location-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopReviewLocationBrowser}=await import('../tests/integration/workshop-review-location-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10G-review-location',reviewStage:'68',browserCheck:checkWorkshopReviewLocationBrowser}));
  }
  if(process.argv.includes('--workshop-performance')){
    if(!reviewStageOverride)throw Error('Performance check requires --review-stage');
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {workshopPerformanceCheck}=await import('../tests/integration/workshop-performance.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10M-performance',reviewStage:reviewStageOverride,mode:'production',browserCheck:workshopPerformanceCheck(reviewStageOverride)}));
  }
  if(process.argv.includes('--workshop-run-location-browser')||process.argv.includes('--production-run-history')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopRunLocationBrowser}=await import('../tests/integration/workshop-run-location-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10F-run-location',reviewStage:reviewStageOverride??'68',mode:process.argv.includes('--production-run-history')?'production':'development',browserCheck:checkWorkshopRunLocationBrowser}));
  }
  if(process.argv.includes('--workshop-conclusion-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopConclusionBrowser}=await import('../tests/integration/workshop-conclusion-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10E-conclusion',reviewStage:'68',browserCheck:checkWorkshopConclusionBrowser}));
  }
  if(process.argv.includes('--workshop-drafts-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkWorkshopDraftsBrowser}=await import('../tests/integration/workshop-drafts-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10D-drafts',reviewStage:'68',browserCheck:checkWorkshopDraftsBrowser}));
  }
  if(process.argv.includes('--interaction-write-boundary')){
    const {checkInteractionWriteBoundary}=await import('../tests/integration/interaction-write-boundary.mjs');
    report.checks.push(await checkInteractionWriteBoundary({databaseUrl:url.toString(),web}));
  }
  if(process.argv.includes('--legacy-interactions')){
    const {checkLegacyInteractions}=await import('../tests/integration/legacy-interactions.mjs');
    report.checks.push(await checkLegacyInteractions({databaseUrl:url.toString(),web}));
  }
  if(process.argv.includes('--interaction-atomic')){
    const {checkInteractionAtomic}=await import('../tests/integration/interaction-atomic.mjs');
    report.checks.push(await checkInteractionAtomic({databaseUrl:url.toString(),web}));
  }
  if(process.argv.includes('--runtime-manager')){
    const {checkRuntimeManager}=await import('../tests/integration/runtime-manager.mjs');
    report.checks.push(await checkRuntimeManager({client,databaseUrl:url.toString(),web,root,recordPrefix:reportPrefixOverride??'09M'}));
  }
  if(process.argv.includes('--runtime-live-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkRuntimeLiveBrowser}=await import('../tests/integration/runtime-live-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'09N',reviewStage:'68',managed:true,browserCheck:checkRuntimeLiveBrowser}));
  }
  if(process.argv.includes('--runtime-status-browser')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkRuntimeStatusBrowser}=await import('../tests/integration/runtime-status-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'09L',reviewStage:'68',browserCheck:checkRuntimeStatusBrowser}));
  }
  if(process.argv.includes('--runtime-host-processes')){
    const {checkRuntimeHostProcesses}=await import('../tests/integration/runtime-host-processes.mjs');
    report.checks.push(await checkRuntimeHostProcesses({client,databaseUrl:url.toString(),web,root,recordPrefix:reportPrefixOverride??'09B'}));
  }
  if(process.argv.includes('--runtime-host-cli')){
    const {checkRuntimeHostCli}=await import('../tests/integration/runtime-host-cli.mjs');
    report.checks.push(await checkRuntimeHostCli({client,databaseUrl:url.toString(),web,root,recordPrefix:reportPrefixOverride??'09C'}));
  }
  if(process.argv.includes('--heartbeat-admission')){
    const {checkHeartbeatAdmission}=await import('../tests/integration/heartbeat-admission.mjs');
    report.checks.push(await checkHeartbeatAdmission({client,databaseUrl:url.toString(),web}));
  }
  if(process.argv.includes('--paper-ledger')||process.argv.includes('--paper-end-to-end')||process.argv.includes('--paper-runtime-worker')){
    const {checkPaperLedger}=await import('../tests/integration/paper-ledger.mjs');
    const {checkPaperEndToEnd}=await import('../tests/integration/paper-end-to-end.mjs');
    const {checkPaperRuntimeWorker}=await import('../tests/integration/paper-runtime-worker.mjs');
    report.checks.push(await checkPaperLedger({client,root,databaseUrl:url.toString(),recordPrefix:reportPrefixOverride??'08A',
      extraCheck:process.argv.includes('--paper-runtime-worker')?credentials=>checkPaperRuntimeWorker({client,root,web,databaseUrl:url.toString(),recordPrefix:reportPrefixOverride??'09U',credentials}):process.argv.includes('--paper-end-to-end')?credentials=>checkPaperEndToEnd({env,client,root,web,databaseUrl:url.toString(),recordPrefix:reportPrefixOverride??'08D-e2e',credentials,
        mode:process.argv.includes('--paper-production')?'production':'development',reviewStage:reviewStageOverride??'65'}):undefined}));
  }
  if(process.argv.includes('--loops-development')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'10A'}));
  }
  if(process.argv.includes('--paper-development')){
    const {checkLoopDevelopment}=await import('../tests/integration/loop-development.mjs');
    const {checkPaperReviewBrowser}=await import('../tests/integration/paper-review-browser.mjs');
    report.checks.push(await checkLoopDevelopment({env,databaseUrl:url.toString(),client,web,root,recordPrefix:reportPrefixOverride??'08D',browserCheck:checkPaperReviewBrowser}));
  }
  if (quantBrowserCheck) {
    const { runQuantBrowserCheck } = await import('../tests/integration/quant-browser-server.mjs');
    report.checks.push(await runQuantBrowserCheck({env, databaseUrl: url.toString(), client, web, root}));
  }
  if (identityCheck) {
    const { runIdentityProductionCheck } = await import('../tests/integration/identity-production.mjs');
    report.checks.push(await runIdentityProductionCheck({env, databaseUrl: url.toString(), client, web, root}));
  }
  if (eventCheck) {
    const legacyCounter = await client`SELECT last_seq FROM workshop_event_counters WHERE workshop_id=${legacyEventWorkId}`;
    if (legacyCounter[0]?.last_seq !== 42) throw new Error('Legacy event counter backfill failed');
    report.checks.push({name: 'counter initialized from legacy max(seq) and repeat migration preserved it', passed: true});
    const { checkEventConcurrency } = await import('../tests/integration/event-concurrency.check.mjs');
    report.checks.push(await checkEventConcurrency({env, databaseUrl: url.toString(), client, web, root}));
    process.env.NODE_ENV = 'test'; process.env.ZHIYU_TEST_MODE = 'integration';
    process.env.ZHIYU_TEST_DATABASE_URL = url.toString(); process.env.POSTGRES_URL = url.toString(); process.env.DATABASE_URL = url.toString();
    try {
      const { checkEventTransactions } = await import('../tests/integration/event-transaction.check.ts');
      report.checks.push(await checkEventTransactions(client));
      if (eventProductionCheck) {
        const { checkEventStreamProduction } = await import('../tests/integration/event-stream-production.mjs');
        report.checks.push(await checkEventStreamProduction({env, databaseUrl: url.toString(), client, web, root}));
      }
    } finally {
      const { closePostgresDb } = await import('../lib/db/adapters/postgres.ts');
      await closePostgresDb();
    }
  }
  if (commandCheck || projectionCheck || wechatCheck || executionHeartbeatCheck || outboxAttemptCheck || loopExecutionCheck || loopAcceptanceCheck) {
    process.env.NODE_ENV = 'test';
    process.env.ZHIYU_TEST_MODE = 'integration';
    process.env.ZHIYU_TEST_DATABASE_URL = url.toString();
    process.env.POSTGRES_URL = url.toString();
    process.env.DATABASE_URL = url.toString();
    try {
      if(outboxAttemptCheck){
        const {checkOutboxAttempt}=await import('../tests/integration/outbox-attempt.check.ts');
        report.checks.push(await checkOutboxAttempt(client));
        if(process.argv.includes('--outbox-resolution')){
          const {checkOutboxResolution}=await import('../tests/integration/outbox-resolution.check.ts');
          report.checks.push(await checkOutboxResolution(client));
        }
        if(process.argv.includes('--outbox-reviews')){
          const {checkOutboxReviews}=await import('../tests/integration/outbox-reviews.check.ts');
          report.checks.push(await checkOutboxReviews(client));
        }
        if(process.argv.includes('--outbox-recovery')){
          const {checkOutboxRecovery}=await import('../tests/integration/outbox-recovery.check.ts');
          report.checks.push(await checkOutboxRecovery(client));
        }
        if(process.argv.includes('--outbox-production')){
          const {withFakeWechat}=await import('../tests/integration/outbox-send-production.mjs');
          const {checkConfigurationProduction}=await import('../tests/integration/configuration-production.mjs');
          report.checks.push(await withFakeWechat((fakeEnv,outboxState)=>checkConfigurationProduction({env:{...env,...fakeEnv},databaseUrl:url.toString(),client,web,root,reviewStage:reviewStageOverride??'51',portOverride:3536,recordPrefix:reportPrefixOverride??'07C',outboxState})));
        }
      } else if(loopAcceptanceCheck){
        const {checkLoopAcceptance}=await import('../tests/integration/loop-acceptance.check.ts');
        report.checks.push(await checkLoopAcceptance(client));
      } else if(loopExecutionCheck){
        const {checkLoopLifecycleProcess}=await import('../tests/integration/loop-lifecycle-process.mjs');
        report.checks.push(await checkLoopLifecycleProcess({web,root,databaseUrl:url.toString(),recordPrefix:reportPrefixOverride??'06D'}));
      } else if(executionHeartbeatCheck){
        const {checkExecutionHeartbeat}=await import('../tests/integration/execution-heartbeat.check.ts');
        report.checks.push(await checkExecutionHeartbeat(client));
        const {checkCancelRun}=await import('../tests/integration/cancel-run.check.ts');
        report.checks.push(await checkCancelRun(client));
        const {checkRunOutput}=await import('../tests/integration/run-output.check.ts');
        report.checks.push(await checkRunOutput(client));
        if(process.argv.includes('--run-planning')){
          const {checkRunPlan}=await import('../tests/integration/run-plan.check.ts');
          report.checks.push(await checkRunPlan(client));
        }
        const {checkRuntimeLifecycleProcess}=await import('../tests/integration/runtime-lifecycle-process.mjs');
        report.checks.push(await checkRuntimeLifecycleProcess({web,root,databaseUrl:url.toString(),recordPrefix:reportPrefixOverride??'06C4'}));
        if(executionHeartbeatProductionCheck){
          const {checkConfigurationProduction}=await import('../tests/integration/configuration-production.mjs');
          report.checks.push(await checkConfigurationProduction({env,databaseUrl:url.toString(),client,web,root,reviewStage:reviewStageOverride??'49',portOverride:3536,recordPrefix:reportPrefixOverride??(reviewStageOverride==='50'?'06C5':'06C4')}));
        }
      } else if(wakeupSuggestionFocus){
        const {checkWakeupSuggestion}=await import('../tests/integration/wakeup-suggestion.check.ts');
        report.checks.push(await checkWakeupSuggestion(client));
      } else if (commandCheck) {
        const { checkCommandLedger } = await import('../tests/integration/command-ledger.check.ts');
        report.checks.push(await checkCommandLedger(client));
        if (commandBusinessCheck || lifecycleCheck || configurationCheck) {
          const { checkWorkCommandBusiness } = await import('../tests/integration/work-command-business.check.ts');
          report.checks.push(await checkWorkCommandBusiness(client));
        }
        const { checkCommandConcurrency } = await import('../tests/integration/command-concurrency.check.mjs');
        report.checks.push(await checkCommandConcurrency({env, databaseUrl: url.toString(), client, web}));
        if(executionLeasesCheck){
          const {checkExecutionLeases}=await import('../tests/integration/execution-lease.check.ts');
          const {checkExecutionLeaseConcurrency}=await import('../tests/integration/execution-lease-concurrency.mjs');
          report.checks.push(await checkExecutionLeases(client));
          report.checks.push(await checkExecutionLeaseConcurrency({env,databaseUrl:url.toString(),client,web}));
          if(runCompletionCheck){
            if(commandFenceCheck){
              if(executionContextCheck){
                if(executionGuardCheck){
                  if(controlWriteCheck){
                    if(legacyRunWriteCheck){
                      if(brainMemoryWriteCheck){
                        if(brainMemoryReviewCheck){
                          if(runSnapshotCheck){
                            if(legacyMemoryCheck){
                              if(brainRecordCheck){
                                if(wakeupSuggestionCheck){
                                  const {checkWakeupSuggestion}=await import('../tests/integration/wakeup-suggestion.check.ts');
                                  report.checks.push(await checkWakeupSuggestion(client));
                                }
                                const {checkBrainRecordWrites}=await import('../tests/integration/brain-record-write.check.ts');
                                report.checks.push(await checkBrainRecordWrites(client));
                              }
                              const {checkLegacyMemory}=await import('../tests/integration/legacy-memory.check.ts');
                              report.checks.push(await checkLegacyMemory(client));
                            }
                            const {checkRunSnapshot}=await import('../tests/integration/run-snapshot.check.ts');
                            report.checks.push(await checkRunSnapshot(client));
                          }
                          const {checkBrainMemoryReview}=await import('../tests/integration/brain-memory-review.check.ts');
                          report.checks.push(await checkBrainMemoryReview(client));
                        }
                        const {checkBrainMemoryWrites}=await import('../tests/integration/brain-memory-write.check.ts');
                        report.checks.push(await checkBrainMemoryWrites(client));
                      }
                      const {checkLegacyRunWrites}=await import('../tests/integration/legacy-run-write.check.ts');
                      report.checks.push(await checkLegacyRunWrites(client));
                    }
                    const {checkWorkshopControlWrite}=await import('../tests/integration/workshop-control-write.check.ts');
                    report.checks.push(await checkWorkshopControlWrite(client));
                    if(controlWriteProductionCheck){
                      const {checkConfigurationProduction}=await import('../tests/integration/configuration-production.mjs');
                      report.checks.push(await checkConfigurationProduction({env,databaseUrl:url.toString(),client,web,root,reviewStage:wakeupSuggestionCheck?'48':brainRecordCheck?'47':legacyMemoryCheck?'46':runSnapshotCheck?'45':brainMemoryReviewCheck?'44':brainMemoryWriteCheck?'43':legacyRunWriteCheck?'42':'40',portOverride:legacyRunWriteCheck?3536:3535,recordPrefix:wakeupSuggestionCheck?'06C3k':brainRecordCheck?'06C3j':legacyMemoryCheck?'06C3i':runSnapshotCheck?'06C3h':brainMemoryReviewCheck?'06C3g':brainMemoryWriteCheck?'06C3f':legacyRunWriteCheck?'06C3e':'06C3d',legacyRunWrites:legacyRunWriteCheck}));
                    }
                  }
                  const {checkExecutionGuard}=await import('../tests/integration/execution-guard.check.ts');
                  report.checks.push(await checkExecutionGuard(client));
                }
                const {checkExecutionContext}=await import('../tests/integration/execution-context.check.ts');
                report.checks.push(await checkExecutionContext(client));
              }
              const {checkCommandExecutionFence}=await import('../tests/integration/command-execution-fence.check.ts');
              report.checks.push(await checkCommandExecutionFence(client));
            }
            const {checkRunCompletion}=await import('../tests/integration/run-completion.check.ts');
            const {checkRunCompletionConcurrency}=await import('../tests/integration/run-completion-concurrency.mjs');
            report.checks.push(await checkRunCompletion(client));
            report.checks.push(await checkRunCompletionConcurrency({env,databaseUrl:url.toString(),client,web}));
          }
        }
        if (configurationCheck) {
          const {checkConfigurationWrites} = await import('../tests/integration/configuration-writes.check.ts');
          report.checks.push(await checkConfigurationWrites(client));
          if (manifestCheck) {
            if (identityConfigCheck) {
              if (rejectionCheck) {
                const {checkCommandRejections} = await import('../tests/integration/command-rejections.check.ts');
                report.checks.push(await checkCommandRejections(client));
              }
              const {checkConfigurationIdentity} = await import('../tests/integration/configuration-identity.check.ts');
              report.checks.push(await checkConfigurationIdentity(client));
            }
            const {checkManifestLifecycle} = await import('../tests/integration/manifest-lifecycle.check.ts');
            report.checks.push(await checkManifestLifecycle(client));
            const {checkWorkLifecycle} = await import('../tests/integration/work-lifecycle.check.ts');
            report.checks.push(await checkWorkLifecycle(client));
          }
          if (loopAliasesCheck) {
            const {checkLoopAliases} = await import('../tests/integration/loop-aliases.check.ts');
            report.checks.push(await checkLoopAliases(client));
          }
          if (manifestExportCheck) {
            const {checkManifestExport} = await import('../tests/integration/manifest-export.check.ts');
            report.checks.push(await checkManifestExport(client));
          }
          if (configurationProductionCheck || manifestProductionCheck || identityConfigProductionCheck || rejectionProductionCheck || loopAliasesProductionCheck) {
            const {checkConfigurationProduction} = await import('../tests/integration/configuration-production.mjs');
            report.checks.push(await checkConfigurationProduction({env, databaseUrl: url.toString(), client, web, root, manifestLifecycle: manifestProductionCheck || identityConfigProductionCheck || rejectionProductionCheck || loopAliasesProductionCheck, configurationIdentity: identityConfigProductionCheck || rejectionProductionCheck || loopAliasesProductionCheck, commandRejections: rejectionProductionCheck || loopAliasesProductionCheck, loopAliases: loopAliasesProductionCheck, manifestExport: manifestExportProductionCheck, clientCommands: clientCommandsCheck, clientActions: clientActionsCheck}));
          }
        }
        if (proposalCheck) {
          const {checkLoopProposals} = await import('../tests/integration/loop-proposals.check.ts');
          const previousNodeEnv = process.env.NODE_ENV;
          try {
            if (proposalProductionCheck) process.env.NODE_ENV = 'production';
            report.checks.push(await checkLoopProposals(client));
          } finally {process.env.NODE_ENV = previousNodeEnv;}
        }
        if (runAcceptanceCheck) {
          const {checkRunAcceptance} = await import('../tests/integration/run-acceptance.check.ts');
          report.checks.push(await checkRunAcceptance(client));
          if (runAcceptanceProductionCheck) {
            const {checkRunAcceptanceProduction} = await import('../tests/integration/run-acceptance-production.mjs');
            report.checks.push(await checkRunAcceptanceProduction({env, databaseUrl: url.toString(), client, web, root}));
          }
        }
        if (creationCheck) {
          const {checkLoopCreation} = await import('../tests/integration/loop-creation.check.ts');
          report.checks.push(await checkLoopCreation(client));
          if (creationProductionCheck) {
            const {checkLoopCreationProduction} = await import('../tests/integration/loop-creation-production.mjs');
            report.checks.push(await checkLoopCreationProduction({env, databaseUrl: url.toString(), client, web, root}));
          }
        }
        if (decisionsCheck) {
          const {checkLoopDecisions} = await import('../tests/integration/loop-decisions.check.ts');
          report.checks.push(await checkLoopDecisions(client));
          if (decisionsProductionCheck) {
            const {checkLoopDecisionsProduction} = await import('../tests/integration/loop-decisions-production.mjs');
            report.checks.push(await checkLoopDecisionsProduction({env, databaseUrl: url.toString(), client, web, root}));
          }
        }
        if (lifecycleCheck) {
          const {checkWorkLifecycle} = await import('../tests/integration/work-lifecycle.check.ts');
          report.checks.push(await checkWorkLifecycle(client));
          const {checkWorkLifecycleConcurrency} = await import('../tests/integration/work-lifecycle-concurrency.mjs');
          report.checks.push(await checkWorkLifecycleConcurrency({env, databaseUrl: url.toString(), client, web}));
          if (lifecycleProductionCheck) {
            const {checkWorkLifecycleProduction} = await import('../tests/integration/work-lifecycle-production.mjs');
            report.checks.push(await checkWorkLifecycleProduction({env, databaseUrl: url.toString(), client, web, root}));
          }
        }
        if (commandProductionCheck) {
          const { checkWorkCommandProduction } = await import('../tests/integration/work-command-production.mjs');
          report.checks.push(await checkWorkCommandProduction({env, databaseUrl: url.toString(), client, web, root}));
        }
      } else if (wechatCheck) {
        const { checkWechatDigest } = await import('../tests/integration/wechat-digest.check.ts');
        report.checks.push(await checkWechatDigest(client));
      } else {
        const { checkWorkProjection } = await import('../tests/integration/work-status-projection.check.ts');
        report.checks.push(await checkWorkProjection(client));
      }
    } finally {
      const { closePostgresDb } = await import('../lib/db/adapters/postgres.ts');
      await closePostgresDb();
    }
  }
} catch (error) {
  console.error(error.stack);
  report.error = {message: error.message, code: error.code};
  process.exitCode = 1;
} finally {
  if (client) await client.end();
  // Only the randomly named database created by this invocation can be removed.
  if (created) {
    await admin.unsafe(`DROP DATABASE "${name}"`);
    report.cleanup = true;
  }
  await admin.end();
  report.completedAt = new Date().toISOString();
  const recordStage = brainMemoryWriteCheck ? '06C3f' : legacyRunWriteCheck ? '06C3e' : controlWriteCheck ? '06C3d' : executionGuardCheck ? '06C3c' : executionContextCheck ? '06C3b' : commandFenceCheck ? '06C3a' : runCompletionCheck ? '06C2' : executionLeasesCheck ? '06C1' : clientActionsCheck ? '06B15' : clientCommandsCheck ? '06B14' : manifestExportCheck ? '06B13' : loopAliasesCheck ? '06B12' : rejectionCheck ? '06B11' : identityConfigCheck ? '06B10' : manifestCheck ? '06B9' : configurationCheck ? '06B8' : proposalCheck ? '06B7' : runAcceptanceCheck ? '06B6' : creationCheck ? '06B5' : decisionsCheck ? '06B4' : lifecycleCheck ? '06B3' : commandBusinessCheck ? '06B2' : commandCheck ? '06B1' : eventCheck ? '06A' : identityCheck ? '05' : wechatCheck ? '04' : quantBrowserCheck ? '03' : projectionCheck ? '02' : '01';
  fs.writeFileSync(path.join(root, `docs/plans/2026-09-06-review-remediation/records/${reportPrefixOverride ?? (executionHeartbeatCheck ? '06C4-heartbeat' : wakeupSuggestionFocus ? '06C3k-focus' : wakeupSuggestionCheck ? '06C3k' : brainRecordCheck ? '06C3j' : legacyMemoryCheck ? '06C3i' : runSnapshotCheck ? '06C3h' : brainMemoryReviewCheck ? '06C3g' : recordStage)}-postgres.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
