/** Non-streaming speech adapters. Explicit connection snapshots are shared by
 * production calls and configuration tests; this module never writes env. */
export type AudioProvider = 'openai' | 'bailian';
export type AudioConfiguration = {
  provider: AudioProvider;
  baseUrl: string;
  apiKey: string;
  ttsModel: string;
  voice: string;
  asrModel: string;
};
export class MediaServiceError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'MediaServiceError';
  }
}
export function resolveAudioConfiguration(
  env: Record<string, string | undefined> = process.env,
): AudioConfiguration {
  const provider = env.AUDIO_PROVIDER?.trim() || 'openai';
  if (provider !== 'openai' && provider !== 'bailian')
    throw new MediaServiceError('audio_provider_invalid');
  const baseUrl = (
    env.AUDIO_BASE_URL?.trim() ||
    (provider === 'openai' ? env.OPENAI_AUDIO_BASE_URL?.trim() : undefined) ||
    (provider === 'bailian'
      ? 'https://dashscope.aliyuncs.com/api/v1'
      : 'https://api.openai.com/v1')
  ).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new MediaServiceError('media_service_url_invalid');
  if (provider === 'bailian' && url.pathname.includes('compatible-mode'))
    throw new MediaServiceError('audio_bailian_native_base_required');
  return {
    provider,
    baseUrl,
    apiKey:
      'AUDIO_API_KEY' in env
        ? env.AUDIO_API_KEY?.trim() || ''
        : provider === 'openai'
          ? env.OPENAI_API_KEY?.trim() || ''
          : '',
    ttsModel:
      env.AUDIO_TTS_MODEL?.trim() ||
      (provider === 'bailian' ? 'qwen-audio-3.1-tts-flash' : 'tts-1'),
    voice:
      env.AUDIO_TTS_VOICE?.trim() ||
      (provider === 'bailian' ? 'longanhuan_v3.1' : 'alloy'),
    asrModel:
      env.AUDIO_ASR_MODEL?.trim() ||
      (provider === 'bailian' ? 'qwen3-asr-flash' : 'whisper-1'),
  };
}
export async function readLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new MediaServiceError('media_response_too_large');
  }
  if (!response.body) throw new MediaServiceError('media_response_empty');
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes)
        throw new MediaServiceError('media_response_too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export function audioMime(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) =>
    new TextDecoder().decode(bytes.slice(start, end));
  if (bytes.length < 48) throw new MediaServiceError('audio_bytes_invalid');
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'audio/wav';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224))
    return 'audio/mpeg';
  if (ascii(0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(4, 8) === 'ftyp') return 'audio/mp4';
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return 'audio/webm';
  throw new MediaServiceError('audio_bytes_invalid');
}
export function validateMediaUrl(value: string, baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaServiceError('media_url_untrusted');
  }
  const base = new URL(baseUrl),
    aliyunHost =
      url.hostname.endsWith('.aliyuncs.com') ||
      url.hostname.endsWith('.alicdn.com');
  // DashScope documents signed OSS URLs with http. OSS signatures survive an
  // HTTPS upgrade; never download generated cloud media over plaintext.
  if (url.protocol === 'http:' && aliyunHost) url.protocol = 'https:';
  const official = url.protocol === 'https:' && aliyunHost;
  if (
    url.username ||
    url.password ||
    !['http:', 'https:'].includes(url.protocol) ||
    (!official && url.origin !== base.origin)
  )
    throw new MediaServiceError('media_url_untrusted');
  return url;
}
export async function downloadProviderMedia(
  value: string,
  baseUrl: string,
  signal?: AbortSignal,
  maxBytes = 8 * 1024 * 1024,
  fetcher: typeof fetch = fetch,
) {
  const url = validateMediaUrl(value, baseUrl),
    response = await fetcher(url, {
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
    });
  if (!response.ok)
    throw new MediaServiceError('media_download_http_error', response.status);
  return {
    bytes: await readLimited(response, maxBytes),
    contentType: response.headers.get('content-type') || '',
  };
}
export class SpeechService {
  constructor(
    readonly config: AudioConfiguration,
    private fetcher: typeof fetch = fetch,
  ) {}
  private async send(
    path: string,
    body: BodyInit,
    json = true,
    signal?: AbortSignal,
  ) {
    if (!this.config.apiKey) throw new MediaServiceError('audio_key_required');
    signal?.throwIfAborted();
    const response = await this.fetcher(this.config.baseUrl + path, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + this.config.apiKey,
        ...(json ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
      redirect: 'error',
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
        : AbortSignal.timeout(60000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new MediaServiceError('audio_provider_http_error', response.status);
    }
    return response;
  }
  async synthesize(text: string, signal?: AbortSignal) {
    if (!text.trim() || text.length > 4000)
      throw new MediaServiceError('audio_text_invalid');
    const { provider, ttsModel, voice } = this.config;
    let response: Response;
    if (provider === 'openai') {
      response = await this.send(
        '/audio/speech',
        JSON.stringify({
          model: ttsModel,
          voice,
          input: text,
          response_format: 'wav',
        }),
        true,
        signal,
      );
      const bytes = await readLimited(response, 8 * 1024 * 1024);
      signal?.throwIfAborted();
      return { bytes, mimeType: audioMime(bytes), model: ttsModel };
    }
    const legacy = /^qwen(?:3)?-tts(?:-|$)/.test(ttsModel);
    response = await this.send(
      legacy
        ? '/services/aigc/multimodal-generation/generation'
        : '/services/audio/tts/SpeechSynthesizer',
      JSON.stringify(
        legacy
          ? { model: ttsModel, input: { text, voice, language_type: 'Auto' } }
          : {
              model: ttsModel,
              input: { text, voice, format: 'wav', sample_rate: 24000 },
            },
      ),
      true,
      signal,
    );
    let data: any;
    try {
      data = JSON.parse(
        new TextDecoder().decode(await readLimited(response, 512 * 1024)),
      );
    } catch (error) {
      if (error instanceof MediaServiceError) throw error;
      throw new MediaServiceError('audio_response_invalid');
    }
    if (
      data.code ||
      (!legacy && data.output?.finish_reason !== 'stop') ||
      !data.output?.audio?.url
    )
      throw new MediaServiceError('audio_synthesis_unconfirmed');
    const media = await downloadProviderMedia(
      data.output.audio.url,
      this.config.baseUrl,
      signal,
      8 * 1024 * 1024,
      this.fetcher,
    );
    signal?.throwIfAborted();
    return {
      bytes: media.bytes,
      mimeType: audioMime(media.bytes),
      model: ttsModel,
    };
  }
  async transcribe(bytes: Uint8Array, signal?: AbortSignal) {
    if (bytes.byteLength > 8 * 1024 * 1024)
      throw new MediaServiceError('audio_input_too_large');
    const mime = audioMime(bytes),
      { provider, asrModel } = this.config;
    let response: Response;
    if (provider === 'openai') {
      const form = new FormData();
      form.set('model', asrModel);
      form.set(
        'file',
        new Blob([Uint8Array.from(bytes)], { type: mime }),
        'recording.' +
          {
            'audio/wav': 'wav',
            'audio/mpeg': 'mp3',
            'audio/mp4': 'm4a',
            'audio/ogg': 'ogg',
            'audio/flac': 'flac',
            'audio/webm': 'webm',
          }[mime],
      );
      response = await this.send('/audio/transcriptions', form, false, signal);
    } else {
      response = await this.send(
        '/services/aigc/multimodal-generation/generation',
        JSON.stringify({
          model: asrModel,
          input: {
            messages: [
              {
                role: 'user',
                content: [
                  {
                    audio: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
                  },
                ],
              },
            ],
          },
          parameters: { asr_options: { enable_itn: true } },
        }),
        true,
        signal,
      );
    }
    let data: any;
    try {
      data = JSON.parse(
        new TextDecoder().decode(await readLimited(response, 512 * 1024)),
      );
    } catch {
      throw new MediaServiceError('audio_response_invalid');
    }
    const choice = data.output?.choices?.[0];
    if (
      data.code ||
      (provider === 'bailian' && choice?.finish_reason !== 'stop')
    )
      throw new MediaServiceError('audio_transcription_unconfirmed');
    const text =
      provider === 'openai'
        ? data.text
        : Array.isArray(choice?.message?.content)
          ? choice.message.content
              .map((part: any) =>
                typeof part.text === 'string' ? part.text : '',
              )
              .join('')
          : choice?.message?.content;
    if (typeof text !== 'string' || !text.trim() || text.length > 64000)
      throw new MediaServiceError('audio_transcription_empty');
    signal?.throwIfAborted();
    return { text: text.trim(), model: asrModel };
  }
}
