import {runManagedApplication} from '../../scripts/managed-application.mjs';
process.exitCode=await runManagedApplication({cwd:process.cwd(),env:process.env,
  webArgs:['-e','console.log("fixture_web_ready");setInterval(()=>{},1000)'],
  workerArgs:process.env.ENABLE_LOCAL_SCHEDULER==='false'?null:['--import','tsx','--conditions=react-server','scripts/start-runtime-worker.mjs']});
