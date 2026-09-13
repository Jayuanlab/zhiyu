import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
export async function checkInteractionAtomic({databaseUrl,web}){
  const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx','--conditions=react-server','tests/integration/interaction-atomic-child.mjs'],{
    cwd:web,windowsHide:true,timeout:60000,env:{...process.env,NODE_ENV:'test',ZHIYU_TEST_MODE:'integration',ZHIYU_TEST_DATABASE_URL:databaseUrl,POSTGRES_URL:databaseUrl,DATABASE_URL:databaseUrl,TAURI_MODE:'false',IS_TAURI:'false'}});
  return {name:'real interaction processor atomic derived records and completion',passed:true,output:stdout};
}
