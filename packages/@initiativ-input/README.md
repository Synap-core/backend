# @initiativ/input

Input processing module for Initiativ Core. Handles text and audio input with support for transcription via OpenAI Whisper.

## Features

- ✅ Text input validation and metadata enrichment
- ✅ Audio transcription via Whisper API
- ✅ Extensible input routing system
- ✅ Type-safe TypeScript API
- ✅ Word and character counting
- ✅ Custom metadata support

## Installation

```bash
npm install @initiativ/input
```

## Usage

### Basic Text Processing

```typescript
import { InputRouter } from '@initiativ/input';

const router = new InputRouter();

const result = await router.process({
  type: 'text',
  data: 'Hello, world!'
});

console.log(result.content); // "Hello, world!"
console.log(result.metadata.wordCount); // 2
```

### Audio Transcription

```typescript
import { InputRouter } from '@initiativ/input';
import fs from 'fs';

const router = new InputRouter({
  openaiApiKey: process.env.OPENAI_API_KEY
});

const audioBuffer = fs.readFileSync('./recording.mp3');

const result = await router.process({
  type: 'audio',
  data: audioBuffer,
  filename: 'recording.mp3'
});

console.log(result.content); // Transcribed text
console.log(result.metadata.language); // Detected language
console.log(result.metadata.duration); // Audio duration in seconds
```

### Custom Metadata

```typescript
const result = await router.process({
  type: 'text',
  data: 'My note',
  metadata: {
    userId: '123',
    tags: ['important']
  }
});

console.log(result.metadata.userId); // '123'
console.log(result.metadata.tags); // ['important']
```

## API

### InputRouter

Main class for routing inputs to appropriate processors.

#### Constructor

```typescript
new InputRouter(config?: InputRouterConfig)
```

**Config Options:**
- `openaiApiKey?: string` - OpenAI API key for audio transcription
- `whisperModel?: string` - Whisper model to use (default: 'whisper-1')
- `whisperLanguage?: string` - Language hint for transcription

#### Methods

**`process(input: Input): Promise<ProcessedInput>`**

Process an input and return the result with metadata.

**`hasProcessor(type: InputType): boolean`**

Check if a processor is available for the given type.

**`getAvailableTypes(): InputType[]`**

Get list of available input types.

**`register(type: InputType, processor: InputProcessor): void`**

Register a custom processor.

### Types

#### Input Types

```typescript
type InputType = 'text' | 'audio' | 'file';

interface TextInput {
  type: 'text';
  data: string;
  metadata?: Record<string, unknown>;
}

interface AudioInput {
  type: 'audio';
  data: Buffer;
  filename?: string;
  metadata?: Record<string, unknown>;
}
```

#### Output Type

```typescript
interface ProcessedInput {
  content: string;
  metadata: {
    source: InputType;
    processedAt: string;
    originalLength?: number;
    transcriptionModel?: string;
    language?: string;
    duration?: number;
    wordCount?: number;
    characterCount?: number;
    [key: string]: unknown;
  };
}
```

## Error Handling

All processors throw descriptive errors:

```typescript
try {
  await router.process({ type: 'text', data: '' });
} catch (error) {
  console.error(error.message); // "Text content cannot be empty"
}
```

## Testing

```bash
npm test
```

## License

MIT

