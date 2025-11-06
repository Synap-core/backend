/**
 * Text input processor
 * Handles plain text input with validation and metadata enrichment
 */

import { TextInput, ProcessedInput, InputProcessor } from './types.js';

export class TextInputProcessor implements InputProcessor {
  async process(input: TextInput): Promise<ProcessedInput> {
    if (input.type !== 'text') {
      throw new Error('Invalid input type. Expected "text"');
    }

    // Validate text content
    if (!input.data || typeof input.data !== 'string') {
      throw new Error('Text input data must be a non-empty string');
    }

    const trimmedContent = input.data.trim();

    if (trimmedContent.length === 0) {
      throw new Error('Text content cannot be empty');
    }

    // Process and return
    return {
      content: trimmedContent,
      metadata: {
        source: 'text' as const,
        processedAt: new Date().toISOString(),
        originalLength: input.data.length,
        characterCount: trimmedContent.length,
        wordCount: this.countWords(trimmedContent),
        ...input.metadata
      }
    };
  }

  private countWords(text: string): number {
    return text.split(/\s+/).filter(word => word.length > 0).length;
  }
}

