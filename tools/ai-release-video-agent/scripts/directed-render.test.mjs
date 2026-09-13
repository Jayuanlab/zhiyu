import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {renderEditorialVideo} from '../src/editorial-renderer.mjs';
const command=args=>execFileSync('ffmpeg',['-v','error','-y',...args],{windowsHide:true});
const args={videoProvider:'test-fixture',ttsProvider:'fixture'};
const scene={caption:'TEST FOOTAGE',voiceover:'Fixture audio.',shot:{mode:'generated',rationale:'Test actual media composition',prompt:'Fixture',transition:'cut',motion:'push-in'}};
function createVoiceover({outputDir}){
 const audio=join(outputDir,'voiceover.mp3');command(['-f','lavfi','-i','sine=frequency=440:duration=1','-c:a','libmp3lame',audio]);
 writeFileSync(join(outputDir,'voiceover.srt'),'1\n00:00:00,000 --> 00:00:01,000\nTEST FIXTURE\n');return audio;
}
test('provider failure produces no final video and records the error',async()=>{
 const planDir=mkdtempSync(join(tmpdir(),'zhiyu-directed-failure-'));
 await assert.rejects(renderEditorialVideo({storyboard:{scenes:[scene]},args,planDir,createVoiceover,generateVideo:async()=>{throw new Error('Provider 401')}}),/Provider 401/);
 assert.equal(existsSync(join(planDir,'assets/final.mp4')),false);
 assert.equal(JSON.parse(readFileSync(join(planDir,'assets/segment-1/generation-status.json'))).status,'failed');
});
test('video media and independent title shot are composed into a real timeline',async()=>{
 const planDir=mkdtempSync(join(tmpdir(),'zhiyu-directed-compose-'));
 writeFileSync(join(planDir,'manifest.json'),JSON.stringify({riskDisclosure:'TECHNICAL TEST - SYNTHETIC FIXTURE'}));
 const result=await renderEditorialVideo({storyboard:{scenes:[scene,{caption:'A DIFFERENT BEAT',voiceover:'Fixture audio.',shot:{mode:'title',rationale:'Contrast pacing',background:'#F5EFDE',foreground:'#173438',accent:'#BD632F',transition:'fade'}}]},args,planDir,createVoiceover,generateVideo:async({outputDir})=>{
   const file=join(outputDir,'fixture.mp4');command(['-f','lavfi','-i','testsrc2=size=720x1280:rate=25:duration=2','-c:v','libx264','-pix_fmt','yuv420p',file]);return file;
 }});
 const plan=JSON.parse(readFileSync(join(planDir,'edit-plan.json')));
 assert.equal(plan.shots[0].media.provider,'test-fixture');assert.equal(plan.shots[1].shot.mode,'title');assert.ok(existsSync(result.finalPath));
 const report=JSON.parse(readFileSync(join(planDir,'assets/quality-report.json')));assert.equal(report.generatedShots,1);
 console.log('TECHNICAL_FIXTURE_VIDEO='+result.finalPath);
});
