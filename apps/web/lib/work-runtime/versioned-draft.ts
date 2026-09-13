export type VersionedDraft<T> = {value:T; version:number; dirty:boolean};
export function refreshDraft<T>(current:VersionedDraft<T>|undefined,value:T,version:number):VersionedDraft<T> {
  return current && (current.dirty || current.version>version) ? current : {value,version,dirty:false};
}
export function editDraft<T>(current:VersionedDraft<T>,value:T):VersionedDraft<T> {return {...current,value,dirty:true};}
export function acceptDraft<T>(current:VersionedDraft<T>,submitted:VersionedDraft<T>):VersionedDraft<T> {
  // An edit made while the request was in flight must survive its completion.
  return current===submitted ? {...current,dirty:false} : current;
}
