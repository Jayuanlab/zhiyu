import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {createHash,createHmac} from 'node:crypto';
import {submitPaperOrder,cancelPaperOrder,readPaperCommand,paperSignedHeaders,submitPaperTick} from '@/lib/quant/paper-client';
const owner='00000000-0000-4000-8000-000000000001',account='00000000-0000-4000-8000-000000000002';
const context={ownerId:owner,actorId:`user:${owner}`,role:'owner' as const};
const input={commandId:'fixed-command',code:'159278.SZ',side:'buy' as const,quantity:100,limit_price:0.957};
const fetcher=vi.fn();
beforeEach(()=>{vi.stubEnv('QUANT_PAPER_OWNER_ID',owner);vi.stubEnv('QUANT_PAPER_ACCOUNT_ID',account);vi.stubEnv('QUANT_PAPER_SIGNING_KEY','test-signing-key-that-is-at-least-32-bytes');vi.stubEnv('QUANT_INTERNAL_TOKEN','test-token');vi.stubEnv('QUANT_TRANSPORT','http');vi.stubEnv('QUANT_SERVICE_URL','http://127.0.0.1:9999');vi.stubGlobal('fetch',fetcher);fetcher.mockReset();});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('paper signed command transport',()=>{
  it('sends a scheduler tick without version or market data and validates the receipt',async()=>{
    const scheduler={...context,role:'scheduler' as const},input={commandId:'tick-1',accountId:account};
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({commandId:'tick-1',version:1,result:{status:'completed',matched:[],waiting:{}}})));
    await submitPaperTick(input,scheduler);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({commandId:'tick-1'});
    expect(String(fetcher.mock.calls[0][0])).toContain(`/accounts/${account}/ticks`);
    fetcher.mockResolvedValueOnce(new Response('{}'));
    await expect(submitPaperTick(input,scheduler)).rejects.toMatchObject({code:'paper_result_unknown',commandId:'tick-1'});
    await expect(submitPaperTick(input,context)).rejects.toMatchObject({code:'paper_actor_denied'});
  });
  it('binds owner, raw UTF-8 body, method, path and expiration',()=>{
    const body=JSON.stringify({note:'模拟委托'}),path='/paper/v2/accounts/id/orders';
    const headers=paperSignedHeaders(context,'POST',path,body,1000000);
    const raw=headers['X-Zhiyu-Paper-Context'];const claims=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));
    expect(claims).toMatchObject({ownerId:owner,actorId:context.actorId,method:'POST',path,issuedAt:1000,expiresAt:1060,bodySha256:createHash('sha256').update(body).digest('hex')});
    expect(headers['X-Zhiyu-Paper-Signature']).toBe(createHmac('sha256',process.env.QUANT_PAPER_SIGNING_KEY!).update(raw).digest('hex'));
  });
  it('sends the same command intent again after an uncertain response and keeps exact price precision',async()=>{
    fetcher.mockRejectedValueOnce(Error('lost response')).mockResolvedValueOnce(new Response(JSON.stringify({commandId:input.commandId,version:1,result:{status:'accepted',order:{id:'po_1',code:input.code,side:'buy',status:'submitted',quantity:100,remaining_quantity:100,limit_price:'0.957'}}})));
    await expect(submitPaperOrder(input,context)).rejects.toMatchObject({code:'paper_result_unknown',commandId:input.commandId});
    expect((await submitPaperOrder(input,context)).order.limit_price).toBe(0.957);
    const bodies=fetcher.mock.calls.map(call=>JSON.parse(call[1].body));expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({commandId:input.commandId,limit_price:'0.957'});expect(bodies[0]).not.toHaveProperty('actor');
    expect(String(fetcher.mock.calls[0][0])).toContain('/paper/v2/');
  });
  it('rejects missing keys, other owners and non-local services before fetch',async()=>{
    await expect(submitPaperOrder({...input,commandId:''},context)).rejects.toMatchObject({code:'invalid_command'});
    await expect(submitPaperOrder(input,{...context,ownerId:account})).rejects.toMatchObject({code:'paper_owner_denied'});
    vi.stubEnv('QUANT_SERVICE_URL','https://remote.invalid');
    await expect(submitPaperOrder(input,context)).rejects.toMatchObject({code:'paper_local_service_required'});
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves durable business rejections and treats incomplete success as unknown',async()=>{
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({commandId:input.commandId,version:1,result:{status:'rejected',reasonCode:'insufficient_cash'}})));
    await expect(submitPaperOrder(input,context)).rejects.toMatchObject({code:'insufficient_cash',receipt:{commandId:input.commandId}});
    fetcher.mockResolvedValueOnce(new Response('{}'));
    await expect(submitPaperOrder(input,context)).rejects.toMatchObject({code:'paper_result_unknown'});
  });
  it('signs receipt paths with escaped keys and uses a separate cancellation key',async()=>{
    fetcher.mockResolvedValueOnce(new Response('{"status":"not_found","receipt":null}'));
    await readPaperCommand(context,'work:run:intent');
    expect(String(fetcher.mock.calls[0][0])).toContain('work%3Arun%3Aintent');
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({commandId:'cancel-key',version:2,result:{status:'completed',order:{id:'po_1',side:'buy',status:'cancelled',limit_price:'0.957',quantity:100,remaining_quantity:100}}})));
    await cancelPaperOrder('po_1',{commandId:'cancel-key'},context);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).commandId).toBe('cancel-key');
  });
});
