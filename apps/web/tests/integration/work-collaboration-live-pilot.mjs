import {randomUUID} from 'node:crypto';
import {existsSync, readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const origin=process.env.ZHIYU_BROWSER_ORIGIN||'http://127.0.0.1:3515';
const traderId=process.env.ZHIYU_PILOT_TRADER_ID;
const hunterId=process.env.ZHIYU_PILOT_HUNTER_ID;
const snapshotPath=resolve(import.meta.dirname,'../../.tmp/work-collaboration-live-pilot-state.json');
const uuid=/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
if(!uuid.test(traderId||'')||!uuid.test(hunterId||'')||traderId===hunterId)throw Error('Two distinct Work IDs are required');
const mode=process.argv[2];

async function api(path,init){
  const response=await fetch(`${origin}${path}`,{...init,headers:{
    'Content-Type':'application/json',Origin:origin,...init?.headers,
  }});
  const body=await response.json();
  if(!response.ok)throw Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}
async function current(id){
  const [detail,policy]=await Promise.all([
    api(`/api/workshops/${id}`),api(`/api/workshops/${id}/collaboration/policy`),
  ]);
  return {work:detail.workshop,version:policy.commandVersion};
}
async function patch(id,patch,reason){
  const {version}=await current(id);
  return api(`/api/workshops/${id}`,{method:'PATCH',body:JSON.stringify({
    ...patch,reason,expectedVersion:version,commandId:randomUUID(),
  })});
}
const readSnapshot=()=>JSON.parse(readFileSync(snapshotPath,'utf8'));
const collaborationTools=['workshopLogEvent','workshopListColleagues','workshopAskColleague',
  'workshopReadCollaborationInbox','workshopRespondCollaboration'];
const blocked=['quantPaperPlaceOrder','quantPaperCancelOrder','quantPaperProposeWatchlistChange',
  'quantCandidatePoolMaintain','workshopCreateOutboxDraft','wechatDesktopSendMessage','outboxSend'];

if(mode==='setup'){
  if(existsSync(snapshotPath))throw Error(`An unfinished pilot already has a snapshot: ${snapshotPath}`);
  const trader=await current(traderId),hunter=await current(hunterId);
  if(trader.work.status!=='active'||hunter.work.status!=='active')throw Error('Both Works must be active');
  const snapshot={createdAt:new Date().toISOString(),traderId,hunterId,
    originals:{[traderId]:{modelConfig:trader.work.modelConfig,boundaryPolicy:trader.work.boundaryPolicy},
      [hunterId]:{modelConfig:hunter.work.modelConfig,boundaryPolicy:hunter.work.boundaryPolicy}}};
  writeFileSync(snapshotPath,JSON.stringify(snapshot,null,2),'utf8');
  const setup=async (id,work,allowedTools,collaboration)=>{
    const modelConfig={...work.modelConfig,allowedTools,
      disallowedTools:[...new Set([...(work.modelConfig.disallowedTools||[]),...blocked])],
      collaboration:{...(work.modelConfig.collaboration||{}),...collaboration}};
    await patch(id,{modelConfig},'Temporary read-only boundary for trader/hunter collaboration pilot.');
  };
  await setup(hunterId,hunter.work,['quantPaperGetWatchlist','workshopLogEvent',
    'workshopReadCollaborationInbox','workshopRespondCollaboration'],
  {offeredCapabilities:['watchlist_rationale'],acceptedKinds:['consult'],allowedRecipients:[]});
  await setup(traderId,trader.work,['quantPaperGetWatchlist',...collaborationTools],
  {offeredCapabilities:[],acceptedKinds:[],allowedRecipients:[hunterId]});
  console.log(JSON.stringify({phase:'setup',traderId,hunterId,snapshotPath,readOnly:true}));
}else if(mode==='harden'){
  const snapshot=readSnapshot();
  if(snapshot.traderId!==traderId||snapshot.hunterId!==hunterId)throw Error('Pilot IDs differ from snapshot');
  for(const id of [traderId,hunterId]){
    const {work}=await current(id);
    const modelConfig={...work.modelConfig,
      disallowedTools:[...new Set([...(work.modelConfig.disallowedTools||[]),...blocked])]};
    await patch(id,{modelConfig},'Harden read-only collaboration pilot tool deny list.');
  }
  console.log(JSON.stringify({phase:'harden',blocked}));
}else if(mode==='start'){
  const snapshot=readSnapshot();
  if(snapshot.traderId!==traderId||snapshot.hunterId!==hunterId)throw Error('Pilot IDs differ from snapshot');
  if(snapshot.traderRunId)throw Error('Pilot run already started');
  const content=[
    '本轮是一次真实车间协作回测，只处理当前正式自选股的选股理由，不做模拟盘交易、交易计划、自选股调整或对外发送。',
    '先用 quantPaperGetWatchlist 读取当前正式自选股及其理由、来源和最近复核时间。你是操盘交易员，不负责维护池子；为判断这些理由是否仍可用于你的后续模拟盘研究，需要自选股猎手给出当前解释。',
    '请用 workshopLogEvent 记录这一具体信息缺口，取得事件 ID；查看同伴目录后向自选股猎手发起 consult，neededCapability 必须为 watchlist_rationale，引用刚记录的事件 ID。',
    '请猎手逐只说明当前正式自选股的入选理由、可核查的原始依据、理由截至何时有效、失效条件；若当前数据不足或理由过期，应明确说未知，不补造证据。',
    '发出请求后记录 requestId 并结束本轮，等待对方回复触发后续运行。全程只读，不下单、不撤单、不修改池子。',
  ].join('\n');
  const {version}=await current(traderId);
  const result=await api(`/api/workshops/${traderId}/directives`,{method:'POST',body:JSON.stringify({
    content,scope:'current_run',triggerRun:true,priority:100,
    expectedVersion:version,commandId:randomUUID(),
  })});
  snapshot.traderRunId=result.run?.id||null;
  writeFileSync(snapshotPath,JSON.stringify(snapshot,null,2),'utf8');
  console.log(JSON.stringify({phase:'start',traderRunId:snapshot.traderRunId,runError:result.runError||null}));
}else if(mode==='status'){
  const snapshot=readSnapshot();
  const [traderRuns,hunterRuns,collaboration]=await Promise.all([
    api(`/api/workshops/${traderId}/runs?limit=10`),api(`/api/workshops/${hunterId}/runs?limit=10`),
    api(`/api/workshops/${traderId}/collaboration`),
  ]);
  const requests=collaboration.requests.filter(item=>item.originRunId===snapshot.traderRunId);
  const detail=requests[0]?await api(`/api/workshops/${traderId}/collaboration/${requests[0].id}`):null;
  console.log(JSON.stringify({phase:'status',traderRunId:snapshot.traderRunId,
    traderRuns:traderRuns.runs.filter(run=>run.id===snapshot.traderRunId||
      run.triggerReason?.type==='collaboration').slice(0,4).map(run=>({id:run.id,status:run.status,error:run.error,
      summary:run.outputSummary?.slice(0,500),triggerReason:run.triggerReason})),
    hunterRuns:hunterRuns.runs.filter(run=>run.triggerReason?.type==='collaboration').slice(0,4)
      .map(run=>({id:run.id,status:run.status,error:run.error,summary:run.outputSummary?.slice(0,500)})),
    requests,events:detail?.events||[]},null,2));
}else if(mode==='probe'){
  const snapshot=readSnapshot();
  if(snapshot.traderId!==traderId||snapshot.hunterId!==hunterId)throw Error('Pilot IDs differ from snapshot');
  if(snapshot.scopeProbeRunId)throw Error('Scope probe already started');
  const {version}=await current(traderId);
  const content='协作权限修复回测：只读取一次当前正式自选股并记录一个简短的观察事件。不要发起协作，不读取账户，不写记忆，不做交易计划，不下单、不改池、不外发。完成后结束本轮。';
  const result=await api(`/api/workshops/${traderId}/directives`,{method:'POST',body:JSON.stringify({
    content,scope:'current_run',triggerRun:true,priority:100,
    expectedVersion:version,commandId:randomUUID(),
  })});
  snapshot.scopeProbeRunId=result.run?.id||null;
  writeFileSync(snapshotPath,JSON.stringify(snapshot,null,2),'utf8');
  console.log(JSON.stringify({phase:'probe',runId:snapshot.scopeProbeRunId,runError:result.runError||null}));
}else if(mode==='restore'){
  const snapshot=readSnapshot();
  const keep=process.argv.includes('--keep-policy');
  const active=['queued','running','cancel_requested','needs_review'];
  for(const id of [traderId,hunterId]){
    const runs=await api(`/api/workshops/${id}/runs?limit=20`);
    if(runs.runs.some(run=>active.includes(run.status)))throw Error(`Work ${id} has active or uncertain runs; retain the read-only boundary`);
  }
  for(const id of [traderId,hunterId]){
    const {work}=await current(id);
    const original=snapshot.originals[id];
    const collaboration=keep?work.modelConfig.collaboration:original.modelConfig.collaboration;
    const keptTools=id===traderId?collaborationTools:
      ['workshopReadCollaborationInbox','workshopRespondCollaboration'];
    const allowedTools=keep?[...new Set([...(original.modelConfig.allowedTools||[]),...keptTools])]
      :original.modelConfig.allowedTools;
    const modelConfig={...work.modelConfig,...original.modelConfig,allowedTools};
    if(collaboration===undefined)delete modelConfig.collaboration;
    else modelConfig.collaboration=collaboration;
    await patch(id,{modelConfig,boundaryPolicy:original.boundaryPolicy},
      keep?'Restore Work tools after read-only collaboration pilot; retain explicit collaboration policy.':
        'Restore Work configuration after collaboration pilot.');
  }
  unlinkSync(snapshotPath);
  console.log(JSON.stringify({phase:'restore',keptCollaborationPolicy:keep}));
}else{
  throw Error('Use setup, harden, start, status, probe, or restore [--keep-policy]');
}
