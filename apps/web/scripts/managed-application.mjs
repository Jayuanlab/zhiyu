import {spawn,execFileSync} from 'node:child_process';

/** Owns only children created by this invocation. Database leases arbitrate other launchers. */
export async function runManagedApplication({cwd,env,webArgs,workerArgs}) {
  let stopping=false,worker,web,deadline;
  const children=[];
  const start=(args,ipc=false)=>{
    const child=spawn(process.execPath,args,{cwd,env,windowsHide:true,stdio:ipc?['ignore','inherit','inherit','ipc']:'inherit'});
    const item={child,done:false};children.push(item);
    item.exited=new Promise(resolve=>{
      child.once('error',()=>{item.done=true;resolve(1);});
      child.once('exit',code=>{item.done=true;resolve(code??1);});
    });
    return item;
  };
  const forceStop=item=>{
    if(!item||item.done)return;
    if(process.platform==='win32'){
      try{execFileSync('taskkill',['/PID',String(item.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}
    }else item.child.kill('SIGKILL');
  };
  let finish;
  const finished=new Promise(resolve=>{finish=resolve;});
  async function stop(code=0){
    if(stopping)return;
    stopping=true;clearTimeout(deadline);
    console.log(JSON.stringify({event:'application_stopping'}));
    if(worker&&!worker.done){
      if(worker.child.connected)worker.child.send('stop',()=>{});
      const limit=setTimeout(()=>forceStop(worker),35000);
      const workerCode=await worker.exited;clearTimeout(limit);
      if(workerCode!==0)code=1;
    }
    forceStop(web);
    if(web)await web.exited;
    console.log(JSON.stringify({event:'application_stopped',code}));
    finish(code);
  }
  const onSignal=()=>void stop();
  const onMessage=message=>{
    if(message==='stop')void stop();
    else if((message==='pause'||message==='resume')&&worker?.child.connected)worker.child.send(message,()=>{});
  };
  process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);process.on('message',onMessage);
  if(process.connected)process.once('disconnect',onSignal);
  try{
    if(workerArgs){
      worker=start(workerArgs,true);
      const ready=await new Promise(resolve=>{
        deadline=setTimeout(()=>resolve(false),20000);
        worker.child.on('message',message=>{
          if(message?.event==='runtime_ready'){clearTimeout(deadline);resolve(true);}
        });
        worker.exited.then(()=>resolve(false));
      });
      if(!ready||stopping){await stop(1);return await finished;}
      console.log(JSON.stringify({event:'application_worker_ready',pid:worker.child.pid}));
      worker.exited.then(()=>{if(!stopping)void stop(1);});
    }
    if(!stopping){
      web=start(webArgs);
      console.log(JSON.stringify({event:'application_web_started',pid:web.child.pid}));
      web.exited.then(code=>{if(!stopping)void stop(code);});
    }
    return await finished;
  }finally{
    clearTimeout(deadline);
    process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);process.removeListener('message',onMessage);
    process.removeListener('disconnect',onSignal);
    if(process.connected)process.disconnect();
  }
}
