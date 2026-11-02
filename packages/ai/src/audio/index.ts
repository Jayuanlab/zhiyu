export * from './openai-audio-client';
export {
  SpeechService,
  resolveAudioConfiguration,
  MediaServiceError,
  audioMime,
  readLimited,
  downloadProviderMedia,
  validateMediaUrl,
} from './speech-service';
export type { AudioConfiguration, AudioProvider } from './speech-service';
