/**
 * Core types for input processing
 */

export type InputType = 'text' | 'audio' | 'file';

export interface TextInput {
  type: 'text';
  data: string;
  metadata?: Record<string, unknown>;
}

export interface AudioInput {
  type: 'audio';
  data: Buffer;
  filename?: string;
  metadata?: Record<string, unknown>;
}

export interface FileInput {
  type: 'file';
  data: Buffer;
  filename: string;
  mimeType: string;
  metadata?: Record<string, unknown>;
}

export type Input = TextInput | AudioInput | FileInput;

export interface ProcessedInput {
  content: string;
  metadata: {
    source: InputType;
    processedAt: string;
    originalLength?: number;
    transcriptionModel?: string;
    language?: string;
    duration?: number;
    [key: string]: unknown;
  };
}

export interface InputProcessor {
  process(input: Input): Promise<ProcessedInput>;
}

