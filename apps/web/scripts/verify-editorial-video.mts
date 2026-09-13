import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderInvestmentResearchVideo } from '../lib/video/investment-video-renderer';

const fixture = JSON.parse(readFileSync(resolve('../../tools/ai-release-video-agent/fixtures/editorial-smoke/storyboard.json'), 'utf8'));
const result = await renderInvestmentResearchVideo({
  title: '知识视频动态剪辑验收', description: '真实服务入口回测，不发布',
  riskDisclosure: '此视频为知语功能演示，由 AI 辅助生成。',
  scenes: fixture.scenes, durationSeconds: 25, userId: 'editorial-verification',
});
writeFileSync(resolve('../../tools/ai-release-video-agent/fixtures/editorial-smoke/service-result.json'), JSON.stringify(result,null,2),'utf8');
console.log(JSON.stringify({ok:result.ok,localPath:result.localPath,planDir:result.planDir,durationSeconds:result.durationSeconds,renderMode:result.renderMode,error:result.error},null,2));
if(!result.ok) process.exitCode=1;
