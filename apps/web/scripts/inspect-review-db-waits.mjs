import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import postgres from 'postgres';
import {parse} from 'dotenv';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const env={};for(const file of [path.resolve(web,'../../.env'),path.join(web,'.env')])if(fs.existsSync(file))Object.assign(env,parse(fs.readFileSync(file)));
Object.assign(env,process.env);
const url=new URL(env.ZHIYU_TEST_ADMIN_URL||env.POSTGRES_URL||env.DATABASE_URL);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('Loopback only');url.pathname='/postgres';
const client=postgres(url.toString(),{max:1});
try{console.log(JSON.stringify(await client`SELECT pid,datname,state,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,left(query,160) AS query FROM pg_stat_activity WHERE datname LIKE 'zhiyu_test_%'`,null,2));}finally{await client.end();}
