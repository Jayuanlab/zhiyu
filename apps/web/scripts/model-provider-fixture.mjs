/** Loopback HTTP fixture using real protocol SSE envelopes. No outbound calls. */
import { createServer } from 'node:http';

export async function startModelProviderFixture(options = {}) {
  const observed = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    observed.push({
      path,
      body,
      authorization: req.headers.authorization,
      apiKey: req.headers['x-api-key'],
    });
    if (body.model === 'reject') {
      res.writeHead(403);
      res.end('{"error":{"message":"fixture-secret-must-not-leak"}}');
      return;
    }
    if (body.model === 'bad-json') {
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
      return;
    }
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    const send = (event) =>
      res.write(
        `${path.endsWith('/chat/completions') ? '' : `event: ${event.type}\n`}data: ${JSON.stringify(event)}\n\n`,
      );
    const source = JSON.stringify(body.messages ?? body.input ?? []);
    const tool =
      body.model === 'tool' &&
      !/"role":"tool"|"type":"tool_result"|"type":"function_call_output"/.test(
        source,
      );
    const text = body.model === 'plan'
      ? JSON.stringify({type:'plan',goal:'Fixture reviewed goal',steps:[{description:'Use the current owner-approved source'}],notes:'Model-produced proposal; no authority'})
      : options.text ? options.text(body) : 'fixture-ok';
    const truncated = body.model === 'truncated';
    const missing = body.model === 'missing-terminal';
    if (body.model === 'delay') {
      res.flushHeaders();
      return;
    }
    if (path.endsWith('/chat/completions')) {
      const chunk = (delta, finish_reason = null) =>
        send({
          id: 'chatcmpl_fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason }],
        });
      chunk({
        role: 'assistant',
        ...(tool
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_probe',
                  type: 'function',
                  function: { name: 'readConfigProbe', arguments: '{}' },
                },
              ],
            }
          : { content: text }),
      });
      if (!missing) {
        chunk({}, truncated ? 'length' : tool ? 'tool_calls' : 'stop');
        res.write('data: [DONE]\n\n');
      }
    } else if (path.endsWith('/messages')) {
      send({
        type: 'message_start',
        message: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 2, output_tokens: 0 },
        },
      });
      send({
        type: 'content_block_start',
        index: 0,
        content_block: tool
          ? {
              type: 'tool_use',
              id: 'call_probe',
              name: 'readConfigProbe',
              input: {},
            }
          : { type: 'text', text: '' },
      });
      send({
        type: 'content_block_delta',
        index: 0,
        delta: tool
          ? { type: 'input_json_delta', partial_json: '{}' }
          : { type: 'text_delta', text },
      });
      send({ type: 'content_block_stop', index: 0 });
      if (!missing) {
        send({
          type: 'message_delta',
          delta: {
            stop_reason: truncated
              ? 'max_tokens'
              : tool
                ? 'tool_use'
                : 'end_turn',
            stop_sequence: null,
          },
          usage: { output_tokens: 3 },
        });
        send({ type: 'message_stop' });
      }
    } else if (path.endsWith('/responses')) {
      const item = tool
        ? {
            id: 'fc_probe',
            type: 'function_call',
            call_id: 'call_probe',
            name: 'readConfigProbe',
            arguments: '{}',
            status: 'completed',
          }
        : {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          };
      send({
        type: 'response.created',
        response: {
          id: 'resp_fixture',
          status: 'in_progress',
          model: body.model,
        },
      });
      send({
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, ...(tool ? { arguments: '' } : { content: [] }) },
      });
      send(
        tool
          ? {
              type: 'response.function_call_arguments.delta',
              output_index: 0,
              delta: '{}',
            }
          : {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: text,
            },
      );
      send({ type: 'response.output_item.done', output_index: 0, item });
      if (!missing)
        send({
          type: truncated ? 'response.incomplete' : 'response.completed',
          response: {
            id: 'resp_fixture',
            status: truncated ? 'incomplete' : 'completed',
            model: body.model,
            output: [item],
            incomplete_details: truncated
              ? { reason: 'max_output_tokens' }
              : null,
            usage: {
              input_tokens: 2,
              output_tokens: 3,
              total_tokens: 5,
              input_tokens_details: { cached_tokens: 0 },
            },
          },
        });
    } else {
      res.writeHead(404);
    }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    observed,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
