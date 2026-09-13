import {mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {normalizeEditorialScene, parseSrt} from './edit-plan.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const command=(exe,args)=>execFileSync(exe,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:900000});
const duration=path=>Number(command('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',path]).toString().trim());

export async function renderEditorialVideo({storyboard,args,planDir,createVoiceover,generateVideo}) {
  const scenes=storyboard.scenes.map(normalizeEditorialScene);
  const assetsDir=resolve(planDir,'assets'); mkdirSync(assetsDir,{recursive:true});
  const finalPath=resolve(assetsDir,'final.mp4');
  if(existsSync(finalPath)) throw new Error('Use a new plan directory: existing video must not be overwritten.');
  const plan={version:2,renderer:'remotion',fps:25,frames:0,shots:[],captions:[],warnings:[]};
  const manifestPath=resolve(planDir,'manifest.json');
  if(existsSync(manifestPath)) plan.disclosure=JSON.parse(readFileSync(manifestPath,'utf8')).riskDisclosure || '';
  const audioPaths=[];
  const publicDir=resolve(assetsDir,'public');mkdirSync(publicDir,{recursive:true});
  for(const [index,scene] of scenes.entries()) {
    console.log(`Narration ${index+1}/${scenes.length}`);
    const shotDir=resolve(assetsDir,`segment-${index+1}`);mkdirSync(shotDir,{recursive:true});
    const textPath=resolve(shotDir,'voiceover.txt');writeFileSync(textPath,scene.narration,'utf8');
    const audio=createVoiceover({textPath,outputDir:shotDir,provider:args.ttsProvider,voice:args.ttsVoice});
    const seconds=duration(audio); const frames=Math.ceil((seconds+.18)*25); const start=plan.frames/25;
    const srtPath=resolve(shotDir,'voiceover.srt');
    const captions=audio.endsWith('.mp3')&&existsSync(srtPath)?parseSrt(readFileSync(srtPath,'utf8')):[];
    if(!captions.length) throw new Error('Precise narration captions unavailable. Restore Edge TTS before generating a publishable video.');
    plan.captions.push(...captions.map(c=>({...c,start:c.start+start,end:c.end+start})));
    const cueFrames = scene.display.items.map((item,i)=> {
      const match=captions.find(c=>c.text.includes(item));
      return Math.round((match?.start ?? captions[Math.min(i,captions.length-1)].start)*25);
    });
    let media;
    if(scene.shot?.mode==='generated') {
      if(!generateVideo)throw new Error('Video model is unavailable; generated shots cannot become text cards.');
      if(frames/25>15)throw new Error(`${scene.id}: generated shot narration exceeds 15 seconds; split the scene.`);
      const request={prompt:[scene.shot.prompt,'No rendered captions, readable UI text or logos. Illustrative AI footage, not documentary evidence.'].join('\n'),outputDir:shotDir,durationSeconds:Math.ceil(frames/25)};
      writeFileSync(resolve(shotDir,'generation-intent.json'),JSON.stringify({...request,outputDir:undefined,rationale:scene.shot.rationale},null,2),'utf8');
      console.log(`Generating shot ${index+1}/${scenes.length}`);
      let generated;
      try { generated=await generateVideo(request); }
      catch(error) {
        writeFileSync(resolve(shotDir,'generation-status.json'),JSON.stringify({status:'failed',provider:args.videoProvider,error:error.message,at:new Date().toISOString()},null,2),'utf8');
        throw error;
      }
      const sourceSeconds=duration(generated);
      if(sourceSeconds < frames/25-.1)throw new Error(`${scene.id}: generated clip too short (${sourceSeconds}s); refusing repeated/frozen filler.`);
      const filename=`shot-${index+1}.mp4`;copyFileSync(generated,resolve(publicDir,filename));
      media={filename,provider:args.videoProvider,generated:true,sourceSeconds,usedSeconds:frames/25};
      writeFileSync(resolve(shotDir,'generation-status.json'),JSON.stringify({status:'ready',...media,at:new Date().toISOString()},null,2),'utf8');
    }
    plan.shots.push({...scene,media,from:plan.frames,frames,cueFrames,animationCuePolicy:'matching-sentence-or-sentence-index',voiceoverSeconds:seconds,captionTiming:'tts-boundary'});
    writeFileSync(resolve(planDir,'edit-plan.json'),JSON.stringify(plan,null,2),'utf8');
    plan.frames+=frames;
    if(plan.frames>180*25)throw new Error('Narration exceeds 180 seconds; shorten script.');
    const wav=resolve(shotDir,'padded.wav');
    command('ffmpeg',['-v','error','-y','-i',audio,'-af','apad','-t',String(frames/25),'-ar','48000','-ac','1',wav]);
    audioPaths.push(wav);
    if(scene.adaptation==='narration-summary')plan.warnings.push(`${scene.id}: legacy input uses narration summary, not a fabricated diagram`);
  }
  writeFileSync(resolve(planDir,'edit-plan.json'),JSON.stringify(plan,null,2),'utf8');
  const list=resolve(assetsDir,'audio-list.txt');
  writeFileSync(list,audioPaths.map(p=>`file '${p.replace(/\\/g,'/').replace(/'/g,"'\\''")}'`).join('\n'),'utf8');
  const voiceoverPath=resolve(assetsDir,'voiceover.wav');
  command('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-c','copy',voiceoverPath]);
  const {bundle}=await import('@remotion/bundler');
  console.log('Preparing editorial composition');
  const {renderMedia,selectComposition}=await import('@remotion/renderer');
  const {chromium}=await import('playwright');
  const localBrowser=chromium.executablePath();
  const browserExecutable=existsSync(localBrowser)?localBrowser:undefined;
  const serveUrl=await bundle({entryPoint:resolve(root,'editorial-video.jsx'),publicDir});
  const inputProps={plan};
  const composition=await selectComposition({serveUrl,id:'KnowledgeVideo',inputProps,browserExecutable});
  const visualTrackPath=resolve(assetsDir,'visual-track.mp4');
  let lastProgress=-1;
  await renderMedia({serveUrl,composition,inputProps,browserExecutable,codec:'h264',outputLocation:visualTrackPath,concurrency:2,logLevel:'error',onProgress:({progress})=>{
    const step=Math.floor(progress*4);if(step!==lastProgress){lastProgress=step;console.log(`Rendering ${step*25}%`);}
  }});
  command('ffmpeg',['-v','error','-y','-i',visualTrackPath,'-i',voiceoverPath,'-map','0:v','-map','1:a','-c:v','copy','-c:a','aac','-t',String(plan.frames/25),finalPath]);
  const actual=duration(finalPath);
  if(Math.abs(actual-plan.frames/25)>.2)throw new Error('Final duration mismatch');
  const report={passed:true,checks:['validated display contract','TTS boundary captions','complete audio timeline','final duration','generated media present and long enough'],generatedShots:plan.shots.filter(s=>s.media).length,visualReview:'required',warnings:plan.warnings};
  writeFileSync(resolve(assetsDir,'quality-report.json'),JSON.stringify(report,null,2),'utf8');
  writeFileSync(resolve(assetsDir,'render-metadata.json'),JSON.stringify({renderMode:'remotion-editorial',durationSeconds:actual,voiceoverDurationSeconds:duration(voiceoverPath),finalPath,voiceoverPath,visualTrackPath,warnings:plan.warnings,generatedAt:new Date().toISOString()},null,2),'utf8');
  return {planDir,assetsDir,finalPath};
}
