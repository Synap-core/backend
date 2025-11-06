import { TextInputProcessor } from '../src/text.js';
import { TextInput } from '../src/types.js';

describe('TextInputProcessor', () => {
  let processor: TextInputProcessor;

  beforeEach(() => {
    processor = new TextInputProcessor();
  });

  describe('process', () => {
    it('should process valid text input', async () => {
      const input: TextInput = {
        type: 'text',
        data: 'Hello, world!'
      };

      const result = await processor.process(input);

      expect(result.content).toBe('Hello, world!');
      expect(result.metadata.source).toBe('text');
      expect(result.metadata.characterCount).toBe(13);
      expect(result.metadata.wordCount).toBe(2);
      expect(result.metadata.processedAt).toBeDefined();
    });

    it('should trim whitespace from text', async () => {
      const input: TextInput = {
        type: 'text',
        data: '  \n  Hello, world!  \n  '
      };

      const result = await processor.process(input);

      expect(result.content).toBe('Hello, world!');
    });

    it('should preserve custom metadata', async () => {
      const input: TextInput = {
        type: 'text',
        data: 'Test',
        metadata: { customField: 'value' }
      };

      const result = await processor.process(input);

      expect(result.metadata.customField).toBe('value');
    });

    it('should throw error for wrong input type', async () => {
      const input = {
        type: 'audio',
        data: 'test'
      } as never;

      await expect(processor.process(input)).rejects.toThrow('Invalid input type');
    });

    it('should throw error for empty text', async () => {
      const input: TextInput = {
        type: 'text',
        data: '   '
      };

      await expect(processor.process(input)).rejects.toThrow('cannot be empty');
    });

    it('should throw error for non-string data', async () => {
      const input = {
        type: 'text',
        data: 123
      } as never;

      await expect(processor.process(input)).rejects.toThrow('must be a non-empty string');
    });

    it('should count words correctly', async () => {
      const input: TextInput = {
        type: 'text',
        data: 'One two three four five'
      };

      const result = await processor.process(input);

      expect(result.metadata.wordCount).toBe(5);
    });

    it('should handle single word', async () => {
      const input: TextInput = {
        type: 'text',
        data: 'Word'
      };

      const result = await processor.process(input);

      expect(result.metadata.wordCount).toBe(1);
      expect(result.metadata.characterCount).toBe(4);
    });

    it('should handle text with multiple spaces', async () => {
      const input: TextInput = {
        type: 'text',
        data: 'Hello    world    test'
      };

      const result = await processor.process(input);

      expect(result.metadata.wordCount).toBe(3);
    });
  });
});

