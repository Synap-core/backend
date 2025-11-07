import Anthropic from '@anthropic-ai/sdk';

let anthropicClient: Anthropic | null = null;

const missingKeyError =
  'ANTHROPIC_API_KEY environment variable is required for Synap agent orchestration.';

export const getAnthropicClient = (): Anthropic => {
  if (anthropicClient) {
    return anthropicClient;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error(missingKeyError);
  }

  anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
};



