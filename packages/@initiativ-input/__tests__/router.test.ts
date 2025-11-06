import { InputRouter } from '../src/router.js';
import { TextInput, AudioInput, Input } from '../src/types.js';

describe('InputRouter', () => {
  describe('without API key', () => {
    let router: InputRouter;

    beforeEach(() => {
      router = new InputRouter();
    });

    it('should process text input', async () => {
      const input: TextInput = {
        type: 'text',
        data: 'Test content'
      };

      const result = await router.process(input);

      expect(result.content).toBe('Test content');
      expect(result.metadata.source).toBe('text');
    });

    it('should have text processor available', () => {
      expect(router.hasProcessor('text')).toBe(true);
    });

    it('should not have audio processor without API key', () => {
      expect(router.hasProcessor('audio')).toBe(false);
    });

    it('should throw error for audio input without API key', async () => {
      const input: AudioInput = {
        type: 'audio',
        data: Buffer.from('fake audio')
      };

      await expect(router.process(input)).rejects.toThrow(
        'No processor registered for input type: audio'
      );
    });

    it('should list available types', () => {
      const types = router.getAvailableTypes();
      expect(types).toContain('text');
      expect(types).not.toContain('audio');
    });
  });

  describe('with API key', () => {
    let router: InputRouter;

    beforeEach(() => {
      router = new InputRouter({
        openaiApiKey: 'sk-test-key',
        whisperModel: 'whisper-1',
        whisperLanguage: 'en'
      });
    });

    it('should have both text and audio processors', () => {
      expect(router.hasProcessor('text')).toBe(true);
      expect(router.hasProcessor('audio')).toBe(true);
    });

    it('should list all available types', () => {
      const types = router.getAvailableTypes();
      expect(types).toContain('text');
      expect(types).toContain('audio');
    });
  });

  describe('error handling', () => {
    let router: InputRouter;

    beforeEach(() => {
      router = new InputRouter();
    });

    it('should wrap processing errors', async () => {
      const input: TextInput = {
        type: 'text',
        data: ''  // Empty will cause error
      };

      await expect(router.process(input)).rejects.toThrow('Failed to process text input');
    });

    it('should throw error for unknown input type', async () => {
      const input = {
        type: 'unknown',
        data: 'test'
      } as unknown as Input;

      await expect(router.process(input)).rejects.toThrow(
        'No processor registered for input type: unknown'
      );
    });
  });
});

