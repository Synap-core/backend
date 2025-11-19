import { z } from 'zod';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { AgentIntent, IntentAnalysis } from './types.js';
import { getAnthropicModel } from './config-helper.js';

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

const toIntentAnalysis = (payload: ClassificationPayload): IntentAnalysis => ({
  label: payload.intent satisfies AgentIntent,
  confidence: payload.confidence,
  reasoning: payload.reasoning,
  needsFollowUp: payload.needsFollowUp,
});

export const classifyIntent = async (message: string): Promise<IntentAnalysis> => {
  try {
    const modelName = getAnthropicModel('intent');
    
    const result = await generateObject({
      model: anthropic(modelName),
      schema: classificationSchema,
      prompt: `${classificationSystemPrompt}\n\n${userPrompt(message)}`,
      temperature: 0,
      maxTokens: 256,
    });

    return toIntentAnalysis(result.object);
  } catch (error) {
    console.error('❌ Failed to classify intent:', error);
    return {
      label: 'unknown',
      confidence: 0,
      reasoning: error instanceof Error ? error.message : 'Intent classification failed.',
      needsFollowUp: true,
    };
  }
};













