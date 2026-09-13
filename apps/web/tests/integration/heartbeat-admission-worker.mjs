const url=new URL(process.env.ZHIYU_TEST_DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/zhiyu_test_[a-f0-9]{32}$/.test(url.pathname))throw Error('Random isolated PostgreSQL required');
const {admitWorkshopHeartbeat}=await import('../../lib/work-runtime/heartbeat-admission.ts');
const {projectWorkshopHeartbeat}=await import('../../lib/work-runtime/heartbeat-projection.ts');
const {closePostgresDb}=await import('../../lib/db/adapters/postgres.ts');
try{
  const input=JSON.parse(process.argv[2]);
  const project=input.project===true;delete input.project;
  if(input.aborted){delete input.aborted;input.signal=AbortSignal.abort();}
  console.log(JSON.stringify((project?await projectWorkshopHeartbeat(input):await admitWorkshopHeartbeat(input))??{}));
}finally{await closePostgresDb();}
