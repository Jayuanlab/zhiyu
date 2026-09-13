import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export async function checkInteractionWriteBoundary({databaseUrl,web}){
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--conditions=react-server','tests/integration/interaction-write-boundary-child.mjs'],{
    cwd:web,windowsHide:true,timeout:30000,env:{...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,TAURI_MODE:'false',IS_TAURI:'false'}});
  return {name:'interaction write boundary and attempt fencing on real database',passed:true,output:stdout};
}
