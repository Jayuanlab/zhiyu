// Browser-only transport. Construct lazily in an event/effect; no server state.
import {clientWorkCommandContract,isClientWorkCommandResult} from './client-command-contract';
export type ClientWorkRequest = {url: string; method: 'POST' | 'PATCH' | 'DELETE'; body: Record<string, unknown>; expectedVersion: number};
export type PendingWorkRequest = ClientWorkRequest & {schema: 1; actorId: string; commandId: string; createdAt: string};
const PREFIX = 'zhiyu.work-command.v1.';
const terminalCodes = new Set(['version_conflict','manifest_conflict','manifest_identity_reserved','ambiguous_target','WORK_VERSION_STALE','invalid_proposal','proposal_already_resolved','not_found','invalid_command','target_busy','unresolved_effect']);
const reasons:Record<string,string>={manifest_conflict:'已存在同名车间，请核对后调整名称。',manifest_identity_reserved:'不能通过普通配置修改车间的内部身份。',ambiguous_target:'匹配到多个任务，请先核对任务名称和内部身份。',WORK_VERSION_STALE:'提案对应的配置已过期，请重新生成并审核。',invalid_proposal:'提案无效，请重新生成并审核。',proposal_already_resolved:'该提案已处理，请查看最新结果。',not_found:'目标已不存在，请刷新后核对。',invalid_command:'请求无法执行，请检查内容后重新提交。',target_busy:'目标正在运行，请等待结束或暂停后再操作。',payload_conflict:'请求内容与服务器记录不一致，原请求已保留，请核对命令记录。'};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
reasons.unresolved_effect='仍有发送中或结果未知的消息，请先在发信核实面板完成核对。';
function intent(value: ClientWorkRequest) {return canonical({url:value.url, method:value.method, body:value.body});}
function valid(value: unknown): value is PendingWorkRequest {
  if (!value || typeof value !== 'object') return false;
  const item=value as PendingWorkRequest;
  return item.schema===1 && typeof item.actorId==='string' && typeof item.commandId==='string' && item.commandId.length>0
    && typeof item.createdAt==='string' && typeof item.url==='string'
    && ['POST','PATCH','DELETE'].includes(item.method) && !!item.body && typeof item.body==='object' && !Array.isArray(item.body)
    && Number.isSafeInteger(item.expectedVersion) && item.expectedVersion>=0 && !!clientWorkCommandContract(item);
}
export class ClientWorkCommandError extends Error {
  constructor(public code: string, message: string) {super(message);}
}
export function createWorkCommandClient(options: {
  storage: Pick<Storage,'getItem'|'setItem'|'removeItem'>;
  fetch: typeof fetch;
  uuid: ()=>string;
  onPending?: (value: PendingWorkRequest | null)=>void;
}) {
  let flight: {intent:string; promise:Promise<unknown>} | null=null;
  const read=(actorId:string) => {
    let raw:string|null;
    try {raw=options.storage.getItem(PREFIX+actorId);} catch {throw new ClientWorkCommandError('storage_unavailable','无法保存提交状态，请检查浏览器存储后重试。');}
    if (!raw) return null;
    let value:unknown;try {value=JSON.parse(raw);}catch{}
    if (!valid(value) || value.actorId!==actorId) throw new ClientWorkCommandError('storage_invalid','上次提交记录无法读取，请保留浏览器数据并核对服务端记录。');
    return value;
  };
  const actor=async()=>{
    const response=await options.fetch('/api/identity',{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if (!response.ok) throw new ClientWorkCommandError('identity_unavailable','身份暂不可用，请恢复登录后核对上次提交。');
    const value=await response.json();
    if(typeof value.actorId!=='string' || !value.actorId)throw new ClientWorkCommandError('identity_unavailable','无法确认提交身份。');
    return value.actorId as string;
  };
  const send=async(pending:PendingWorkRequest)=>{
    options.onPending?.(pending);
    let response:Response, payload:any;
    try {
      response=await options.fetch(pending.url,{method:pending.method,headers:{'Content-Type':'application/json','Idempotency-Key':pending.commandId,'X-Work-Actor':pending.actorId},
        body:JSON.stringify({...pending.body,commandId:pending.commandId,expectedVersion:pending.expectedVersion}),signal:AbortSignal.timeout(25000)});
      payload=await response.json();
    } catch {throw new ClientWorkCommandError('result_unknown','提交结果尚未确认，原请求已保留，请使用“核对上次提交”。');}
    const code=typeof payload?.code==='string'?payload.code:typeof payload?.error==='string'?payload.error:'';
    if(response.ok && !isClientWorkCommandResult(pending,payload))throw new ClientWorkCommandError('result_unknown','提交响应不完整，原请求已保留，请核对上次提交。');
    if(code==='payload_conflict')throw new ClientWorkCommandError(code,reasons[code]);
    if(response.ok || (response.status>=400 && response.status<500 && terminalCodes.has(code))){
      try {options.storage.removeItem(PREFIX+pending.actorId);} catch {throw new ClientWorkCommandError('storage_unavailable','服务端已返回结果，但本地记录未清除；请核对上次提交，不要创建新请求。');}
      options.onPending?.(null);
      if(response.ok)return payload;
      throw new ClientWorkCommandError(code,code==='version_conflict'?'配置已变化。当前草稿已保留，请核对最新配置后重新提交。':reasons[code]??code);
    }
    throw new ClientWorkCommandError('result_unknown','提交结果尚未确认，原请求已保留，请使用“核对上次提交”。');
  };
  const single=(key:string, work:()=>Promise<unknown>)=>{
    if(flight){if(flight.intent===key)return flight.promise;return Promise.reject(new ClientWorkCommandError('pending_conflict','已有提交尚未确认，请先核对上次提交。'));}
    const promise=work().finally(()=>{flight=null;});flight={intent:key,promise};return promise;
  };
  return {
    async pending() {const value=read(await actor());options.onPending?.(value);return value;},
    submit<T>(request:ClientWorkRequest):Promise<T> {
      // Validate before storing or sending. Missing versions must never become 0.
      if(!Number.isSafeInteger(request.expectedVersion) || request.expectedVersion<0)return Promise.reject(new ClientWorkCommandError('baseline_missing','缺少原始编辑版本，请重新读取配置。'));
      if(!clientWorkCommandContract(request))return Promise.reject(new ClientWorkCommandError('unsupported_command','该操作尚未接入可恢复命令入口。'));
      if('commandId' in request.body || 'expectedVersion' in request.body)return Promise.reject(new ClientWorkCommandError('invalid_request','命令元数据必须与编辑内容分开。'));
      const copied=JSON.parse(JSON.stringify(request)) as ClientWorkRequest, key=intent(copied);
      return actor().then(actorId=>single(`${actorId}:${key}`,async()=>{
        const previous=read(actorId);
        if(previous){options.onPending?.(previous);if(intent(previous)!==key)throw new ClientWorkCommandError('pending_conflict','上次提交尚未确认，当前草稿已保留。请先核对上次提交。');return send(previous);}
        const pending:PendingWorkRequest={...copied,schema:1,actorId,commandId:options.uuid(),createdAt:new Date().toISOString()};
        try {options.storage.setItem(PREFIX+actorId,JSON.stringify(pending));}catch {throw new ClientWorkCommandError('storage_unavailable','无法保存提交状态，本次尚未提交，请检查浏览器存储。');}
        return send(pending);
      })) as Promise<T>;
    },
    recover<T>():Promise<T|null> {return actor().then(actorId=>single(`${actorId}:recover`,async()=>{const previous=read(actorId);if(!previous){options.onPending?.(null);return null;}return send(previous);})) as Promise<T|null>;},
  };
}
