import { randomUUID } from 'node:crypto';

const origin = process.env.WORKSHOP_URL ?? 'http://127.0.0.1:3515';
const name = '电脑操作验收车间';

async function request(path, options) {
  const response = await fetch(new URL(path, origin), {
    ...options,
    headers: { 'content-type': 'application/json', origin, ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body;
}

const listed = await request('/api/workshops');
let work = listed.workshops.find(item => item.name === name);
if (!work) {
  const created = await request('/api/workshops', {
    method: 'POST',
    body: JSON.stringify({
      commandId: randomUUID(),
      name,
      mission: '接收主人明确交代的电脑操作任务。执行前确认目标、权限和边界；仅使用获准的 computer use 工具，保留操作事件、截图与回放，并根据目标状态核验结果。本轮验收只读取测试网页，不发送消息、不修改文件或账号。',
      autonomyLevel: 'draft',
      boundaryPolicy: {
        mode: 'draft',
        deniedPrecedence: true,
        externalMessages: 'blocked',
        hardDeniedActions: ['wechatDesktopSendMessage', 'externalPayment', 'realBrokerOrder', 'deleteLoopTask'],
        customInstructions: '只接受主人明确指定的操作目标。本轮只读验收：打开公开测试网页，读取标题和正文，不提交表单、不登录、不发送消息、不写文件。',
      },
      modelConfig: {
        agentRuntimeEngine: 'pi',
        allowedTools: ['workshopRunComputerUse'],
      },
    }),
  });
  work = created.workshop;
}
if (!work || !Array.isArray(work.modelConfig?.allowedTools) ||
    !work.modelConfig.allowedTools.includes('workshopRunComputerUse')) {
  throw new Error('Computer use is not explicitly granted to the verification Work');
}
if (work.name !== name || work.name.includes('�') || work.name.includes('???')) {
  throw new Error('Work name was corrupted in storage');
}
const submitted = await request(`/api/workshops/${work.id}/conversation`, {
  method: 'POST',
  body: JSON.stringify({
    commandId: randomUUID(),
    content: '请用 workshopRunComputerUse 的 javascript 后端完成一次只读电脑操作。CUA 启动后已有本地测试页，不要导航到其他网站。读取该页 document.title、h1 和 p 的实际文本，并截一张图。不要登录、提交表单或修改任何内容。根据执行记录报告实际读取的文字、CUA run ID 和回放是否保存；若工具未调用或失败，不要声称已完成。',
  }),
});
console.log(JSON.stringify({ workId: work.id, runId: submitted.turn.runId ?? submitted.turn.id, status: submitted.turn.status, name: work.name }));
