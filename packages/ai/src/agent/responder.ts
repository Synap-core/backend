import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { createChatModel } from '../providers/chat.js';
import { messageContentToString } from '../providers/utils.js';
import type { ActionExecutionLog, AgentPlanSummary } from './types.js';

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
  '',
  'Return plain text. No markdown fences.',
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

const parseResponse = (rawText: string): string => {
  try {
    const parsed = JSON.parse(rawText);
    const result = responseSchema.parse(parsed);
    return result.message;
  } catch {
    return rawText.trim();
  }
};

export const generateFinalResponse = async (input: ResponseInput): Promise<string> => {
  const model = createChatModel({
    purpose: 'responder',
    maxTokens: 512,
    temperature: 0.4,
  });

  const response = await model.invoke([
    new SystemMessage(responseSystemPrompt),
    new HumanMessage(buildResponderPayload(input)),
  ]);

  const rawText = messageContentToString(response);
  return parseResponse(rawText);
};













