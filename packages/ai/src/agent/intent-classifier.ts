import { z } from 'zod';
import type { AgentIntent, IntentAnalysis } from './types.js';
import { getAnthropicClient } from './anthropic-client.js';

const classificationSchema = z.object({
  intent: z.enum(['capture', 'command', 'query', 'unknown']),
  confidence: z.number().min(0).max(1),
  reasoning: z
    .string()
    .min(1)
    .describe('Succinct justification for the chosen intent.'),
  needsFollowUp: z
    .boolean()
    .describe('Whether the assistant should ask clarifying questions.'),
});

type ClassificationPayload = z.infer<typeof classificationSchema>;

const classificationSystemPrompt = [
  'You are Synap\'s intent classifier. Your job is to analyse a single user message',
  'from a productivity assistant and select the most appropriate high-level intent.',
  '',
  'Available intents:',
  '- capture: the user wants to store or remember information (notes, tasks, ideas).',
  '- command: the user is asking to perform an action or modify existing state.',
  '- query: the user is requesting information, insights, or asking a question.',
  '- unknown: the message is ambiguous or does not fit the above categories.',
  '',
  'Return a strict JSON object with keys intent, confidence, reasoning, needsFollowUp.',
  'Do not include any preamble or markdown fences. Confidence must be between 0 and 1.',
].join('\n');

const userPrompt = (message: string): string =>
  [
    'Classify the following user message:',
    '---',
    message,
    '---',
  ].join('\n');

const safeJsonExtract = (raw: string): string | null => {
  const startIndex = raw.indexOf('{');
  const endIndex = raw.lastIndexOf('}');

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  return raw.slice(startIndex, endIndex + 1);
};

const toIntentAnalysis = (payload: ClassificationPayload): IntentAnalysis => ({
  label: payload.intent satisfies AgentIntent,
  confidence: payload.confidence,
  reasoning: payload.reasoning,
  needsFollowUp: payload.needsFollowUp,
});

export const classifyIntent = async (message: string): Promise<IntentAnalysis> => {
  const client = getAnthropicClient();

  const response = await client.messages.create({
    model: 'claude-3-haiku-20240307',
    temperature: 0,
    max_tokens: 256,
    system: classificationSystemPrompt,
    messages: [
      {
        role: 'user',
        content: userPrompt(message),
      },
    ],
  });

  const textSegments = response.content
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''));

  const rawText = textSegments.join('\n').trim();
  const jsonCandidate = safeJsonExtract(rawText);

  if (!jsonCandidate) {
    return {
      label: 'unknown',
      confidence: 0,
      reasoning: 'Intent classifier returned no JSON payload.',
      needsFollowUp: true,
    };
  }

  try {
    const parsed = JSON.parse(jsonCandidate);
    const result = classificationSchema.parse(parsed);
    return toIntentAnalysis(result);
  } catch (error) {
    console.error('❌ Failed to parse intent classification response:', error);
    return {
      label: 'unknown',
      confidence: 0,
      reasoning: 'Intent classifier response could not be parsed.',
      needsFollowUp: true,
    };
  }
};



