import { z } from 'zod';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { ActionExecutionLog, AgentPlanSummary } from './types.js';
import { getAnthropicModel } from './config-helper.js';

const responseSystemPrompt = [
  'You are Synap, an intelligent thought partner.',
  'Compose a concise, friendly response for the user based on the orchestration results.',
  '',
  'Guidelines:',
  '- Summarise what was understood from the user.',
  '- Mention the actions executed, highlighting successes and failures.',
  '- If no action was taken, explain why.',
  '- Offer a clear next step or follow-up question when helpful.',
  '- Keep tone supportive, professional, and focused on productivity.',
].join('\n');

const responseSchema = z.object({
  message: z
    .string()
    .min(1)
    .describe('Natural language response to the user.'),
});

interface ResponseInput {
  userMessage: string;
  plan: AgentPlanSummary | undefined;
  executionLogs: ActionExecutionLog[];
  executionSummaries: string[];
}

const buildResponderPayload = (input: ResponseInput) =>
  JSON.stringify(
    {
      userMessage: input.userMessage,
      reasoning: input.plan?.reasoning ?? 'No plan available.',
      plannedActions: input.plan?.actions ?? [],
      executionSummaries: input.executionSummaries,
      executionLogs: input.executionLogs,
    },
    null,
    2
  );

export const generateFinalResponse = async (input: ResponseInput): Promise<string> => {
  try {
    const modelName = getAnthropicModel('responder');
    
    const result = await generateObject({
      model: anthropic(modelName),
      schema: responseSchema,
      prompt: `${responseSystemPrompt}\n\n${buildResponderPayload(input)}`,
      temperature: 0.4,
      maxTokens: 512,
    });

    return result.object.message;
  } catch (error) {
    console.error('❌ Failed to generate final response:', error);
    // Fallback response
    return 'Je n\'ai pas pu générer de réponse pour le moment. Réessaie dans quelques instants.';
  }
};













