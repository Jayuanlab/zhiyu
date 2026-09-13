import {promises as fs} from 'node:fs';
import path from 'node:path';

/** Next's dev route discovery can issue overlapping writes to the same type file.
 * Serialize only this application's generated type files, leaving other I/O alone. */
export function serializedTypeWriter(writeFile,typesDirectory){
  const pending=new Map();
  const normalize=value=>process.platform==='win32'?value.toLowerCase():value;
  const directory=normalize(path.resolve(typesDirectory));
  return function(target,...args){
    if(typeof target!=='string'||normalize(path.dirname(path.resolve(target)))!==directory||!target.endsWith('.ts'))return writeFile(target,...args);
    const key=normalize(path.resolve(target));
    const previous=pending.get(key)??Promise.resolve();
    const current=previous.catch(()=>{}).then(()=>writeFile(target,...args));
    pending.set(key,current);
    void current.finally(()=>{if(pending.get(key)===current)pending.delete(key);}).catch(()=>{});
    return current;
  };
}
export function installSerializedDevTypeWrites(web,reviewStage){
  const dist=/^\d{2}$/.test(reviewStage??'')?`.tmp/next-review-${reviewStage}`:'.next';
  fs.writeFile=serializedTypeWriter(fs.writeFile.bind(fs),path.join(web,dist,'dev/types'));
}
