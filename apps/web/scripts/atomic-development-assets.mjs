import path from 'node:path';
import {randomUUID} from 'node:crypto';

// An open static response must finish reading its original file, even when
// another development compilation emits the shared layout chunk again.
export function atomicAssetFileSystem(fileSystem,outputPath){
  const wrapper=Object.create(fileSystem);
  wrapper.writeFile=(target,data,callback)=>{
    const relative=path.relative(outputPath,String(target));
    if(relative.startsWith('..')||path.isAbsolute(relative)||!relative.startsWith(`static${path.sep}`)||! /\.(?:js|css)(?:\.map)?$/.test(relative)){
      return fileSystem.writeFile(target,data,callback);
    }
    const temporary=`${target}.${randomUUID()}.tmp`;
    fileSystem.writeFile(temporary,data,error=>{
      if(error)return fileSystem.unlink(temporary,()=>callback(error));
      const deadline=Date.now()+5000;
      const replace=()=>fileSystem.rename(temporary,target,error=>{
        // Windows may lock the old file until its active response closes.
        if(error&&['EPERM','EBUSY','EACCES'].includes(error.code)&&Date.now()<deadline){
          setTimeout(replace,25);return;
        }
        if(error)return fileSystem.unlink(temporary,()=>callback(error));
        callback(null);
      });
      replace();
    });
  };
  return wrapper;
}

export class AtomicDevelopmentAssetsPlugin{
  apply(compiler){
    compiler.hooks.afterEnvironment.tap('AtomicDevelopmentAssets',()=>{
      compiler.outputFileSystem=atomicAssetFileSystem(compiler.outputFileSystem,compiler.options.output.path);
    });
  }
}
