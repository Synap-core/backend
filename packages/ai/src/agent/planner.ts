import { z } from 'zod';
import { generateObject } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import type { AgentActionPlan, AgentContext, AgentIntent, PlannedAction } from './types.js';
import { getToolSchemasForPlanner } from '../tools/index.js';
import { getAnthropicModel } from './config-helper.js';

const plannerSystemPrompt = [
  'You are Synap\'s orchestration planner. Your job is to design a concise sequence of tool calls',
  'that will help the user achieve their goal. You are operating inside a structured agent.',
  '',
  'Workflow:',
  '1. Review the user intent classification and the latest user message.',
  '2. Analyse the provided context (search results, recent conversation, memory facts).',
  '3. Outline a plan comprised of tool invocations that progress the user towards their outcome.',
  '4. If action is not required, return an empty plan with reasoning.',
  '',
  'Rules:',
  '- Use only the tools listed in the `availableTools` section.',
  '- Each plan entry must invoke exactly one tool with the required parameters.',
  '- When a tool requires parameters, set them explicitly. Do not add extra properties.',
  '- If you learn a durable preference or fact about the user, schedule the `saveFact` tool.',
  '- If the user intent is unclear or follow-up questions are needed, return an empty plan.',
  '- Plans should be short (1-3 steps). Optimise for minimal actions.',
  '- If the best response is conversational (no tool), return `actions: []` with reasoning explaining why.',
].join('\n');

const planSchema = z.object({
  reasoning: z
    .string()
    .min(1)
    .describe('Short justification of the proposed plan.'),
  actions: z
    .array(
      z.object({
        tool: z.string(),
        params: z.record(z.unknown()),
        description: z
          .string()
          .min(1)
          .describe('User-facing explanation of the step.'),
      })
    )
    .max(5),
});

type PlanPayload = z.infer<typeof planSchema>;

const buildPlannerInput = (args: {
  intent: AgentIntent;
  userMessage: string;
  context: AgentContext | undefined;
}) =>
  JSON.stringify(
    {
      intent: args.intent,
      userMessage: args.userMessage,
      context: args.context ?? {
        semanticResults: [],
        recentMessages: [],
        memoryFacts: [],
      },
      availableTools: getToolSchemasForPlanner(),
    },
    null,
    2
  );

const toPlannedAction = (action: PlanPayload['actions'][number]): PlannedAction => ({
  tool: action.tool,
  params: action.params,
  justification: action.description,
});

export interface PlannerInput {
  intent: AgentIntent;
  userMessage: string;
  context: AgentContext | undefined;
}

export interface PlannerOutput extends AgentActionPlan {
  reasoning: string;
}

export const planActions = async (input: PlannerInput): Promise<PlannerOutput> => {
  try {
    const modelName = getAnthropicModel('planner');
    
    const result = await generateObject({
      model: anthropic(modelName),
      schema: planSchema,
      prompt: `${plannerSystemPrompt}\n\n${buildPlannerInput(input)}`,
      temperature: 0.3,
      maxTokens: 512,
    });

    return {
      reasoning: result.object.reasoning,
      actions: result.object.actions.map(toPlannedAction),
    };
  } catch (error) {
    console.error('❌ Planner failed to produce a valid plan:', error);
    return {
      reasoning: error instanceof Error ? error.message : 'Planner failed to produce a valid plan.',
      actions: [],
    };
  }
};

