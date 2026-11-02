/**
 * OpenAI Audio Client
 *
 * Provides a dedicated OpenAI client for audio APIs (Whisper and TTS)
 * Uses OpenAI directly since OpenRouter does not support audio APIs.
 * Uses lazy import to avoid loading OpenAI SDK at module load time.
 */

import type OpenAI from "openai";

// Configuration from environment


/**
 * Get the OpenAI client for audio APIs
 * Uses lazy initialization to avoid importing OpenAI at module load time
 */
export async function getOpenAIAudioClient(): Promise<OpenAI> {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim();
  const OPENAI_AUDIO_BASE_URL = process.env.OPENAI_AUDIO_BASE_URL?.trim() || "https://api.openai.com/v1";
  if (!OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY environment variable is not set. Please set it to use audio APIs.",
    );
  }

  // Lazy import of OpenAI SDK
  const OpenAI = (await import("openai")).default;
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
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}
