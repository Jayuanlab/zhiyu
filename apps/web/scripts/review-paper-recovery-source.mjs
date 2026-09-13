// Read-only historical evidence export. Never mutates the account or approves import.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {parse} from 'dotenv';
import postgres from 'postgres';

const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.resolve(web,'../..');
const env={};
for(const file of [path.join(root,'.env'),path.join(web,'.env')])if(fs.existsSync(file))Object.assign(env,parse(fs.readFileSync(file)));
Object.assign(env,process.env);
const owner=env.QUANT_PAPER_OWNER_ID||env.DEV_USER_ID||'dcb1985e-3fe2-42fd-8978-7b04d1772850';
const source=path.join(root,'tools/quant-service/data/paper_account.json');
const raw=fs.readFileSync(source),state=JSON.parse(raw);
if(!state.restore?.restored_at||!Number.isFinite(Date.parse(state.restore.restored_at)))throw Error('Recovery timestamp required');
const codes=[...new Set(state.lots.filter(lot=>lot.restore_source).map(lot=>lot.code))];
const url=new URL(env.POSTGRES_URL||env.DATABASE_URL);
if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Local recovery review requires loopback database');
const sql=postgres(url.toString(),{max:1,onnotice:()=>{}});
try{
  const rows=await sql.begin('read only',async tx=>{
    await tx`SET LOCAL statement_timeout = '10s'`;
    return tx`SELECT s.id,s.workshop_id,s.source_event_id,s.code,s.trade_date,s.created_at,
      s.snapshot->'position' AS position
      FROM quant_trend_state_snapshots s JOIN workshops w ON w.id=s.workshop_id
      WHERE w.user_id=${owner}
        AND s.created_at <= ${state.restore.restored_at}::timestamptz
        AND s.snapshot->'position' IS NOT NULL AND s.snapshot->'position' != 'null'::jsonb
      ORDER BY s.code,s.created_at DESC,s.id DESC`;
  });
  if(!raw.equals(fs.readFileSync(source)))throw Error('Source changed during review');
  const availability=await sql.begin('read only',async tx=>tx`
    SELECT count(*)::int AS total, min(s.created_at) AS earliest, max(s.created_at) AS latest,
      count(*) FILTER (WHERE s.snapshot->'position' IS NOT NULL AND s.snapshot->'position' != 'null'::jsonb)::int AS with_position
    FROM quant_trend_state_snapshots s JOIN workshops w ON w.id=s.workshop_id WHERE w.user_id=${owner}`);
  const report={sourceHash:createHash('sha256').update(raw).digest('hex'),ownerId:owner,
    cutoff:state.restore.restored_at,observedAt:new Date().toISOString(),readOnly:true,availability,rows};
  fs.writeFileSync(path.join(root,'docs/plans/2026-09-06-review-remediation/records/08D-recovery-source.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({rows:rows.length,codes:codes.length,availability,sourceCodes:[...new Set(rows.map(row=>row.code))],positionFields:[...new Set(rows.flatMap(row=>Object.keys(row.position||{})))]}));
}finally{await sql.end();}
