/**
 * Input router
 * Routes input to appropriate processor based on type
 */

import { Input, ProcessedInput, InputProcessor, InputType } from './types.js';
import { TextInputProcessor } from './text.js';
import { AudioInputProcessor, AudioProcessorConfig } from './audio.js';

export interface InputRouterConfig {
  // Audio transcription config
  transcriptionProvider?: 'openai-whisper' | 'local-whisper';
  transcriptionApiKey?: string;
  transcriptionModel?: string;
  transcriptionLanguage?: string;
}

export class InputRouter {
  private processors: Map<InputType, InputProcessor>;

  constructor(config?: InputRouterConfig) {
    this.processors = new Map();

    // Register text processor (always available)
    this.processors.set('text', new TextInputProcessor());

    // Register audio processor if configured
    if (config?.transcriptionApiKey || config?.transcriptionProvider === 'local-whisper') {
      const audioConfig: AudioProcessorConfig = {
        provider: config.transcriptionProvider,
        apiKey: config.transcriptionApiKey,
        model: config.transcriptionModel,
        language: config.transcriptionLanguage
      };
      this.processors.set('audio', new AudioInputProcessor(audioConfig));
    }
  }

  /**
   * Register a custom processor for a specific input type
   */
  register(type: InputType, processor: InputProcessor): void {
    this.processors.set(type, processor);
  }

  /**
   * Process input by routing to appropriate processor
   */
  async process(input: Input): Promise<ProcessedInput> {
    const processor = this.processors.get(input.type);

    if (!processor) {
      throw new Error(
        `No processor registered for input type: ${input.type}. ` +
        `Available types: ${Array.from(this.processors.keys()).join(', ')}`
      );
    }

    try {
      return await processor.process(input);
    } catch (error) {
      throw new Error(
        `Failed to process ${input.type} input: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Check if a processor is available for a given input type
   */
  hasProcessor(type: InputType): boolean {
    return this.processors.has(type);
  }

  /**
   * Get list of available input types
   */
  getAvailableTypes(): InputType[] {
    return Array.from(this.processors.keys());
  }
}

