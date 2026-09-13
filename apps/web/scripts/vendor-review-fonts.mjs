// One-time asset import from an already verified build, never called by build/start.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const web=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const stage=process.argv[2];
if(!/^\d{2}$/.test(stage??''))throw Error('Expected verified build ID');
const build=path.join(web,'.tmp',`next-review-${stage}`);
if(!fs.existsSync(path.join(build,'BUILD_ID')))throw Error('Source build incomplete');
const output=path.join(web,'public/vendor/fonts');
const cssRoot=path.join(build,'static/css');
const definitions=[['Noto Sans SC','zhiyu-font-sans'],['Noto Serif SC','zhiyu-font-serif'],['Roboto','zhiyu-font-roboto']];
const sources=fs.readdirSync(cssRoot).filter(file=>file.endsWith('.css')).map(file=>({file,css:fs.readFileSync(path.join(cssRoot,file),'utf8')}));
const fonts=new Map(),preloads=new Set(),styles=[];
fs.mkdirSync(output,{recursive:true});
for(const [family,className] of definitions){
  const matches=sources.filter(({css})=>new RegExp(`font-family:"?${family}"?;`).test(css));
  if(matches.length!==1)throw Error(`Expected one stylesheet for ${family}`);
  const source=matches[0];
  const residual=source.css.replace(/@font-face\{[^}]*\}/g,'').replace(/\.__[\w]+\{[^}]*\}/g,'').trim();
  if(residual)throw Error('Unexpected non-font CSS');
  const css=source.css.replace(/url\(\/_next\/static\/media\/([a-f0-9]+-s(?:\.p)?\.woff2)\)/g,(_match,file)=>{
    const bytes=fs.readFileSync(path.join(build,'static/media',file));
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const target=path.join(output,file);
    if(fs.existsSync(target)&&createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==sha256)throw Error('Asset collision');
    fs.writeFileSync(target,bytes);
    fonts.set(file,{file,bytes:bytes.length,sha256});
    if(file.includes('.p.'))preloads.add(`/vendor/fonts/${file}`);
    return `url(/vendor/fonts/${file})`;
  }).replace(/\.__className_[\w]+/g,`.${className}`).replace(/\.__variable_[\w]+/g,`.${className}-variable`);
  if(css.includes('/_next/static/media/')||/https?:/.test(css))throw Error('Unresolved font URL');
  styles.push(css);
}
fs.writeFileSync(path.join(web,'app/local-fonts.css'),`/* Same font faces, weights, ranges and fallback metrics as verified build ${stage}. */\n${styles.join('\n')}\n`,'utf8');
fs.writeFileSync(path.join(web,'app/local-fonts.ts'),`// Local font resources; no build-time downloads.\nexport const localFontClasses = ${JSON.stringify(definitions.map(row=>row[1]).join(' '))};\nexport const localFontPreloads = ${JSON.stringify([...preloads])};\n`,'utf8');
const manifest={sourceBuild:stage,families:definitions.map(row=>row[0]),preloads:[...preloads],assets:[...fonts.values()]};
fs.writeFileSync(path.join(output,'provenance.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
console.log(JSON.stringify({families:manifest.families,assets:fonts.size,bytes:[...fonts.values()].reduce((sum,row)=>sum+row.bytes,0),preloads:preloads.size}));
