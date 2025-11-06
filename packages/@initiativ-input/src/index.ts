/**
 * @initiativ/input
 * Input processing module for Initiativ Core
 * 
 * Handles text and audio input processing with support for:
 * - Text validation and metadata enrichment
 * - Audio transcription via Whisper API
 * - Extensible input routing
 */

// Export types
export type {
  InputType,
  Input,
  TextInput,
  AudioInput,
  FileInput,
  ProcessedInput,
  InputProcessor
} from './types.js';

// Export processors
export { TextInputProcessor } from './text.js';
export { AudioInputProcessor } from './audio.js';
export type { AudioProcessorConfig } from './audio.js';

// Export router
export { InputRouter } from './router.js';
export type { InputRouterConfig } from './router.js';

