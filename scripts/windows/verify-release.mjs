import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertWithin, filesUnder, safeReleaseFile, sha256, within } from './release-lib.mjs';

const moduleWorkspaceRoot=resolve(fileURLToPath(new URL('../..',import.meta.url)));
export const developerEnvironmentFiles = ['.env', '.env.local', '.env.production', '.env.production.local'];

// Executed only with the final bundled Python and the already-owned verification
// database. Observations are fixed; this script never imports a legacy account.
export const quantVerificationFixture = String.raw`import asyncio, base64, hashlib, hmac, json, os, sys, time, uuid
from datetime import datetime, timedelta
from pathlib import Path
resource = Path(os.environ['ZHIYU_QUANT_RESOURCE_DIR']).resolve()
sys.path.insert(0, str(resource))

def main():
    import psycopg
    from psycopg.rows import dict_row
    from app.install_paths import installation_paths
    from app.install_bootstrap import check_dependencies, initialize, health
    from app.paper_ledger import PaperLedger
    from app.paper_commands import PaperActor, PaperTradingService
    root, owned, data = installation_paths()
    assert Path(sys.executable).resolve().is_relative_to(root)
    assert sys.flags.isolated and sys.flags.dont_write_bytecode and sys.flags.utf8_mode
    owner, account = os.environ['QUANT_PAPER_OWNER_ID'], os.environ['QUANT_PAPER_ACCOUNT_ID']
    admin, database = os.environ['QUANT_INSTALL_ADMIN_DATABASE_URL'], os.environ['QUANT_PAPER_DATABASE_URL']
    def deny_network(event, args):
        if event == 'socket.connect':
            destination = args[1]
            if not isinstance(destination, tuple) or destination[0] not in {'127.0.0.1', 'localhost', '::1'}:
                raise RuntimeError('verification_external_network_denied')
    sys.addaudithook(deny_network)
    dependency = check_dependencies()
    first = health()
    assert first['version'] == 1 and first['orders'] == first['fills'] == first['lots'] == 0
    receipt = initialize()
    assert initialize() == receipt
    with psycopg.connect(admin, row_factory=dict_row) as conn:
        assert Path(conn.execute("SELECT current_setting('data_directory') AS path").fetchone()['path']).resolve() == (owned / 'postgres').resolve()
        capabilities = conn.execute("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='zhiyu_quant'").fetchone()
        assert capabilities is not None and not any(capabilities.values())
        counts = conn.execute("SELECT (SELECT count(*) FROM paper_accounts) AS accounts,(SELECT count(*) FROM paper_commands) AS commands,(SELECT count(*) FROM paper_events) AS events").fetchone()
        assert counts == {'accounts': 1, 'commands': 1, 'events': 1}
        # Only this owned fixture holds scheduler admission while testing resume.
        conn.execute("INSERT INTO runtime_paper_ticks(owner_id,account_id,next_tick_at) VALUES(%s,%s,clock_timestamp()+interval '1 day') ON CONFLICT(owner_id,account_id) DO UPDATE SET next_tick_at=EXCLUDED.next_tick_at", (owner, account))
    denied = []
    for label, statement in [('user_read', 'SELECT * FROM "User"'), ('workshop_read', 'SELECT * FROM workshops'), ('account_delete', 'DELETE FROM paper_accounts'), ('schema_create', 'CREATE TABLE quant_forbidden_fixture(id int)')]:
        with psycopg.connect(database) as conn:
            try: conn.execute(statement)
            except psycopg.errors.InsufficientPrivilege: denied.append(label)
            else: raise AssertionError('quant_role_boundary_failed')
    now = datetime.fromisoformat('2026-09-08T10:00:00+08:00')
    code = '600519.SH'
    observation = {'watchlist': [code], 'watchlistVersion': 'verification-fixed-v1', 'watchlistObservedAt': now.isoformat(), 'watchlistExpiresAt': (now+timedelta(seconds=30)).isoformat(),
        'calendar': {'version': 'verification-calendar', 'date': '2026-09-08', 'source': {'SH': 'fixture', 'SZ': 'fixture', 'BJ': 'fixture'}, 'publishedAt': (now-timedelta(days=1)).isoformat(), 'expiresAt': (now+timedelta(days=1)).isoformat(), 'isTradingDay': True},
        'quotePolicy': {'version': 'verification-policy', 'sources': {'fixture': {'maxAgeSeconds': 30}}},
        'quotes': {code: {'code': code, 'name': '\u9694\u79bb\u884c\u60c5', 'price': '10.000', 'previousClose': '10.000', 'provider': 'fixture', 'observedAt': now.isoformat(), 'quoteSessionDate': '2026-09-08', 'qualityStatus': 'ready', 'quoteId': 'verification-fixed-quote'}}}
    ledger = PaperLedger(database)
    service = PaperTradingService(ledger, lambda: observation, clock=lambda: now, control_guard=lambda: None)
    actor = PaperActor(owner, 'verification-owner', 'owner')
    request = {'code': code, 'side': 'buy', 'quantity': 100, 'limit_price': '10.00'}
    submitted = service.submit(actor, account, 'verification-submit', request)
    assert submitted['result']['status'] == 'accepted'
    assert service.submit(actor, account, 'verification-submit', request) == submitted
    matched = service.match_tick(PaperActor(owner, 'verification-scheduler', 'scheduler'), account, 'verification-fixed-tick')
    assert len(matched['result']['matched']) == 1
    assert service.match_tick(PaperActor(owner, 'verification-scheduler', 'scheduler'), account, 'verification-fixed-tick') == matched
    state = ledger.read(owner, account)
    assert len(state['state']['fills']) == len(state['state']['lots']) == 1
    assert initialize() == receipt and ledger.read(owner, account) == state
    assert json.loads((data/'watchlist.json').read_text(encoding='utf-8')) == {'codes': []}
    assert not (data/'paper_account.json').exists()
    import httpx
    from app.main import app
    def headers(path, owner_id=owner):
        claims = {'ownerId': owner_id, 'role': 'owner', 'actorId': 'verification-owner', 'issuedAt': time.time(), 'expiresAt': time.time()+60, 'method': 'GET', 'path': path, 'bodySha256': hashlib.sha256(b'').hexdigest()}
        encoded = base64.urlsafe_b64encode(json.dumps(claims,separators=(',',':')).encode()).decode().rstrip('=')
        return {'authorization': 'Bearer '+os.environ['QUANT_INTERNAL_TOKEN'], 'x-zhiyu-paper-context': encoded, 'x-zhiyu-paper-signature': hmac.new(os.environ['QUANT_PAPER_SIGNING_KEY'].encode(),encoded.encode(),hashlib.sha256).hexdigest()}
    async def signed_checks():
        path = '/paper/v2/accounts/'+account
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://verification.local') as client:
            assert (await client.get(path)).status_code == 401
            assert (await client.get(path,headers=headers(path))).status_code == 200
            assert (await client.get(path,headers=headers(path,str(uuid.uuid4())))).status_code == 403
            invalid = headers(path); invalid['x-zhiyu-paper-signature'] = '0'*64
            assert (await client.get(path,headers=invalid)).status_code == 401
    asyncio.run(signed_checks())
    return {'event': 'quant_release_fixture', 'ok': True, 'python': str(Path(sys.executable).resolve()), 'pythonVersion': sys.version.split()[0], 'dependencies': dependency['dependencies'],
        'freshEmpty': True, 'initialVersion': first['version'], 'finalVersion': state['version'], 'bootstrapReplay': True, 'paperReplay': True, 'fixedMarketFills': 1,
        'roleDenied': denied, 'roleCapabilities': capabilities, 'ownerBound': True, 'signedBoundary': True, 'legacyImported': False, 'watchlistEmpty': True,
        'runtimeMatchingHeldByOwnedFixture': True, 'realMarketCalls': 0, 'realModelCalls': 0}
try:
    print(json.dumps(main(),separators=(',',':')))
except Exception as error:
    print(json.dumps({'event':'quant_release_fixture','ok':False,'error':'quant_verification_fixture_failed','errorType':type(error).__name__},separators=(',',':')))
    sys.exit(1)
`;

export async function collectPrivateDeveloperValues(workspaceRoot, parseEnv) {
  const values = new Set();
  for (const envName of developerEnvironmentFiles) {
    const envPath = join(workspaceRoot, 'apps', 'web', envName);
    if (!existsSync(envPath)) continue;
    const parsed = parseEnv(await readFile(envPath));
    for (const [key, value] of Object.entries(parsed)) {
      if (/(?:API_KEY|SECRET|ENCRYPTION_KEY|PASSWORD|POSTGRES_URL|DATABASE_URL|TOKEN|CREDENTIALS?)(?:$|_)/i.test(key) &&
          typeof value === 'string' && value.length >= 12) values.add(value);
    }
  }
  return values;
}

export async function assertIsolatedVerificationPath(workspaceRoot, target) {
  const physicalWorkspace = await realpath(workspaceRoot);
  const physicalTarget = await realpath(target);
  if (within(physicalWorkspace, physicalTarget) || within(physicalTarget, physicalWorkspace)) {
    throw new Error('verification_directory_must_be_outside_workspace');
  }
  return physicalTarget;
}

export async function createVerificationSnapshot(stageRoot, { workspaceRoot = moduleWorkspaceRoot,
  tempBase = process.env.ZHIYU_VERIFY_TEMP_DIR || tmpdir(), resumeRoot } = {}) {
  // A caller may select another existing disk when the workspace disk is full.
  // Resolve junctions before creating a unique directory, never adopt an existing payload.
  const physicalBase = await realpath(resolve(tempBase));
  if (!(await stat(physicalBase)).isDirectory()) throw new Error('verification_temp_base_invalid');
  if (within(await realpath(workspaceRoot), physicalBase)) throw new Error('verification_directory_must_be_outside_workspace');
  const root = resumeRoot ? resolve(resumeRoot) : await mkdtemp(join(physicalBase, 'zhiyu-release-check-'));
  if(resumeRoot&&(!/^zhiyu-release-check-/.test(basename(root))||!within(physicalBase,root)||root===physicalBase))throw new Error('verification_resume_not_owned');
  const snapshot = { root, payloadRoot: join(root, 'payload'), dataDir: join(root, 'data'),
    tempBase: physicalBase, markerId: randomUUID() };
  if(await assertIsolatedVerificationPath(workspaceRoot, root)!==root)throw new Error('verification_root_redirected');
  if(resumeRoot){
    snapshot.markerId=(await readFile(join(root,'.zhiyu-verification-owned'),'utf8')).trim();
    if(!/^[a-f0-9-]{36}$/.test(snapshot.markerId)||existsSync(snapshot.dataDir))throw new Error('verification_resume_requires_unstarted_owned_copy');
    if(existsSync(snapshot.payloadRoot)){
      if(await realpath(snapshot.payloadRoot)!==snapshot.payloadRoot)throw new Error('verification_payload_redirected');
      await filesUnder(snapshot.payloadRoot);
      for(const directory of ['app','worker','migrations']){
        const source=join(snapshot.payloadRoot,directory),target=join(root,`previous-${directory}-${Date.now()}`);
        assertWithin(root,source);assertWithin(root,target);
        if(existsSync(source))await rename(source,target);
      }
    }
  }else await writeFile(join(root, '.zhiyu-verification-owned'), snapshot.markerId, { mode: 0o600 });
  try {
    // The payload is checked without filtering first; forbidden files or links must fail.
    for (const file of await filesUnder(stageRoot)) {
      if (!safeReleaseFile(relative(stageRoot, file))) throw new Error('verification_payload_contains_private_file');
    }
    if(process.platform==='win32'){
      const executable=join(process.env.SystemRoot||'C:\\Windows','System32','robocopy.exe');
      const log=createWriteStream(join(root,'payload-copy.log'));
      const child=spawn(executable,[await realpath(stageRoot),snapshot.payloadRoot,'/E','/COPY:DAT','/DCOPY:DAT','/R:0','/W:0','/MT:16','/XJ','/NP','/NFL','/NDL','/NJH','/NJS'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
      const code=await new Promise((accept,reject)=>{child.once('error',reject);child.once('close',accept);});log.end();
      await writeFile(join(root,'payload-copy.json'),JSON.stringify({method:'robocopy',exitCode:code,concurrency:16,source:await realpath(stageRoot),destination:snapshot.payloadRoot})+'\n');
      if(!Number.isInteger(code)||code<0||code>=8)throw new Error(`verification_copy_failed:${code}`);
    }else await cp(stageRoot, snapshot.payloadRoot, { recursive: true, dereference: false, errorOnExist: true, force: false });
    return snapshot;
  } catch (error) {
    error.verificationSnapshot=snapshot;
    throw error;
  }
}

export async function removeVerificationSnapshot(snapshot, { workspaceRoot = moduleWorkspaceRoot } = {}) {
  if (!snapshot?.root || !/^zhiyu-release-check-/.test(basename(snapshot.root))) throw new Error('verification_cleanup_not_owned');
  const physicalRoot = await assertIsolatedVerificationPath(workspaceRoot, snapshot.root);
  if (physicalRoot !== resolve(snapshot.root) || !within(snapshot.tempBase, physicalRoot) || physicalRoot === resolve(snapshot.tempBase)) {
    throw new Error('verification_cleanup_path_invalid');
  }
  if ((await readFile(join(physicalRoot, '.zhiyu-verification-owned'), 'utf8')) !== snapshot.markerId) {
    throw new Error('verification_cleanup_not_owned');
  }
  await rm(physicalRoot, { recursive: true, force: false });
}

export async function validateReleaseManifest(stageRoot, manifest, { onProgress } = {}) {
  const actualFiles=(await filesUnder(stageRoot)).map(file=>relative(stageRoot,file).replaceAll('\\','/')).filter(file=>file!=='release-manifest.json').sort();
  assert.deepEqual(actualFiles,manifest.files.map(file=>file.path).sort(),'release_manifest_file_set_mismatch');
  for (let offset=0;offset<manifest.files.length;offset+=32) {
    await Promise.all(manifest.files.slice(offset,offset+32).map(async item=>{
      const file=join(stageRoot,...item.path.split('/'));assertWithin(stageRoot,file);
      assert.equal(safeReleaseFile(item.path),true,item.path);
      const size=(await stat(file)).size;
      assert.equal(size,item.size,`release_size:${item.path}`);
      assert.equal(await sha256(file,size),item.sha256,`release_hash:${item.path}`);
    }));
    if(onProgress&&(offset%8192===0||offset+32>=manifest.files.length))onProgress(Math.min(offset+32,manifest.files.length),manifest.files.length);
  }
}

export async function readWorkerImportClosure(workerRoot) {
  const root = await realpath(workerRoot), pending = [join(root, 'start-runtime-worker.mjs')], files = [], sources = [];
  const visited = new Set();
  while (pending.length) {
    const file = pending.pop();
    assertWithin(root, file);
    const physical = await realpath(file);
    assertWithin(root, physical);
    if (visited.has(physical)) continue;
    visited.add(physical);
    const source = await readFile(physical, 'utf8');
    files.push(relative(root, physical).replaceAll('\\', '/'));
    sources.push(source);
    // esbuild emits exact local .mjs paths for static imports/re-exports and
    // dynamic split points. Inspect reachable output, rather than the wrapper.
    for (const match of source.matchAll(/\b(?:from|import)\s*["'](\.[^"']+)["']|\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const specifier = match[1] || match[2];
      assert.match(specifier, /\.mjs$/, 'worker_import_extension_invalid');
      pending.push(resolve(dirname(physical), specifier));
    }
  }
  return { files: files.sort(), text: sources.join('\n') };
}

export async function verifyRelease({ workspaceRoot = moduleWorkspaceRoot,
  stageRoot = resolve(process.argv[2] || join(workspaceRoot,'output','windows-installer','payload-0.5.0')),
  tempBase = process.env.ZHIYU_VERIFY_TEMP_DIR || tmpdir(), resumeRoot=process.env.ZHIYU_VERIFY_SNAPSHOT } = {}) {
const checkRoot=join(workspaceRoot,'output','windows-installer-check',`check-${Date.now()}-${randomUUID().slice(0,8)}`);
assertWithin(workspaceRoot,checkRoot);
await mkdir(checkRoot,{recursive:true});
const report={schemaVersion:1,startedAt:new Date().toISOString(),stageRoot,checkRoot,checks:[],screenshots:[],productionModelCalls:false};
const record=(name,result)=>{report.checks.push({name,...result});console.log(JSON.stringify({check:name,...result}));};
const delay=ms=>new Promise(done=>setTimeout(done,ms));
const req=createRequire(join(workspaceRoot,'apps','web','package.json'));
let manager,managerPort,token,browser,snapshot,dataDir,executionRoot,node,quantEnabled=false;
const quantPids=new Set();
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
function launchManager(label){
  const log=createWriteStream(join(checkRoot,`${label}.log`));
  const child=spawn(node,[join(executionRoot,'runtime','manager.mjs'),'--install-root',executionRoot,'--data-dir',dataDir],{cwd:snapshot.root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});child.once('exit',()=>log.end());
  manager=child;return child;
}
const heartbeatFresh=value=>!!value?.components?.worker?.lastHeartbeat&&Date.now()-Date.parse(value.components.worker.lastHeartbeat)<20000;
async function waitFor(test,timeout=120000){const until=Date.now()+timeout;while(Date.now()<until){const value=await test();if(value)return value;await delay(500);}throw new Error('release_verification_timeout');}
function state(){try{return JSON.parse(readFileSync(join(dataDir,'runtime','state.json'),'utf8'));}catch{return null;}}
async function api(path,method='GET',body,headers={}){
  const response=await fetch(`http://127.0.0.1:${managerPort}${path}`,{method,headers:{'X-Zhiyu-Token':token,Origin:`http://127.0.0.1:${managerPort}`,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(240000)});
  const value=await response.json();if(!response.ok)throw new Error(`${path}:${value.error||response.status}`);return value;
}
function componentEvents(){
  const file=join(dataDir,'logs','manager-events.jsonl');
  return existsSync(file)?readFileSync(file,'utf8').split(/\r?\n/).filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean):[];
}
async function quantEnvironment({bootstrap=false}={}){
  const config=JSON.parse(await readFile(join(dataDir,'private','config.json'),'utf8'));
  const current=await api('/api/status');
  const {childEnvironment}=await import(pathToFileURL(join(executionRoot,'runtime','security.mjs')).href);
  const {RuntimeComponents}=await import(pathToFileURL(join(executionRoot,'runtime','components.mjs')).href);
  const components=new RuntimeComponents({options:{installRoot:executionRoot},dataDir,config});
  const base=childEnvironment(dataDir,config,current.components.database.port,current.components.web.port);
  const hostEnv=components.environment(base);
  hostEnv.PATH=[join(executionRoot,'vendor','node'),join(executionRoot,'vendor','postgres','bin'),join(process.env.SystemRoot||'C:\\Windows','System32')].join(process.platform==='win32'?';':':');
  const env=components.privateEnvironment('quant',hostEnv);
  for(const key of ['DATABASE_URL','POSTGRES_URL','ZHIYU_BOOTSTRAP_DB_URL','LLM_API_KEY','AUTH_SECRET','ENCRYPTION_KEY','WECHAT_DESKTOP_TOKEN'])assert.equal(env[key],undefined,`quant_private_environment:${key}`);
  if(bootstrap)Object.assign(env,{QUANT_INSTALL_ADMIN_DATABASE_URL:base.DATABASE_URL,QUANT_INSTALL_DATABASE_ROLE:'zhiyu_quant',QUANT_INSTALL_DATABASE_PASSWORD:config.components.quant.databasePassword,QUANT_INSTALL_BOOTSTRAP_COMMAND_ID:config.components.quant.commandId,QUANT_INSTALL_INITIAL_CASH:'1000000.00'});
  return {env,hostEnv,config,current};
}
async function quantPython(script,args,env,label){
  const python=join(executionRoot,'vendor','python','python.exe');
  assertWithin(snapshot.root,script);assertWithin(executionRoot,python);
  // Exact child wait; a pipe must not turn exit0 into an unverified receipt.
  const result=await promisify(execFile)(python,['-I','-B','-X','utf8','-u',script,...args],{cwd:join(dataDir,'app'),env,windowsHide:true,timeout:90000,maxBuffer:4*1024*1024,encoding:'utf8'});
  const lines=result.stdout.split(/\r?\n/).filter(Boolean);assert.equal(lines.length,1,`${label}_receipt_count`);
  const receipt=JSON.parse(lines[0]);assert.equal(receipt.ok,true,receipt.error||`${label}_not_confirmed`);
  await writeFile(join(checkRoot,`${label}.json`),JSON.stringify(receipt,null,2)+'\n');
  return receipt;
}
async function quantProcess(pid){
  assert.equal(Number.isInteger(pid)&&pid>0,true,'quant_pid_invalid');
  const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const script=join(snapshot.root,'inspect-quant-process.ps1');
  await writeFile(script,`[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)\n$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'\nif ($null -eq $p) { exit 3 }\n$p | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress\n`,'utf8');
  const result=await promisify(execFile)(powershell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script],{windowsHide:true,timeout:20000,encoding:'utf8'});
  const value=JSON.parse(result.stdout.trim());
  assert.equal(await realpath(value.ExecutablePath),await realpath(join(executionRoot,'vendor','python','python.exe')),'quant_global_python_used');
  assert.equal(value.CommandLine.includes(join(executionRoot,'components','quant','embedded_worker.py')),true,'quant_resource_outside_payload');
  assert.match(value.CommandLine,/-I\s+-B\s+-X\s+utf8\s+-u/,'quant_python_isolation_flags_missing');
  return {pid:value.ProcessId,parentPid:value.ParentProcessId,python:value.ExecutablePath,resource:join(executionRoot,'components','quant','embedded_worker.py'),isolatedFlags:true};
}
async function quantWebRead(ready,label){
  let diagnostics;
  await waitFor(async()=>{
    const response=await fetch(new URL('/api/storage/diagnostics',ready.webUrl),{signal:AbortSignal.timeout(20000)});
    assert.equal(response.status,200);const value=await response.json();
    diagnostics=value.externalStores?.quant;
    return diagnostics?.available&&diagnostics.runtime?.running&&Number.isInteger(diagnostics.runtime.pid)?diagnostics:null;
  },60000);
  const pid=diagnostics.runtime.pid;quantPids.add(pid);
  const process_=await quantProcess(pid);
  const observation=await waitFor(()=>componentEvents().find(item=>item.event==='quant_process_observed'&&item.phase==='running'&&item.pid===pid&&item.hostPid===process_.parentPid),10000);
  assert.equal(observation.hostPid,ready.components.web.pid,'quant_not_owned_by_web_host');
  for(const value of Object.values(diagnostics.diagnostics.files||{}))assertWithin(dataDir,value.path);
  assert.equal(diagnostics.diagnostics.tdx_local.enabled,false);assert.equal(diagnostics.diagnostics.tdx_local.available,false);
  assert.equal(diagnostics.diagnostics.counts.watchlist_codes,0);
  await waitFor(async()=>{const response=await fetch(new URL('/api/quant/paper/account',ready.webUrl),{signal:AbortSignal.timeout(20000)});if(response.status!==200){await response.body?.cancel();return null;}const account=await response.json();return account.storage==='postgres'&&!account.migrationRequired?account:null;},60000);
  record(label,{passed:true,...process_,observedByManager:true,realMarketCalls:0,emptyWatchlist:true});
}
async function quantExitCheck(label){
  const pids=[...quantPids];
  for(const pid of pids)await waitFor(()=>!alive(pid),10000);
  const events=componentEvents().filter(item=>item.event==='quant_process_observed'&&pids.includes(item.pid));
  for(const pid of pids){const stopped=events.findLast(item=>item.pid===pid&&item.phase==='stopped');assert.equal(stopped?.exitCode,0,'quant_natural_exit_not_confirmed');}
  record(label,{passed:true,pids,processExitConfirmed:true,naturalExitConfirmed:true,events:events.map(({pid,hostPid,phase,exitCode})=>({pid,hostPid,phase,exitCode}))});
  quantPids.clear();
}
async function quantHealth(label){
  const {env}=await quantEnvironment();
  const receipt=await quantPython(join(executionRoot,'components','quant','scripts','install_bootstrap.py'),['--health'],env,label);
  assert.equal(receipt.event,'quant_install_health');assert.equal(receipt.accountId,report.quantAccountId);assert.equal(receipt.ownerBound,true);assert.equal(receipt.version,report.quantFixture.finalVersion);
  record(label,{passed:true,accountId:receipt.accountId,version:receipt.version,ownerBound:true});
}
try{
  const manifest=JSON.parse(await readFile(join(stageRoot,'release-manifest.json'),'utf8'));
  report.sourceManifestSha256 = await sha256(join(stageRoot, 'release-manifest.json'));
  quantEnabled=manifest.optionalComponents?.quant===true;report.optionalQuantEnabled=quantEnabled;report.realMarketCalls=false;
  await validateReleaseManifest(stageRoot,manifest,{onProgress:(completed,total)=>console.log(JSON.stringify({stage:'source_hash',completed,total}))});
  record('release_manifest',{passed:true,fileCount:manifest.files.length});
  // Exact private values are checked locally; values and hashes are never included in reports.
  const privateValues=await collectPrivateDeveloperValues(workspaceRoot,req('dotenv').parse);
  let textFiles=0;
  const textPaths=(await filesUnder(stageRoot)).filter(file=>/\.(?:js|mjs|cjs|json|html|yaml|yml|md|txt|py|ps1)$/i.test(file));
  for(let offset=0;offset<textPaths.length;offset+=8){
    await Promise.all(textPaths.slice(offset,offset+8).map(async file=>{
      const text=await readFile(file,'utf8');textFiles++;
      for(const value of privateValues)assert.equal(text.includes(value),false,'private_developer_value_in_release');
    }));
  }
  record('private_values_absent',{passed:true,textFiles});
  console.log(JSON.stringify({stage:'isolated_copy_started',resumed:!!resumeRoot}));
  snapshot=await createVerificationSnapshot(stageRoot,{workspaceRoot,tempBase,resumeRoot});
  executionRoot=snapshot.payloadRoot;dataDir=snapshot.dataDir;node=join(executionRoot,'vendor','node','node.exe');
  report.executionRoot=executionRoot;report.dataDir=dataDir;
  // Hash the relocated copy against the source manifest too. Concurrent changes
  // during copying must not produce a passing receipt for a different payload.
  await validateReleaseManifest(executionRoot,manifest,{onProgress:(completed,total)=>console.log(JSON.stringify({stage:'isolated_copy_hash',completed,total}))});
  record('isolated_payload',{passed:true,executionRoot,workspaceFallback:false});
  launchManager('manager');
  const initial=await waitFor(()=>{if(manager.exitCode!==null)throw Error('manager_initialization_exited');const value=state();return value?.status==='setup_required'?value:null;},20000);
  managerPort=initial.managerPort;token=(await readFile(join(dataDir,'runtime','control-token'),'utf8')).trim();
  assert.equal(initial.components.model.phase,'not_configured');assert.equal(initial.components.wechat.phase,manifest.optionalComponents?.wechat?'disabled':'not_installed');
  assert.equal(initial.components.quant.phase,quantEnabled?'disabled':'not_installed');
  record('first_launch_setup',{passed:true,managerPort});
  let response=await fetch(`http://127.0.0.1:${managerPort}/api/status`);assert.equal(response.status,403);
  response=await fetch(`http://127.0.0.1:${managerPort}/api/start`,{method:'POST',headers:{'X-Zhiyu-Token':token,Origin:'https://untrusted.example'}});assert.equal(response.status,403);
  record('control_boundary',{passed:true,unauthorizedStatus:403,crossOriginStatus:403});
  const duplicate=spawn(node,[join(executionRoot,'runtime','manager.mjs'),'--install-root',executionRoot,'--data-dir',dataDir],{cwd:snapshot.root,windowsHide:true,stdio:'ignore'});
  assert.equal(await new Promise(done=>duplicate.once('exit',done)),0);assert.equal(state().pid,manager.pid);
  record('duplicate_start',{passed:true});
  const {chromium}=req('playwright');
  browser=await chromium.launch({headless:true,executablePath:chromium.executablePath()});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(`${initial.setupUrl}#token=${token}`);await page.getByText('首次使用：',{exact:false}).waitFor();
  const setupShot=join(checkRoot,'setup.png');await page.screenshot({path:setupShot,fullPage:true});report.screenshots.push(setupShot);
  assert.equal(await page.locator('#start').isDisabled(),true);assert.equal(await page.locator('#api-key').inputValue(),'');
  record('setup_browser',{passed:true});
  // A loopback mock config exercises installation lifecycle without a paid model call.
  await page.locator('#base-url').fill('http://127.0.0.1:1/v1');
  await page.locator('#model-name').fill('installation-lifecycle-test');
  await page.locator('#api-key').fill('installation-test-key-not-a-real-provider-key');
  await page.locator('#save').click();
  await waitFor(async()=>{const config=await api('/api/config');return config.model==='installation-lifecycle-test'&&config.hasApiKey;},15000);
  await waitFor(async()=>!await page.locator('#start').isDisabled(),15000);
  assert.equal(await page.locator('#api-key').inputValue(),'');
  record('setup_form_save',{passed:true,keyNotEchoed:true});
  if(quantEnabled){
    const selection=await api('/api/components','POST',{quantEnabled:true,wechatEnabled:false,wechatReadConsent:false,wechatSendEnabled:false});
    assert.equal(selection.components.quantEnabled,true);assert.equal(selection.components.wechatEnabled,false);
    // Persist pause before the first worker tick; no market/model task is admitted.
    await api('/api/shutdown','POST');await waitFor(()=>manager.exitCode!==null,60000);assert.equal(manager.exitCode,0);
    const file=join(dataDir,'private','config.json'),config=JSON.parse(await readFile(file,'utf8'));config.desiredStatus='paused';
    await writeFile(file,JSON.stringify(config)+'\n',{mode:0o600});
    launchManager('manager-quant-first-paused');
    const fresh=await waitFor(()=>{if(manager.exitCode!==null)throw Error('manager_quant_initialization_exited');const value=state();return value?.pid===manager.pid&&value.managerPort?value:null;},20000);
    managerPort=fresh.managerPort;token=(await readFile(join(dataDir,'runtime','control-token'),'utf8')).trim();
    record('quant_component_selection',{passed:true,initialPausePersisted:true,wechatEnabled:false});
  }else await api('/api/start','POST');
  const ready=await waitFor(async()=>{const s=await api('/api/status');if(s.status==='failed')throw Error(`release_start_failed:${s.error}`);return s.status===(quantEnabled?'paused':'running')&&heartbeatFresh(s)?s:null;},120000);
  assert.equal(ready.components.web.phase,'running');assert.equal(ready.components.worker.phase,quantEnabled?'paused':'running');
  record('private_database_web_worker',{passed:true,webUrl:ready.webUrl,workerHeartbeat:ready.components.worker.lastHeartbeat,modelValidated:false});
  if(quantEnabled){
    assert.equal(ready.components.quant.phase,'ready');
    const {env,hostEnv,config}=await quantEnvironment({bootstrap:true});
    for(const [key,path] of Object.entries({QUANT_PYTHON_BIN:join(executionRoot,'vendor','python','python.exe'),ZHIYU_QUANT_RESOURCE_DIR:join(executionRoot,'components','quant'),ZHIYU_ASTOCK_RESOURCE_DIR:join(executionRoot,'components','a-stock-data'),QUANT_DATA_DIR:join(dataDir,'quant')}))assert.equal(env[key],path);
    assert.equal(env.ZHIYU_QUANT_INSTALL_MODE,'1');assert.equal(env.QUANT_TRANSPORT,'embedded');assert.equal(hostEnv.ZHIYU_RUNTIME_START_PAUSED,'1');
    const workerClosure=await readWorkerImportClosure(join(executionRoot,'worker'));
    for(const symbol of ['ZHIYU_QUANT_RESOURCE_DIR','QUANT_PYTHON_BIN','quant_stop_unconfirmed','QUANT_PAPER_DATABASE_URL'])assert.equal(workerClosure.text.includes(symbol),true,`quant_worker_bundle:${symbol}`);
    record('quant_packaged_paths',{passed:true,python:env.QUANT_PYTHON_BIN,resource:env.ZHIYU_QUANT_RESOURCE_DIR,data:env.QUANT_DATA_DIR,workerPid:ready.components.worker.pid,workerBundleAndEnvironmentVerified:true,workerImportFiles:workerClosure.files,workerPythonPidObserved:false});
    const script=join(snapshot.root,'quant-release-fixture.py');await writeFile(script,quantVerificationFixture,'utf8');
    const receipt=await quantPython(script,[],env,'quant-fixture');assert.equal(receipt.event,'quant_release_fixture');
    report.quantFixture=receipt;report.quantAccountId=config.components.quant.accountId;
    record('quant_fresh_account_role_fixed_market_replay',{passed:true,...receipt});
    await quantWebRead(ready,'quant_web_engine_owned_pid');
  }
  await page.goto(ready.webUrl);await page.waitForLoadState('domcontentloaded');
  await page.getByRole('link',{name:'智能体车间',exact:true}).waitFor({state:'visible',timeout:30000});
  await page.locator('textarea[data-testid="multimodal-input"]').waitFor({state:'visible',timeout:60000});
  await page.getByRole('heading',{name:'今天，从哪件事开始？',exact:true}).waitFor({state:'visible',timeout:60000});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});
  const webShot=join(checkRoot,'workbench.png');await page.screenshot({path:webShot,fullPage:true});report.screenshots.push(webShot);
  assert.equal((await page.locator('body').innerText()).includes('Application error'),false);
  assert.equal((await page.locator('body').innerText()).includes('Internal Server Error'),false);
  record('workbench_browser',{passed:true,url:page.url()});
  await page.getByRole('link',{name:'智能体车间',exact:true}).click();await page.waitForURL('**/workshop');
  await page.waitForLoadState('domcontentloaded');
  await page.getByRole('heading',{name:'创建第一个智能体车间',exact:true}).waitFor({state:'visible',timeout:60000});
  await page.getByRole('button',{name:'新建智能体车间',exact:true}).waitFor({state:'visible',timeout:60000});
  await page.setViewportSize({width:1100,height:800});
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));});
  await page.keyboard.press('Tab');
  const keyboardFocus=await page.evaluate(()=>document.activeElement?.tagName);
  assert.notEqual(keyboardFocus,'BODY');
  const workshopShot=join(checkRoot,'workshop-desktop.png');await page.screenshot({path:workshopShot,fullPage:true});report.screenshots.push(workshopShot);
  assert.equal((await page.locator('body').innerText()).includes('Application error'),false);
  record('workshop_desktop_navigation',{passed:true,width:1100,height:800,keyboardFocus,url:page.url()});
  await api('/api/pause','POST');await waitFor(async()=>{const s=await api('/api/status');return s.status==='paused'?s:null;},30000);
  record('pause_confirmed',{passed:true});
  const backup=await api('/api/backup','POST');assert.equal(existsSync(join(backup.path,'backup.json')),true);
  assert.equal((await api('/api/status')).status,'paused');
  record('backup_and_paused_restart',{passed:true});
  if(quantEnabled){await quantExitCheck('quant_backup_engine_exit');await quantHealth('quant_backup_account_preserved');await quantWebRead(await api('/api/status'),'quant_backup_new_engine');}
  await api('/api/shutdown','POST');await waitFor(()=>manager.exitCode!==null,60000);
  assert.equal(manager.exitCode,0);assert.equal(state().components.database.phase,'stopped');
  if(quantEnabled)await quantExitCheck('quant_shutdown_engine_exit');
  launchManager('manager-reopen');
  const reopened=await waitFor(()=>{if(manager.exitCode!==null)throw Error('manager_reopen_exited');const s=state();return s?.pid===manager.pid&&s.managerPort?s:null;},20000);
  managerPort=reopened.managerPort;token=(await readFile(join(dataDir,'runtime','control-token'),'utf8')).trim();
  const recovered=await waitFor(async()=>{const s=await api('/api/status');if(s.status==='failed')throw Error(`manager_reopen_failed:${s.error}`);return s.status==='paused'&&heartbeatFresh(s)?s:null;},120000);
  assert.equal(recovered.components.worker.phase,'paused');
  record('paused_manager_reopen',{passed:true,workerHeartbeat:recovered.components.worker.lastHeartbeat});
  if(quantEnabled){await quantHealth('quant_reopened_account_preserved');await quantWebRead(recovered,'quant_reopened_engine');}
  await api('/api/resume','POST');await waitFor(async()=>{const s=await api('/api/status');return s.status==='running'?s:null;},30000);
  await api('/api/stop','POST');assert.equal((await api('/api/status')).status,'stopped');
  assert.equal(existsSync(join(dataDir,'postgres','PG_VERSION')),true);
  record('stop_preserves_data',{passed:true});
  if(quantEnabled)await quantExitCheck('quant_stop_engine_exit');
  report.passed=true;
}catch(error){
  if(error.verificationSnapshot){snapshot=error.verificationSnapshot;dataDir=snapshot.dataDir;executionRoot=snapshot.payloadRoot;report.executionRoot=executionRoot;report.dataDir=dataDir;}
  report.passed=false;report.error=String(error.message);record('verification_error',{passed:false,error:report.error});process.exitCode=1;
}
finally{
  await browser?.close().catch(()=>{});
  if(manager&&manager.exitCode===null){
    if(managerPort&&token)await api('/api/shutdown','POST').catch(()=>{});
    await waitFor(()=>manager.exitCode!==null,65000).catch(()=>manager.kill());
    if(manager.exitCode===null)await waitFor(()=>manager.exitCode!==null,10000).catch(()=>{});
  }
  if(quantEnabled&&snapshot){
    try{
      const observed=[...new Set(componentEvents().filter(item=>item.event==='quant_process_observed'&&Number.isInteger(item.pid)).map(item=>item.pid))];
      for(const pid of observed){
        if(alive(pid)&&!report.passed){
          await quantProcess(pid); // Validate executable and resource ownership before fallback.
          process.kill(pid);record('failure_owned_quant_force_stop',{passed:true,pid,natural:false});
        }
        await waitFor(()=>!alive(pid),10000);
      }
      record('all_owned_quant_processes_exited',{passed:true,pids:observed});
    }catch(error){report.passed=false;report.error='quant_cleanup_not_confirmed';process.exitCode=1;record('all_owned_quant_processes_exited',{passed:false,error:error.code||'quant_stop_unconfirmed'});}
  }
  if(report.passed && manager && (manager.exitCode!==0 || state()?.status!=='stopped' || state()?.components?.database?.phase!=='stopped')) {
    report.passed=false;report.error='manager_shutdown_not_confirmed';process.exitCode=1;
    record('shutdown_confirmed',{passed:false,error:report.error});
  }
  if(snapshot&&existsSync(join(dataDir,'postgres','PG_VERSION'))){
    try {
      await assertIsolatedVerificationPath(workspaceRoot,snapshot.root);
      assert.equal(await readFile(join(snapshot.root,'.zhiyu-verification-owned'),'utf8'),snapshot.markerId);
      const cluster=join(dataDir,'postgres');assertWithin(snapshot.root,cluster);
      const pgCtl=join(executionRoot,'vendor','postgres','bin','pg_ctl.exe');
      const command=promisify(execFile);
      const status=async()=>{try{await command(pgCtl,['-D',cluster,'status'],{cwd:snapshot.root,windowsHide:true,timeout:10000});return true;}catch(error){if(error.code===3)return false;throw error;}};
      const remainedRunning=await status();
      if(remainedRunning){
        if(report.passed){report.passed=false;report.error='manager_database_stop_not_confirmed';process.exitCode=1;}
        await command(pgCtl,['-D',cluster,'-m','fast','-w','-t','60','stop'],{cwd:snapshot.root,windowsHide:true,timeout:65000});
      }
      const stopped=!await status();assert.equal(stopped,true,'verification_private_database_stop_not_confirmed');
      record(remainedRunning?'failure_private_database_stop':'private_database_actual_stopped',{passed:true,statusExitCode:3,cluster,managerStopConfirmed:!remainedRunning});
    } catch(error) {report.passed=false;report.error='private_database_stop_not_confirmed';process.exitCode=1;record('private_database_actual_stopped',{passed:false,error:error.code||'stop_unconfirmed'});}
  }
  if(report.passed)record('shutdown_confirmed',{passed:true});
  if(snapshot) {
    report.isolatedDirectoryPreserved=true;
    if(report.passed && (!manager || manager.exitCode!==null)) {
      try { await removeVerificationSnapshot(snapshot,{workspaceRoot}); report.isolatedDirectoryPreserved=false; }
      catch(error) { report.cleanupError=String(error.message); }
    }
  }
  report.completedAt=new Date().toISOString();await writeFile(join(checkRoot,'verification.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({report:join(checkRoot,'verification.json'),passed:report.passed}));
}
return report;
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  await verifyRelease();
}
