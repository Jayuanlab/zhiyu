import {describe,it,expect} from 'vitest';
import {clientWorkCommandContract,isClientWorkCommandResult} from '@/lib/work-runtime/client-command-contract';
describe('ledger-backed client route contracts',()=>{
  it.each(['unknown','no_effect','effects_recorded'])('validates run review %s without accepting a different outcome or run',outcome=>{
    const request={url:'/api/workshops/w/runs/r/review',method:'POST',body:{outcome}};
    const value=outcome==='unknown'?{runId:'r',status:'needs_review',closed:false}:{runId:'r',status:'cancelled',closed:true,workStatus:'paused'};
    expect(isClientWorkCommandResult(request,value)).toBe(true);
    expect(isClientWorkCommandResult(request,{...value,runId:'other'})).toBe(false);
    expect(isClientWorkCommandResult(request,{...value,closed:!value.closed})).toBe(false);
    expect(clientWorkCommandContract({...request,body:{outcome:'completed'}})).toBeNull();
  });
  it.each([
    ['/api/workshops','POST',{},'workshop'],
    ['/api/workshops/w','PATCH',{},'workshop'],
    ['/api/workshops/w','DELETE',{},'workshop'],
    ['/api/workshops/w/runs','POST',{},'run'],
    ['/api/workshops/w/directives','POST',{content:'test'},'directive'],
    ['/api/workshops/w/loops','POST',{type:'template'},'loop'],
    ['/api/workshops/w/loops','POST',{type:'natural_language',create:true},'loop'],
    ['/api/workshops/w/loops/l','PATCH',{action:'pause'},'loop'],
    ['/api/workshops/w/loops/l','PATCH',{action:'clear_blocker'},'loop'],
    ['/api/workshops/w/loops/l','DELETE',{},'loop'],
    ['/api/workshops/w/loops/l/activation','POST',{action:'activate'},'loop'],
    ['/api/workshops/w/agent-change-proposals/e','POST',{action:'reject'},'workshop'],
    ['/api/workshops/w/work/versions','POST',{action:'restore',versionId:'v'},'workshop'],
  ])('validates %s %s', (url,method,body,kind)=>{
    const request={url,method,body};expect(clientWorkCommandContract(request)?.kind).toBe(kind);
    const id=kind==='workshop'?'w':kind==='loop'?'l':'result';
    expect(isClientWorkCommandResult(request,{[kind]:{id,workshopId:'w'}})).toBe(true);
    expect(isClientWorkCommandResult(request,{})).toBe(false);
    expect(isClientWorkCommandResult(request,{[kind]:{id:'wrong',workshopId:'foreign'}})).toBe(url==='/api/workshops');
  });
  it.each([
    ['/api/workshops/w/loops/l/execute','POST',{}],
    ['/api/loops/approvals/a/resume','POST',{}],
    ['/api/workshops/w/outbox/o/send','POST',{}],
    ['/api/workshops/w/loops','POST',{type:'natural_language',create:false}],
    ['/api/workshops/w','PATCH',{dryRun:true}],
    ['/api/workshops/w','GET',{}],
  ])('excludes non-ledger actions %s',(url,method,body)=>{
    expect(clientWorkCommandContract({url,method,body})).toBeNull();
  });
});
