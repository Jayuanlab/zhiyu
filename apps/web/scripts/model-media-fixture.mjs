/** Loopback-only media protocol fixture. No cloud accounts or outbound calls. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export function fixtureWav() {
  const bytes = Buffer.alloc(44 + 16000 * 2);
  bytes.write('RIFF');
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 16000; i++)
    bytes.writeInt16LE(
      Math.round(4000 * Math.sin((i * 440 * 2 * Math.PI) / 16000)),
      44 + i * 2,
    );
  return bytes;
}
export async function startModelMediaFixture(options = {}) {
  const observed = [],
    tasks = new Map();
  let baseUrl = '',
    submitted = 0;
  const wav = fixtureWav(),
    video = await readFile(
      new URL('../tests/fixtures/model-service-test.mp4', import.meta.url),
    );
  const handler = async (req, res) => {
    try {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body =
        raw && req.headers['content-type']?.includes('json')
          ? JSON.parse(raw)
          : {};
      observed.push({
        path,
        method: req.method,
        authorization: req.headers.authorization,
        body,
        bytes: raw.length,
        redirect: req.headers['x-dashscope-async'],
      });
      const json = (value) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(value));
      };
      if (body.model === 'http-error') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ message: 'fixture-private-provider-body-and-key' }),
        );
        return;
      }
      if (body.model === 'delay') {
        res.flushHeaders();
        return;
      }
      if (
        path.endsWith('/embeddings') ||
        path.endsWith('/text-embedding/text-embedding')
      ) {
        const native = !path.endsWith('/embeddings'),
          texts = native
            ? body.input.texts
            : Array.isArray(body.input)
              ? body.input
              : [body.input];
        const dim =
          body.model === 'bad-dimension'
            ? 2
            : (body.dimensions ?? body.parameters?.dimension ?? 3);
        const values = texts.map((_, index) => ({
          index,
          text_index: index,
          embedding: Array.from({ length: dim }, (_, i) =>
            body.model === 'zero' ? 0 : (index + 1) * 0.01 + (i + 1) * 0.001,
          ),
        }));
        return json(
          body.model === 'empty'
            ? {}
            : native
              ? { output: { embeddings: values } }
              : { data: values.reverse() },
        );
      }
      if (path.endsWith('/audio/speech')) {
        res.setHeader('Content-Type', 'audio/wav');
        res.end(wav);
        return;
      }
      if (
        path.endsWith('/SpeechSynthesizer') ||
        (path.endsWith('/generation') && body.input?.text)
      )
        return json({
          output: {
            ...(body.model === 'unfinished' ? {} : { finish_reason: 'stop' }),
            audio: {
              url:
                body.model === 'unsafe-media'
                  ? 'http://169.254.169.254/private'
                  : baseUrl + '/media/test.wav',
            },
          },
        });
      if (path.endsWith('/audio/transcriptions'))
        return json({ text: '你好，这是知遇的语音测试。' });
      if (path.endsWith('/generation'))
        return json({
          output: {
            choices: [
              {
                finish_reason: body.model === 'unfinished' ? 'length' : 'stop',
                message: {
                  content: [
                    {
                      text:
                        body.model === 'empty'
                          ? ''
                          : '你好，这是知遇的语音测试。',
                    },
                  ],
                },
              },
            ],
          },
        });
      if (path.endsWith('/video-synthesis')) {
        submitted++;
        const id = randomUUID();
        tasks.set(id, { polls: 0, model: body.model });
        return json({ output: { task_id: id, task_status: 'PENDING' } });
      }
      if (path.includes('/tasks/')) {
        const id = path.split('/').at(-1),
          task = tasks.get(id);
        if (!task) {
          res.writeHead(404);
          return res.end();
        }
        task.polls++;
        return json({
          output: {
            task_status:
              task.model === 'failed'
                ? 'FAILED'
                : task.model === 'pending' || task.polls === 1
                  ? 'RUNNING'
                  : 'SUCCEEDED',
            ...(task.polls > 1
              ? {
                  video_url:
                    baseUrl +
                    (task.model === 'invalid-video'
                      ? '/media/invalid.mp4'
                      : '/media/test.mp4'),
                }
              : {}),
          },
        });
      }
      if (path.endsWith('/test.wav')) {
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wav.length,
        });
        res.end(wav);
        return;
      }
      if (path.endsWith('/test.mp4')) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Content-Length': video.length,
        });
        res.end(video);
        return;
      }
      if (path.endsWith('/invalid.mp4')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>not a video</html>');
        return;
      }
      res.writeHead(404);
      res.end();
    } catch {
      res.writeHead(500);
      res.end();
    }
  };
  const server = createServer(handler);
  if (options.listen !== false)
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl =
    options.listen === false
      ? 'http://127.0.0.1:9999'
      : 'http://127.0.0.1:' + server.address().port;
  const fixtureFetch = async (input, init = {}) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const payload = new Uint8Array(await request.arrayBuffer());
    return new Promise((resolve, reject) => {
      const headers = new Headers();
      let status = 200;
      const onAbort = () => reject(request.signal.reason);
      request.signal.addEventListener('abort', onAbort, { once: true });
      const response = {
        setHeader: (key, value) => headers.set(key, String(value)),
        writeHead: (code, values) => {
          status = code;
          for (const [key, value] of Object.entries(values || {}))
            headers.set(key, String(value));
        },
        flushHeaders: () => {},
        end: (body) => {
          request.signal.removeEventListener('abort', onAbort);
          resolve(new Response(body ?? null, { status, headers }));
        },
      };
      const req = {
        url: new URL(request.url).pathname,
        method: request.method,
        headers: Object.fromEntries(request.headers),
        async *[Symbol.asyncIterator]() {
          if (payload.length) yield Buffer.from(payload);
        },
      };
      void handler(req, response).catch(reject);
    });
  };
  return {
    baseUrl,
    fetch: fixtureFetch,
    observed,
    get submissions() {
      return submitted;
    },
    close: async () => {
      if (options.listen === false) return;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
