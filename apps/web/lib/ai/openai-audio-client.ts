/**
 * OpenAI Audio Client
 *
 * Provides a dedicated OpenAI client for audio APIs (Whisper and TTS)
 * Uses OpenAI directly since OpenRouter does not support audio APIs.
 */

import OpenAI from "openai";
import {
  resolveAudioConfiguration,
  MediaServiceError,
} from "@openzhiyu/ai/audio";

/**
 * Get the OpenAI client for audio APIs
 * Uses lazy initialization to avoid importing OpenAI at module load time
 */
export function getOpenAIAudioClient(): OpenAI {
  const connection = resolveAudioConfiguration();
  if (connection.provider !== "openai")
    throw new MediaServiceError("bailian_use_speech_service");
  const OPENAI_API_KEY = connection.apiKey;
  const OPENAI_AUDIO_BASE_URL = connection.baseUrl;
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. Please set it to use audio APIs.",
    );
  }

  return new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_AUDIO_BASE_URL,
    timeout: 600_000, // 10 minutes for audio processing
  });
}

/**
 * Check if audio API is configured
 */
export function isAudioAPIConfigured(): boolean {
  return Boolean(resolveAudioConfiguration().apiKey);
}
