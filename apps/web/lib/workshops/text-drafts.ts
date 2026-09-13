export type DraftField='directive'|'loopIntent';
type Draft={directive:string;loopIntent:string};
type Snapshot={rows:Record<string,Draft>;warning:string|null};
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'>;
export const emptyTextDraftSnapshot:Snapshot={rows:{},warning:null};
const empty=():Draft=>({directive:'',loopIntent:''});
const warning='草稿状态无法保存到浏览器，当前编辑仍在页面中。离开或刷新前请复制内容，并核对已提交操作。';

/** A receipt acknowledges only the submitted text of its original owner/work. */
export function createWorkshopTextDraftStore(ownerId:string|null,storage?:Storage){
  const key=ownerId?`workshop-text-drafts:v1:${ownerId}`:null;
  let snapshot:Snapshot=emptyTextDraftSnapshot;
  const listeners=new Set<()=>void>();
  if(key){
    try{
      if(!storage)throw Error('storage_unavailable');
      const raw=storage.getItem(key);
      if(raw){
        const parsed=JSON.parse(raw);
        if(parsed.version!==1||!parsed.rows||typeof parsed.rows!=='object'||Array.isArray(parsed.rows))throw Error('invalid_drafts');
        const rows:Record<string,Draft>={};
        for(const [id,value] of Object.entries(parsed.rows)){
          const draft=value as Draft;
          if(!/^[a-f0-9-]{36}$/i.test(id)||!draft||typeof draft.directive!=='string'||typeof draft.loopIntent!=='string')throw Error('invalid_draft');
          rows[id]={directive:draft.directive,loopIntent:draft.loopIntent};
        }
        snapshot={rows,warning:null};
      }
    }catch{snapshot={rows:{},warning};}
  }
  const publish=(rows:Record<string,Draft>)=>{
    let failure:string|null=null;
    try{if(!storage||!key)throw Error('storage_unavailable');storage.setItem(key,JSON.stringify({version:1,rows}));}
    catch{failure=warning;}
    snapshot={rows,warning:failure};for(const listener of listeners)listener();
  };
  return {
    getSnapshot:()=>snapshot,
    subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};},
    edit:(workId:string,field:DraftField,value:string)=>{
      if(!key)return;
      const draft={...(snapshot.rows[workId]??empty()),[field]:value};
      const rows={...snapshot.rows};
      if(draft.directive||draft.loopIntent)rows[workId]=draft;else delete rows[workId];
      publish(rows);
    },
    acknowledge:(workId:string,field:DraftField,submitted:string)=>{
      // A previous component may complete after a new instance edited the draft.
      // Re-read the tab's current durable snapshot before applying that receipt.
      if(key&&storage&&!snapshot.warning){
        const latest=createWorkshopTextDraftStore(ownerId,storage).getSnapshot();
        if(latest.warning){snapshot={...snapshot,warning:latest.warning};for(const listener of listeners)listener();return;}
        snapshot=latest;
      }
      if(!key||snapshot.rows[workId]?.[field]!==submitted)return;
      const draft={...snapshot.rows[workId],[field]:''};
      const rows={...snapshot.rows};
      if(draft.directive||draft.loopIntent)rows[workId]=draft;else delete rows[workId];
      publish(rows);
    },
  };
}
