/**
 * Audio input processor
 * Abstracted transcription layer - currently uses OpenAI Whisper
 * Future: Add local Whisper.cpp, Anthropic (when available)
 */

import { AudioInput, ProcessedInput, InputProcessor } from './types.js';

export type TranscriptionProvider = 'openai-whisper' | 'local-whisper';

export interface AudioProcessorConfig {
  provider?: TranscriptionProvider;
  apiKey?: string;
  model?: string;
  language?: string;
  temperature?: number;
}

export interface TranscriptionService {
  transcribe(audioBuffer: Buffer, filename?: string): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }>;
  getProvider(): TranscriptionProvider;
}

/**
 * OpenAI Whisper transcription service
 */
class OpenAIWhisperService implements TranscriptionService {
  private apiKey: string;
  private model: string;
  private language?: string;
  private temperature: number;

  constructor(config: AudioProcessorConfig) {
    if (!config.apiKey) {
      throw new Error('OpenAI API key is required for Whisper transcription');
    }
    this.apiKey = config.apiKey;
    this.model = config.model || 'whisper-1';
    this.language = config.language;
    this.temperature = config.temperature ?? 0;
  }

  async transcribe(audioBuffer: Buffer, filename?: string): Promise<{
    text: string;
    language?: string;
    duration?: number;
  }> {
    // Dynamic import of OpenAI SDK
    const { default: OpenAI, toFile } = await import('openai');
    
    const openai = new OpenAI({ apiKey: this.apiKey });
    const file = await toFile(audioBuffer, filename || 'audio.mp3');

    const response = await openai.audio.transcriptions.create({
      file,
      model: this.model,
      language: this.language,
      temperature: this.temperature,
      response_format: 'verbose_json'
    });

    return {
      text: response.text,
      language: response.language,
      duration: response.duration
    };
  }

  getProvider(): TranscriptionProvider {
    return 'openai-whisper';
  }
}

/**
 * Main audio processor with provider abstraction
 */
export class AudioInputProcessor implements InputProcessor {
  private transcriptionService: TranscriptionService;
  private provider: TranscriptionProvider;

  constructor(config: AudioProcessorConfig) {
    this.provider = config.provider || 'openai-whisper';
    this.transcriptionService = this.createTranscriptionService(config);
  }

  /**
   * Create transcription service based on provider
   */
  private createTranscriptionService(config: AudioProcessorConfig): TranscriptionService {
    switch (config.provider || 'openai-whisper') {
      case 'openai-whisper':
        return new OpenAIWhisperService(config);
      
      case 'local-whisper':
        // Phase 2: Implement local Whisper.cpp
        throw new Error('Local Whisper not implemented yet (Phase 2)');
      
      default:
        throw new Error(`Unknown transcription provider: ${config.provider}`);
    }
  }

  async process(input: AudioInput): Promise<ProcessedInput> {
    if (input.type !== 'audio') {
      throw new Error('Invalid input type. Expected "audio"');
    }

    // Validate audio data
    if (!input.data || !Buffer.isBuffer(input.data)) {
      throw new Error('Audio input data must be a Buffer');
    }

    if (input.data.length === 0) {
      throw new Error('Audio buffer cannot be empty');
    }

    const startTime = Date.now();

    try {
      // Transcribe audio
      const transcription = await this.transcriptionService.transcribe(
        input.data,
        input.filename
      );
      
      const processingTime = Date.now() - startTime;

      return {
        content: transcription.text,
        metadata: {
          source: 'audio' as const,
          processedAt: new Date().toISOString(),
          transcriptionProvider: this.provider,
          language: transcription.language,
          duration: transcription.duration,
          processingTimeMs: processingTime,
          audioSizeBytes: input.data.length,
          filename: input.filename,
          ...input.metadata
        }
      };
    } catch (error) {
      throw new Error(
        `Audio transcription failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get current provider
   */
  getProvider(): TranscriptionProvider {
    return this.provider;
  }
}
