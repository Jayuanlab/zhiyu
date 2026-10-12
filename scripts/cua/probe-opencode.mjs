import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

const envText = readFileSync(new URL('../../apps/web/.env', import.meta.url), 'utf8');
const keyLine = envText.split(/\r?\n/).find((line) => /^OPENCODE_API_KEY=/.test(line));
const apiKey = keyLine?.slice('OPENCODE_API_KEY='.length).trim().replace(/^['"]|['"]$/g, '');
if (!apiKey) throw new Error('OPENCODE_API_KEY is absent');

const session = randomUUID();
const provider = process.argv[2] === 'zen' ? 'zen' : 'go';
const model = process.argv[3] ?? (provider === 'zen' ? 'gpt-6-astra' : 'gpt-6-luna');
const client = new OpenAI({
  apiKey,
  baseURL: provider === 'zen' ? 'https://opencode.ai/zen/v1' : 'https://opencode.ai/zen/go/v1',
  defaultHeaders: {
    'x-opencode-session': session,
    'user-agent': 'zhiyu-cua-compat-probe/1.0',
  },
  timeout: 30_000,
  maxRetries: 0,
});
const image = `data:image/png;base64,${readFileSync(new URL('../../apps/web/public/images/apps/youtube.png', import.meta.url)).toString('base64')}`;
const tools = [{
  type: 'function', name: 'exec_js', description: 'Run JavaScript in a browser.', strict: true,
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
}];

try {
  const first = await client.responses.create({
    model,
    instructions: 'You must first call exec_js with code console.log("probe-ok"). After the tool output, answer done.',
    input: 'Perform the harmless protocol probe.',
    tools, parallel_tool_calls: false, reasoning: { effort: 'low' }, truncation: 'auto',
  });
  const call = first.output?.find((item) => item.type === 'function_call' && item.name === 'exec_js');
  console.log(JSON.stringify({ stage: 'tool_call', status: first.status, hasId: Boolean(first.id), hasCall: Boolean(call), outputTypes: first.output?.map((item) => item.type) }));
  if (!call?.call_id) process.exitCode = 2;
  else {
    const second = await client.responses.create({
      model,
      instructions: 'Acknowledge the screenshot and answer done.',
      previous_response_id: first.id,
      input: [{ type: 'function_call_output', call_id: call.call_id, output: [
        { type: 'input_text', text: 'probe-ok' },
        { type: 'input_image', image_url: image, detail: 'low' },
      ] }],
      tools, parallel_tool_calls: false, reasoning: { effort: 'low' }, truncation: 'auto',
    });
    console.log(JSON.stringify({ stage: 'continued_with_image', status: second.status, hasId: Boolean(second.id), outputTypes: second.output?.map((item) => item.type), text: second.output_text?.slice(0, 80) }));
  }
} catch (error) {
  const detail = String(error.message ?? '').replaceAll(apiKey, '[redacted]').replace(/[A-Za-z0-9+/=]{60,}/g, '[data]').slice(0, 500);
  console.error(JSON.stringify({ stage: 'error', status: error.status ?? null, code: error.code ?? null, name: error.name ?? 'Error', detail }));
  process.exitCode = 1;
}
