import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {createDouyinPublishDraft,getDouyinPublishDraft} from '../lib/douyin/client';
const workshopId=process.argv[2];
if(!workshopId||!/^[0-9a-f-]{36}$/.test(workshopId))throw Error('Provide the workshop id explicitly');
const fixtureDir=resolve('../../tools/ai-release-video-agent/fixtures/editorial-smoke');
const result=JSON.parse(readFileSync(resolve(fixtureDir,'service-result.json'),'utf8'));
if(!result.ok||!existsSync(result.localPath))throw Error('Successful rendered video required');
const hash=createHash('sha256').update(readFileSync(result.localPath)).digest('hex');
const draft=await createDouyinPublishDraft({
 id:`editorial-preview-${hash.slice(0,16)}`,title:'剪辑链路验收样片：流程展开与双栏对比',
 description:'21 秒功能演示，仅供审核预览。此草稿未上传或发布。',
 video_path:result.localPath,ai_generated:true,topics:['功能演示'],
 source:{workshopId,kind:'editorial_integration_verification',videoHash:hash,planDir:result.planDir},
});
if(!draft.ok)throw Error(draft.error||'Draft creation failed');
const saved=await getDouyinPublishDraft(draft.draft.id);
if(saved.draft.status!=='draft'||saved.draft.video_path!==result.localPath)throw Error('Draft readback failed');
writeFileSync(resolve(fixtureDir,'draft-result.json'),JSON.stringify({draftId:saved.draft.id,videoHash:hash,status:saved.draft.status,videoPath:saved.draft.video_path},null,2),'utf8');
console.log(JSON.stringify({id:saved.draft.id,status:saved.draft.status,title:saved.draft.title}));
