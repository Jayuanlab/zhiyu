import {config} from 'dotenv';
config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
const args=process.argv.slice(2),values=new Map();
const switches=new Set(['--apply','--confirm-old-processes-stopped']);
const options=new Set(['--owner','--command-id','--manifest-hash']);
for(let index=0;index<args.length;index++){
  const key=args[index];
  if(values.has(key))throw Error('duplicate_argument');
  if(switches.has(key))values.set(key,true);
  else if(options.has(key)&&args[index+1]&&!args[index+1].startsWith('--'))values.set(key,args[++index]);
  else throw Error('invalid_argument');
}
if(!values.get('--owner'))throw Error('owner_required');
if(process.env.TAURI_MODE==='true'||process.env.IS_TAURI==='true')throw Error('postgres_maintenance_required');
const {previewLegacyInteractions,reconcileLegacyInteractions}=await import('../lib/interactions/legacy-reconciliation.ts');
const {closePostgresDb}=await import('../lib/db/adapters/postgres.ts');
try{
  const result=values.has('--apply')?await reconcileLegacyInteractions({ownerId:values.get('--owner'),commandId:values.get('--command-id')??'',
    manifestHash:values.get('--manifest-hash')??'',confirmedOldProcessesStopped:values.has('--confirm-old-processes-stopped')}):await previewLegacyInteractions(values.get('--owner'));
  console.log(JSON.stringify({event:values.has('--apply')?'interaction_legacy_reconciled':'interaction_legacy_preview',...result}));
}catch(error){console.error(error.message);process.exitCode=1;}
finally{await closePostgresDb();}
