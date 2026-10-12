import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { adaptStandaloneEntrypoint, cleanBuildEnvironment, collectTracedPackages, copyDependencyClosure, copyReleaseTree, safeReleaseFile, within, writeReleaseManifest } from '../release-lib.mjs';
import { createVerificationSnapshot, removeVerificationSnapshot, validateReleaseManifest, readWorkerImportClosure } from '../verify-release.mjs';

test('distribution excludes private runtime data and accepts migration SQL',()=>{
  for(const file of ['.env','app/.env.local','.runtime/state.json','user/.openzhiyu/memory.json','store.db','secrets.pem']) assert.equal(safeReleaseFile(file),false);
  assert.equal(safeReleaseFile('migrations/sql/0155_workshops.sql'),true);
  assert.equal(safeReleaseFile('vendor/python/Lib/site-packages/certifi/cacert.pem'),true);
  for (const file of ['vendor/python/Lib/site-packages/private.pem','components/wechat/cacert.pem','vendor/python/Lib/site-packages/certifi/private.key']) assert.equal(safeReleaseFile(file),false);
  assert.equal(within('C:/work/output','C:/work/output/payload'),true);
  assert.equal(within('C:/work/output','C:/work/other'),false);
});

test('distribution tracing retains exact assets while refusing dynamic directory globs', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-trace-boundary-'));
  const req=createRequire(import.meta.url);
  try {
    await mkdir(join(dir,'assets'));
    await writeFile(join(dir,'assets','private.txt'),'private directory observation');
    await writeFile(join(dir,'fixed.txt'),'required exact asset');
    await writeFile(join(dir,'dep.cjs'),'module.exports=1;');
    await writeFile(join(dir,'entry.cjs'),"const fs=require('fs');const p=require('path');require('./dep.cjs');fs.readFileSync(p.join(__dirname,'fixed.txt'));fs.readFileSync(p.join(__dirname,'assets',process.env.FILE_NAME));");
    const nftPath=req.resolve('next/dist/compiled/@vercel/nft');
    const baseline=await req(nftPath).nodeFileTrace([join(dir,'entry.cjs')],{base:dir,processCwd:dir});
    assert.equal([...baseline.fileList].some(file=>file.replaceAll('\\','/')==='assets/private.txt'),true);
    const preload=fileURLToPath(new URL('../next-trace-boundary.cjs',import.meta.url));
    const code="const nft=require(process.argv[1]);nft.nodeFileTrace([process.argv[2]+'/entry.cjs'],{base:process.argv[2],processCwd:process.argv[2]}).then(x=>process.stdout.write(JSON.stringify([...x.fileList])));";
    const result=await promisify(execFile)(process.execPath,['--require',preload,'-e',code,nftPath,dir],{cwd:dir,windowsHide:true,env:{...process.env,ZHIYU_WINDOWS_DISTRIBUTION:'1'}});
    const files=JSON.parse(result.stdout).map(file=>file.replaceAll('\\','/'));
    assert.equal(files.includes('assets/private.txt'),false);
    for(const asset of ['entry.cjs','dep.cjs','fixed.txt']) assert.equal(files.includes(asset),true);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('isolated standalone launcher runs under the existing ESM application package',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-standalone-esm-'));
  try {
    const server=join(dir,'server.js'),manifest=join(dir,'package.json');
    await writeFile(manifest,'{"type":"module"}');
    await writeFile(server,"const path = require('path')\nprocess.stdout.write(JSON.stringify({directory:path.resolve(__dirname),required:typeof require('node:fs').readFileSync}));");
    assert.equal(await adaptStandaloneEntrypoint(server,manifest),true);
    const result=await promisify(execFile)(process.execPath,[server],{cwd:dir,windowsHide:true});
    assert.deepEqual(JSON.parse(result.stdout),{directory:dir,required:'function'});
    assert.equal(await adaptStandaloneEntrypoint(server,manifest),false);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('ESM standalone wrapper loads webpack hooks only under an explicit CommonJS subtree',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-webpack-boundary-'));
  try {
    const server=join(dir,'server.js'),manifest=join(dir,'package.json'),compiled=join(dir,'dist','server');
    await mkdir(compiled,{recursive:true});await writeFile(manifest,'{"type":"module"}');
    await writeFile(join(compiled,'instrumentation.js'),"const path=require('node:path');module.exports={name:path.basename('/ready.js')};");
    await writeFile(server,"const path = require('path')\nprocess.stdout.write(require('./dist/server/instrumentation.js').name);");
    await adaptStandaloneEntrypoint(server,manifest);
    await assert.rejects(promisify(execFile)(process.execPath,[server],{cwd:dir,windowsHide:true}),/require is not defined/);
    await writeFile(join(compiled,'package.json'),'{"type":"commonjs"}');
    const result=await promisify(execFile)(process.execPath,[server],{cwd:dir,windowsHide:true});assert.equal(result.stdout,'ready.js');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('directory trace entries cannot classify the whole checkout as an npm dependency',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-npm-boundary-'));
  try {
    await writeFile(join(dir,'package.json'),'{"name":"private-checkout","version":"1.0.0"}');
    await mkdir(join(dir,'node_modules','@scope'),{recursive:true});
    await mkdir(join(dir,'node_modules','fixture-npm'));
    await writeFile(join(dir,'node_modules','fixture-npm','package.json'),'{"name":"fixture-npm","version":"1.0.0"}');
    await writeFile(join(dir,'node_modules','fixture-npm','index.js'),'module.exports=1');
    await mkdir(join(dir,'build'));
    await writeFile(join(dir,'build','route.js.nft.json'),JSON.stringify({files:['../node_modules/@scope','../node_modules/fixture-npm/index.js']}));
    const packages=await collectTracedPackages(join(dir,'build'));
    assert.deepEqual(packages.map(pkg=>pkg.data.name),['fixture-npm']);
    await assert.rejects(copyDependencyClosure([{root:dir,data:{name:'private-checkout'}}],join(dir,'payload')),/release_npm_package_root_required/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('build environment never inherits provider secrets or developer public values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-release-'));
  try{
    await mkdir(join(dir,'apps','web'),{recursive:true});
    await writeFile(join(dir,'apps','web','.env.local'),'LLM_API_KEY=private-value\nNEXT_PUBLIC_PRIVATE_ENDPOINT=https://private.example\n');
    const env=cleanBuildEnvironment(dir);
    assert.equal(env.LLM_API_KEY,''); assert.equal(env.NEXT_PUBLIC_PRIVATE_ENDPOINT,'');
    assert.equal(env.SKIP_TYPE_CHECK,'false'); assert.equal(env.ZHIYU_RUNTIME_MODE,'disabled');
    assert.notEqual(env.POSTGRES_URL,process.env.POSTGRES_URL);
    assert.equal(JSON.stringify(env).includes('private-value'),false);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('copy and manifest do not quietly retain developer environment files',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-payload-'));
  try{
    await mkdir(join(dir,'source'));await writeFile(join(dir,'source','.env'),'private');await writeFile(join(dir,'source','server.js'),'console.log(1)');
    await copyReleaseTree(join(dir,'source'),join(dir,'payload'));
    const manifest=await writeReleaseManifest(join(dir,'payload'),{version:'test'});
    assert.deepEqual(manifest.files.map(file=>file.path),['server.js']);
    assert.equal(manifest.files[0].sha256.length,64);
    assert.equal((await readFile(join(dir,'payload','server.js'),'utf8')),'console.log(1)');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('release verification rejects extra files and changed bytes with the same size',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-manifest-check-'));
  try {
    await writeFile(join(dir,'server.js'),'original');
    const manifest=await writeReleaseManifest(dir,{version:'fixture'});
    await validateReleaseManifest(dir,manifest);
    await writeFile(join(dir,'extra.js'),'extra');
    await assert.rejects(validateReleaseManifest(dir,manifest),/release_manifest_file_set_mismatch/);
    await rm(join(dir,'extra.js'));
    await writeFile(join(dir,'server.js'),'tampered');
    await assert.rejects(validateReleaseManifest(dir,manifest),/release_hash:server.js/);
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('worker verification follows reachable split imports and rejects escaped paths', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-worker-imports-'));
  try {
    const worker=join(dir,'worker');await mkdir(join(worker,'chunks'),{recursive:true});
    await writeFile(join(worker,'start-runtime-worker.mjs'),'await import("./chunks/entry.mjs");');
    await writeFile(join(worker,'chunks','entry.mjs'),'import "./shared.mjs"; export { value } from "./transport.mjs";');
    await writeFile(join(worker,'chunks','shared.mjs'),'export const shared=1;');
    await writeFile(join(worker,'chunks','transport.mjs'),'import "./shared.mjs"; export const value="QUANT_PYTHON_BIN";');
    await writeFile(join(worker,'chunks','unreachable.mjs'),'const hidden="not_reachable";');
    const closure=await readWorkerImportClosure(worker);
    assert.deepEqual(closure.files,['chunks/entry.mjs','chunks/shared.mjs','chunks/transport.mjs','start-runtime-worker.mjs']);
    assert.equal(closure.text.includes('QUANT_PYTHON_BIN'),true);
    assert.equal(closure.text.includes('not_reachable'),false);
    await writeFile(join(worker,'chunks','entry.mjs'),'await import("../../outside.mjs");');
    await writeFile(join(dir,'outside.mjs'),'const outside=1;');
    await assert.rejects(readWorkerImportClosure(worker));
    await writeFile(join(worker,'chunks','entry.mjs'),'await import("./missing.mjs");');
    await assert.rejects(readWorkerImportClosure(worker),error=>error.code==='ENOENT');
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test('verification snapshot cannot use the repository as its dependency ancestor',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-snapshot-check-'));
  let snapshot;
  try {
    const workspaceRoot=join(dir,'workspace'),source=join(dir,'source');
    await mkdir(workspaceRoot);await mkdir(source);await writeFile(join(source,'server.js'),'fixture');
    await assert.rejects(createVerificationSnapshot(source,{workspaceRoot,tempBase:workspaceRoot}),/outside_workspace/);
    snapshot=await createVerificationSnapshot(source,{workspaceRoot,tempBase:dir});
    assert.equal(within(workspaceRoot,snapshot.payloadRoot),false);
    assert.equal(await readFile(join(snapshot.payloadRoot,'server.js'),'utf8'),'fixture');
    await removeVerificationSnapshot(snapshot,{workspaceRoot});snapshot=null;
  } finally {
    if(snapshot)await removeVerificationSnapshot(snapshot,{workspaceRoot:join(dir,'workspace')});
    await rm(dir,{recursive:true,force:true});
  }
});

test('an interrupted copy resumes only in its owned directory before runtime initialization',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'zhiyu-copy-resume-'));
  let snapshot;
  const workspaceRoot=join(dir,'workspace'),source=join(dir,'source');
  try {
    await mkdir(workspaceRoot);await mkdir(join(source,'app'),{recursive:true});
    await writeFile(join(source,'app','old.js'),'old');
    snapshot=await createVerificationSnapshot(source,{workspaceRoot,tempBase:dir});
    await mkdir(snapshot.dataDir);
    await assert.rejects(createVerificationSnapshot(source,{workspaceRoot,tempBase:dir,resumeRoot:snapshot.root}),/unstarted_owned_copy/);
    await rm(snapshot.dataDir,{recursive:true});
    await rm(join(source,'app','old.js'));await writeFile(join(source,'app','new.js'),'new');
    const resumed=await createVerificationSnapshot(source,{workspaceRoot,tempBase:dir,resumeRoot:snapshot.root});
    assert.equal(resumed.markerId,snapshot.markerId);
    assert.equal(await readFile(join(resumed.payloadRoot,'app','new.js'),'utf8'),'new');
    await assert.rejects(readFile(join(resumed.payloadRoot,'app','old.js')),error=>error.code==='ENOENT');
    await removeVerificationSnapshot(resumed,{workspaceRoot});snapshot=null;
  } finally {
    if(snapshot)await removeVerificationSnapshot(snapshot,{workspaceRoot});
    await rm(dir,{recursive:true,force:true});
  }
});
