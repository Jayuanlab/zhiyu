import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { parse } from 'dotenv';

const phase=process.argv[2];
assert(['apply','verify'].includes(phase),'phase_required');
const target='http://127.0.0.1:7897';
const file=new URL('../.env.local',import.meta.url);
const dir=new URL('../../../docs/verification/artifacts/jev-proxy-2026-10-09/',import.meta.url);
const hash=value=>createHash('sha256').update(value).digest('hex');
const original=await readFile(file);
const text=new TextDecoder('utf-8',{fatal:true}).decode(original);
assert(Buffer.from(text,'utf8').equals(original),'env_encoding_roundtrip_failed');
const line=/^TYPESAFE_PROXY_URL\s*=.*(?:\r?\n|$)/gm;
const before=parse(text).TYPESAFE_PROXY_URL;
const otherConfigHash=hash(text.replace(line,''));
for(const name of ['.env.production','.env.production.local']){
  try{const other=parse(await readFile(new URL('../'+name,import.meta.url)));assert(!other.TYPESAFE_PROXY_URL||other.TYPESAFE_PROXY_URL===target,'higher_priority_proxy_conflict');}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
if(phase==='apply'){
  const names=(await readdir(dir)).filter(name=>/^proxy-probe-.*\.json$/.test(name));
  const probes=await Promise.all(names.map(async name=>JSON.parse(await readFile(new URL(name,dir),'utf8'))));
  assert(probes.some(probe=>probe.passed===true&&probe.proxyUrl===target),'verified_proxy_required');
  assert(!before||before===target,'existing_proxy_requires_separate_resolution');
  if(before!==target){
    const newline=text.includes('\r\n')?'\r\n':'\n';
    const updated=line.test(text)?text.replace(line,`TYPESAFE_PROXY_URL=${target}${newline}`)
      :text+(text.endsWith('\n')?'':newline)+`TYPESAFE_PROXY_URL=${target}${newline}`;
    await writeFile(file,updated,{encoding:'utf8'});
  }
}
const actual=await readFile(file,'utf8');
assert.equal(parse(actual).TYPESAFE_PROXY_URL,target,'configured_proxy_mismatch');
assert.equal(hash(actual.replace(line,'')),otherConfigHash,'other_environment_content_changed');
const report={at:new Date().toISOString(),phase,setting:'TYPESAFE_PROXY_URL',proxyUrl:target,
  previousPresent:!!before,changed:phase==='apply'&&before!==target,otherEnvironmentContentUnchanged:true,
  verification:'UTF-8 readback, parsed value and untouched other bytes',requiresProcessReload:true};
await mkdir(dir,{recursive:true});
await writeFile(new URL(`proxy-config-${phase}-${report.at.replaceAll(/[:.]/g,'-')}.json`,dir),JSON.stringify(report,null,2)+'\n',{encoding:'utf8',flag:'wx'});
console.log(JSON.stringify(report));
