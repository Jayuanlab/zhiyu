const url=new URL(process.env.ZHIYU_TEST_DATABASE_URL??'');
if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/zhiyu_test_[a-f0-9]{32}$/.test(url.pathname))throw Error('Random isolated PostgreSQL required');
const {migrateStandaloneLoopToWork}=await import('../../lib/work-runtime/loop-migration.ts');
const {closePostgresDb}=await import('../../lib/db/adapters/postgres.ts');
try{console.log(JSON.stringify({migration:await migrateStandaloneLoopToWork(JSON.parse(process.argv[2]))}));}finally{await closePostgresDb();}
