import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {writeAppTypeDeclarations} from 'next/dist/lib/typescript/writeAppTypeDeclarations.js';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const target=path.join(web,'next-env.d.ts'),original=fs.readFileSync(target);
const report=[];
try{
  for(let attempt=0;attempt<10;attempt++){
    fs.writeFileSync(target,original);
    try{
      await writeAppTypeDeclarations({baseDir:web,distDir:'.tmp/next-review-38',imageImportsEnabled:true,hasPagesDir:false,hasAppDir:true,strictRouteTypes:false,typedRoutes:false});
      const content=fs.readFileSync(target,'utf8');
      if(!content.includes('.tmp/next-review-38/types/routes.d.ts'))throw Error('wrong declaration');
      report.push({attempt,passed:true});
    }catch(error){report.push({attempt,passed:false,code:error.code,message:error.message});}
  }
}finally{fs.writeFileSync(target,original);}
console.log(JSON.stringify({restored:fs.readFileSync(target).equals(original),checks:report},null,2));
if(report.some(item=>!item.passed))process.exitCode=1;
