import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {chromium,expect} from '@playwright/test';
import {checkLoopDevelopment} from './loop-development.mjs';

export async function checkPaperEndToEnd({env,client,root,web,databaseUrl,recordPrefix,credentials,mode='development',reviewStage='65'}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'zhiyu_test_paper_e2e_'));
  const source=path.join(directory,'account.json'),now='2026-09-08T10:00:00+08:00',work=randomUUID();
  const state={id:'browser-recovery',initial_cash:'1000.00',cash:'900.00',frozen_cash:'0.00',realized_pnl:'-2.00',created_at:now,updated_at:now,
    orders:[],fills:[],restore:{source:'isolated snapshot',restored_at:now},lots:[{id:'restored-lot',code:'159278.SZ',quantity:100,remaining_quantity:100,
      cost_price:'1.000',trade_date:'2026-09-08',created_at:now,restore_source:'isolated snapshot'}]};
  const raw=JSON.stringify(state);fs.writeFileSync(source,raw);
  await client`INSERT INTO workshops(id,user_id,name,mission) VALUES (${work},${credentials.owner},'isolated review','test')`;
  await client`INSERT INTO quant_trend_state_snapshots(workshop_id,code,trade_date,lifecycle_state,snapshot,created_at)
    VALUES (${work},'159278','2026-09-08','holding',${JSON.stringify({position:{quantity:100,cost_price:1}})}::jsonb,${now})`;
  const key=randomUUID()+randomUUID(),token=randomUUID();
  const log=fs.openSync(path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-python.log`),'w');
  const child=spawn(path.join(root,'tools/quant-service/.venv/Scripts/python.exe'),['-X','utf8',path.join(root,'tools/quant-service/tests/paper_review_server.py')],{
    cwd:root,windowsHide:true,stdio:['ignore',log,log],env:{...process.env,PAPER_REVIEW_TEST_SOURCE:source,QUANT_PAPER_DATABASE_URL:credentials.databaseUrl,
      QUANT_PAPER_OWNER_ID:credentials.owner,QUANT_PAPER_SIGNING_KEY:key,QUANT_INTERNAL_TOKEN:token}});
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{
    let ready=false;
    for(let n=0;n<60;n++){
      if(child.exitCode!==null)throw Error('Python test server exited');
      try{if((await fetch('http://127.0.0.1:8778/health')).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert.ok(ready);
    return await checkLoopDevelopment({env:{...env,QUANT_SERVICE_URL:'http://127.0.0.1:8778',QUANT_PAPER_OWNER_ID:credentials.owner,
      QUANT_PAPER_SIGNING_KEY:key,QUANT_INTERNAL_TOKEN:token,QUANT_PAPER_ACCOUNT_ID:''},databaseUrl,client,root,web,recordPrefix,ownerId:credentials.owner,mode,reviewStage,
      browserCheck:async({origin})=>{
        const browser=await chromium.launch({headless:true});
        try{
          const page=await browser.newPage({viewport:{width:390,height:1100}});
          page.setDefaultTimeout(30000);
          await page.route('**/api/page-state/quant*',route=>route.fulfill({json:{dashboard:null,account:{...state,migrationRequired:true,total_asset:1000,
            market_value:100,total_pnl:0,total_pnl_pct:0,positions:[],open_orders:[],recent_orders:[],recent_fills:[]},meta:{dashboard:{},account:{}}}}));
          await page.goto(origin+'/quant',{waitUntil:'domcontentloaded',timeout:120000});
          await page.getByRole('button',{name:'查看迁移差异'}).click();
          await page.getByRole('button',{name:'核实来源并打开审核'}).click();
          await expect(page.getByText('当前现金：900.00 元；冻结：0.00 元。')).toBeVisible({timeout:30000});
          for(const checkbox of await page.getByRole('checkbox').all())await checkbox.check();
          await page.getByRole('button',{name:'确认恢复基线'}).click();
          await expect(page.getByText('恢复基线已确认；账户尚未迁移。',{exact:true})).toBeVisible({timeout:30000});
          const rows=await client`SELECT decision,actor,acknowledgements FROM paper_recovery_decisions WHERE owner_id=${credentials.owner} AND actor=${'user:'+credentials.owner}`;
          assert.equal(rows.length,1);assert.equal(rows[0].decision,'approved');
          assert.equal(rows[0].acknowledgements.historicalCashIncomplete,true);
          assert.equal(fs.readFileSync(source,'utf8'),raw);
          await page.screenshot({path:path.join(root,`docs/plans/2026-09-06-review-remediation/records/${recordPrefix}-confirmed.png`)});
          return [{name:'browser to Web signed transport to Python restricted database owner approval',passed:true},{name:'source untouched and exactly one owner decision',passed:true}];
        }finally{await browser.close();}
      }});
  }finally{
    if(child.exitCode===null){execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await exited;}
    fs.closeSync(log);
    const resolved=path.resolve(directory);
    if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('zhiyu_test_paper_e2e_'))throw Error('Unexpected cleanup path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
}
