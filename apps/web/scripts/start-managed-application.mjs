import {config} from 'dotenv';
import {workerConfiguration} from '../lib/runtime/mode.ts';
import {runManagedApplication} from './managed-application.mjs';

config({path:'.env.local',quiet:true});config({path:'.env',quiet:true});
const command=process.argv[2];
if(!['dev','start'].includes(command))throw Error('application_mode_required');
process.env.NODE_ENV=command==='dev'?'development':'production';
const configuration=workerConfiguration();
const webArgs=command==='dev'?['scripts/dev-with-warmup.cjs']:
  ['../../node_modules/next/dist/bin/next','start','--hostname','127.0.0.1',...process.argv.slice(3)];
process.exitCode=await runManagedApplication({cwd:process.cwd(),env:process.env,webArgs,
  workerArgs:configuration.enabled?['--import','tsx','--conditions=react-server','scripts/start-runtime-worker.mjs']:null});
