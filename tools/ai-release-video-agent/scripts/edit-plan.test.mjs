import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEditorialScene,parseSrt} from '../src/edit-plan.mjs';
test('legacy visual directions never enter displayed content',()=>{
 const s=normalizeEditorialScene({caption:'流程介绍',voiceover:'先检查来源。再核验事实。',visual:'对比图：左边旧系统，右边新系统'});
 assert.equal(s.display.kind,'takeaway');assert.ok(!JSON.stringify(s.display).includes('对比图'));
});
test('invalid comparisons and leaked directions are blocked',()=>{
 assert.throws(()=>normalizeEditorialScene({caption:'比较',voiceover:'比较。',onScreen:{kind:'comparison',items:[]}}));
 assert.throws(()=>normalizeEditorialScene({caption:'比较',voiceover:'比较。',onScreen:{kind:'takeaway',items:['底部显示来源']}}));
});
test('TTS timing retains real starts and ends',()=>{
 assert.deepEqual(parseSrt('1\r\n00:00:01,250 --> 00:00:02,700\r\n测试字幕\r\n'),[{start:1.25,end:2.7,text:'测试字幕'}]);
});
test('director shots preserve decisions without inventing text cards',()=>{
 const s=normalizeEditorialScene({caption:'Opening',voiceover:'One short sentence.',shot:{mode:'generated',prompt:'A paper spiral',rationale:'Introduce motion',transition:'cut'}});
 assert.equal(s.shot.mode,'generated');assert.deepEqual(s.display.items,[]);
 assert.throws(()=>normalizeEditorialScene({caption:'X',voiceover:'X',shot:{mode:'generated',rationale:'X'}}));
 assert.throws(()=>normalizeEditorialScene({caption:'X',voiceover:'X',shot:{mode:'graphic',rationale:'X'}}));
 assert.throws(()=>normalizeEditorialScene({caption:'X',voiceover:'X',shot:{mode:'title',rationale:'X',background:'url(secret)'}}));
});
