import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:60000});
const percentile=(values,p)=>[...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
function bytes(directory){return readdirSync(directory,{withFileTypes:true}).reduce((sum,item)=>sum+(item.isDirectory()?bytes(path.join(directory,item.name)):item.name.endsWith('.js')?statSync(path.join(directory,item.name)).size:0),0);}

export function workshopPerformanceCheck(stage){
  if(!/^\d{2}$/.test(stage))throw Error('Invalid build stage');
  return async ({client,owner,origin,root})=>{
    const work=randomUUID(),run=randomUUID();
    await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${owner},'性能回测车间','固定隔离数据')`;
    await client`INSERT INTO workshop_runs(id,workshop_id,status) VALUES (${run},${work},'completed')`;
    await client`INSERT INTO workshop_events(workshop_id,run_id,seq,type,title) SELECT ${work},${run},n,'work_command_applied','Work command committed' FROM generate_series(1,499) n`;
    await client`INSERT INTO workshop_events(workshop_id,run_id,seq,type,title,body) VALUES (${work},${run},500,'loop_run_completed','性能回测结论','性能基线证据')`;
    const browser=await chromium.launch({headless:true});
    try{
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.addCookies([{name:'user-cookie:confirm',value:'0',url:origin}]);
      const page=await context.newPage();page.setDefaultNavigationTimeout(120000);
      let requests=0;page.on('request',request=>{if(request.url().startsWith(origin))requests++;});
      const pageSamples=[];const requestSamples=[];
      for(let n=0;n<3;n++){
        const start=performance.now(),before=requests;
        await page.goto(`${origin}/workshop?workId=${work}&runId=${run}`);
        await expect(page.getByRole('dialog').getByText('性能基线证据',{exact:true}).first()).toBeVisible();
        pageSamples.push(performance.now()-start);requestSamples.push(requests-before);
      }
      const url=`${origin}/api/workshops/${work}/events?limit=500&runId=${run}`;
      const sample=async()=>{const start=performance.now();const response=await page.request.get(url);assert.equal(response.status(),200);assert.equal((await response.json()).events.length,500);return performance.now()-start;};
      await sample();const timings=[];for(let n=0;n<30;n++)timings.push(await sample());
      const build=path.join(root,`apps/web/.tmp/next-review-${stage}`);
      return {stage,buildId:readFileSync(path.join(build,'BUILD_ID'),'utf8').trim(),
        device:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,memoryBytes:os.totalmem(),node:process.version,browser:browser.version(),postgres:(await client.unsafe('SHOW server_version'))[0].server_version},
        fixture:{workshops:1,runs:1,events:500,viewport:{width:1440,height:1000}},
        evidenceVisibleMs:pageSamples,requestsUntilEvidence:requestSamples,
        warmedEventApi:{samples:timings,p50:percentile(timings,.5),p95:percentile(timings,.95),count:30},
        staticJavaScriptBytes:bytes(path.join(build,'static')),
        limitations:'One local machine, sequential requests, 3 page visits and 30 warmed API samples; not whole-product or concurrency performance.'};
    }finally{await browser.close();}
  };
}
