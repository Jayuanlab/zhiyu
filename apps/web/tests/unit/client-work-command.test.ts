import {describe,it,expect,vi} from 'vitest';
import {createWorkCommandClient,type ClientWorkRequest} from '@/lib/work-runtime/client-command';

const request:ClientWorkRequest={url:'/api/workshops/work',method:'PATCH',body:{mission:'原始草稿'},expectedVersion:2};
function fixture() {
  const values=new Map<string,string>(),writes:Array<{url:string;body:any;headers:any}>=[];
  let actorId='owner-a',lose=false,code=200;
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);},removeItem:(key:string)=>{values.delete(key);}};
  const fetcher=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
    if(url==='/api/identity')return Response.json({actorId});
    writes.push({url:String(url),body:JSON.parse(String(init?.body)),headers:init?.headers});
    if(lose)throw Error('response lost after commit');
    return code===200?Response.json({workshop:{id:'work'}}):Response.json({error:code===409?'version_conflict':'temporary error'},{status:code});
  }) as unknown as typeof fetch;
  const create=()=>createWorkCommandClient({storage,fetch:fetcher,uuid:()=>crypto.randomUUID()});
  return {values,writes,storage,create,setActor:(value:string)=>{actorId=value;},lose:(value:boolean)=>{lose=value;},status:(value:number)=>{code=value;}};
}
describe('durable browser Work commands',()=>{
  it('keeps an unconfirmed review request across reload and checks the reviewed item identity',async()=>{
    const f=fixture(),writes:any[]=[];let wrong=true;
    const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{
      if(url==='/api/identity')return Response.json({actorId:'owner-a'});
      writes.push(JSON.parse(String(init?.body)));
      return Response.json({item:{id:wrong?'other':'review',workshopId:'work',status:'dismissed'}});
    };
    const create=()=>createWorkCommandClient({storage:f.storage,fetch:fetcher as typeof fetch,uuid:()=>crypto.randomUUID()});
    await expect(create().submit({url:'/api/workshops/work/review-items',method:'PATCH',expectedVersion:5,body:{itemId:'review',status:'dismissed'}})).rejects.toMatchObject({code:'result_unknown'});
    expect(f.values.size).toBe(1);wrong=false;
    await create().recover();expect(writes[1]).toEqual(writes[0]);expect(f.values.size).toBe(0);
  });
  it('recovers a migration with its original command and source snapshot after reload',async()=>{
    const f=fixture(),writes:any[]=[];let lost=true;
    const snapshotHash='a'.repeat(64),workId=crypto.randomUUID();
    const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{
      if(url==='/api/identity')return Response.json({actorId:'owner-a'});
      writes.push(JSON.parse(String(init?.body)));if(lost)throw Error('response lost');
      return Response.json({loopId:'loop',workId,status:'paused',snapshotHash});
    };
    const create=()=>createWorkCommandClient({storage:f.storage,fetch:fetcher as typeof fetch,uuid:()=>crypto.randomUUID()});
    const action:ClientWorkRequest={url:'/api/loops/loop/migration',method:'POST',expectedVersion:0,body:{expectedSnapshotHash:snapshotHash,controllersStopped:true,nativeReplacement:{goal:'Reviewed replacement',triggerConfig:{type:'interval',minutes:15},confirmLegacyReplacement:true}}};
    await expect(create().submit(action)).rejects.toMatchObject({code:'result_unknown'});
    lost=false;await create().recover();expect(writes[1]).toEqual(writes[0]);expect(writes[1]).toMatchObject({expectedVersion:0,expectedSnapshotHash:snapshotHash});expect(f.values.size).toBe(0);
  });
  it('does not accept a migration receipt for a different Loop or source snapshot',async()=>{
    const f=fixture(),snapshotHash='a'.repeat(64);
    const fetcher=async(url:RequestInfo|URL)=>url==='/api/identity'?Response.json({actorId:'owner-a'}):Response.json({loopId:'other',workId:crypto.randomUUID(),status:'paused',snapshotHash:'b'.repeat(64)});
    const client=createWorkCommandClient({storage:f.storage,fetch:fetcher as typeof fetch,uuid:()=>crypto.randomUUID()});
    await expect(client.submit({url:'/api/loops/loop/migration',method:'POST',expectedVersion:0,body:{expectedSnapshotHash:snapshotHash,controllersStopped:true}})).rejects.toMatchObject({code:'result_unknown'});
    expect(f.values.size).toBe(1);
  });
  it('recovers an owner run review with its original lease baseline after reload',async()=>{
    const f=fixture(),writes:any[]=[];let lost=true;
    const fetcher=async(url:RequestInfo|URL,init?:RequestInit)=>{
      if(url==='/api/identity')return Response.json({actorId:'owner-a'});
      writes.push(JSON.parse(String(init?.body)));if(lost)throw Error('response lost');
      return Response.json({runId:'run',status:'cancelled',closed:true,workStatus:'paused'});
    };
    const create=()=>createWorkCommandClient({storage:f.storage,fetch:fetcher as typeof fetch,uuid:()=>crypto.randomUUID()});
    const action:ClientWorkRequest={url:'/api/workshops/work/runs/run/review',method:'POST',expectedVersion:4,body:{expectedLeaseToken:7,outcome:'no_effect',evidence:'Verified fixture effect receipts',executorStopped:true}};
    await expect(create().submit(action)).rejects.toMatchObject({code:'result_unknown'});
    lost=false;await create().recover();expect(writes[1]).toEqual(writes[0]);expect(writes[1]).toMatchObject({expectedVersion:4,expectedLeaseToken:7});expect(f.values.size).toBe(0);
  });
  it('keeps the exact ID and baseline after a lost response and reload',async()=>{
    const f=fixture();f.lose(true);await expect(f.create().submit(request)).rejects.toMatchObject({code:'result_unknown'});
    const sent=f.writes[0].body;f.lose(false);
    await f.create().submit({...request,expectedVersion:99});
    expect(f.writes[1].body).toEqual(sent);expect(f.values.size).toBe(0);
  });
  it('blocks changed drafts, and explicit recovery submits the saved original',async()=>{
    const f=fixture();f.lose(true);const client=f.create();await expect(client.submit(request)).rejects.toThrow();
    await expect(client.submit({...request,body:{mission:'新草稿'}})).rejects.toMatchObject({code:'pending_conflict'});expect(f.writes).toHaveLength(1);
    f.lose(false);await client.recover();expect(f.writes[1].body).toEqual(f.writes[0].body);
  });
  it('does not read or submit another actor pending request',async()=>{
    const f=fixture();f.lose(true);await expect(f.create().submit(request)).rejects.toThrow();
    f.setActor('owner-b');expect(await f.create().pending()).toBeNull();expect(await f.create().recover()).toBeNull();expect(f.writes).toHaveLength(1);
    f.setActor('owner-a');expect(await f.create().pending()).not.toBeNull();
  });
  it('fails before mutation if durable storage is unavailable',async()=>{
    const f=fixture();f.storage.setItem=()=>{throw Error('quota');};await expect(f.create().submit(request)).rejects.toMatchObject({code:'storage_unavailable'});expect(f.writes).toHaveLength(0);
  });
  it('keeps corrupt records and fails closed',async()=>{
    const f=fixture();f.values.set('zhiyu.work-command.v1.owner-a','{broken');await expect(f.create().submit(request)).rejects.toMatchObject({code:'storage_invalid'});expect(f.writes).toHaveLength(0);expect(f.values.size).toBe(1);
  });
  it('deduplicates simultaneous identical clicks',async()=>{
    const f=fixture(),client=f.create();const [a,b]=await Promise.all([client.submit(request),client.submit(request)]);expect(a).toEqual(b);expect(f.writes).toHaveLength(1);
  });
  it('clears known terminal rejection but retains ambiguous server errors',async()=>{
    const f=fixture();f.status(409);await expect(f.create().submit(request)).rejects.toMatchObject({code:'version_conflict'});expect(f.values.size).toBe(0);
    f.status(500);await expect(f.create().submit(request)).rejects.toMatchObject({code:'result_unknown'});expect(f.values.size).toBe(1);
  });
  it('normalizes JSON before comparing a saved request',async()=>{
    const f=fixture();f.lose(true);await expect(f.create().submit({...request,body:{mission:'原始草稿',unused:undefined}})).rejects.toThrow();
    f.lose(false);await f.create().submit(request);expect(f.writes[1].body).toEqual(f.writes[0].body);
  });
  it('rejects missing versions and caller metadata before network access',async()=>{
    const f=fixture();await expect(f.create().submit({...request,expectedVersion:undefined as unknown as number})).rejects.toMatchObject({code:'baseline_missing'});
    await expect(f.create().submit({...request,body:{commandId:'forged'}})).rejects.toMatchObject({code:'invalid_request'});expect(f.writes).toHaveLength(0);
  });
  it('retains a malformed successful response for reconciliation',async()=>{
    const f=fixture();f.status(203);await expect(f.create().submit(request)).rejects.toMatchObject({code:'result_unknown'});expect(f.values.size).toBe(1);
  });
  it('does not coalesce a second actor with an in-flight owner request',async()=>{
    const f=fixture();let actorId='first',writes=0,release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const client=createWorkCommandClient({storage:f.storage,uuid:()=>crypto.randomUUID(),fetch:(async(url)=>{
      if(url==='/api/identity')return Response.json({actorId});
      writes++;await gate;return Response.json({workshop:{id:'work'}});
    }) as typeof fetch});
    const first=client.submit(request);await vi.waitFor(()=>expect(writes).toBe(1));actorId='second';
    await expect(client.submit(request)).rejects.toMatchObject({code:'pending_conflict'});release();await first;expect(writes).toBe(1);
  });
  it('retains a payload conflict for investigation instead of creating another command',async()=>{
    const f=fixture();let sends=0;
    const client=createWorkCommandClient({storage:f.storage,uuid:()=>crypto.randomUUID(),fetch:(async(url)=>{
      if(url==='/api/identity')return Response.json({actorId:'owner-a'});
      sends++;return Response.json({error:'payload_conflict'},{status:409});
    }) as typeof fetch});
    await expect(client.submit(request)).rejects.toMatchObject({code:'payload_conflict'});expect(f.values.size).toBe(1);
    await expect(client.submit({...request,body:{mission:'new'}})).rejects.toMatchObject({code:'pending_conflict'});expect(sends).toBe(1);
  });
});
