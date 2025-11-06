/**
 * Test setup and utilities
 */

export const TEST_CONFIG = {
  dataPath: './test-data',
  userId: 'test-user',
  embeddingsProvider: 'openai' as const,
  embeddingsApiKey: process.env.OPENAI_API_KEY || 'mock-key',
  agentApiKey: process.env.ANTHROPIC_API_KEY || 'mock-key',
  agentModel: 'claude-3-haiku-20240307',
  autoCommitEnabled: false
};

export function shouldSkipApiTests(): boolean {
  return !process.env.OPENAI_API_KEY || !process.env.ANTHROPIC_API_KEY;
}

export function skipMessage(feature: string): string {
  return `Skipping ${feature} test (no API keys configured)`;
}

