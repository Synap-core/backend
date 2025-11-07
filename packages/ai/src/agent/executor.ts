import type { AgentPlanSummary, ActionExecutionLog } from './types.js';
import type { AgentToolContext } from '../tools/types.js';
import { executeTool } from '../tools/index.js';

export interface ExecutionInput {
  userId: string;
  threadId: string;
  plan: AgentPlanSummary;
}

export interface ExecutionOutput {
  logs: ActionExecutionLog[];
  summaries: string[];
}

const createToolContext = (input: ExecutionInput): AgentToolContext => ({
  userId: input.userId,
  threadId: input.threadId,
});

const successSummary = (description: string) =>
  `✅ ${description}`;

const failureSummary = (description: string, errorMessage: string) =>
  `⚠️ ${description} — ${errorMessage}`;

export const executePlan = async (input: ExecutionInput): Promise<ExecutionOutput> => {
  if (input.plan.actions.length === 0) {
    return {
      logs: [],
      summaries: ['ℹ️ Aucun outil nécessaire pour cette étape.'],
    };
  }

  const context = createToolContext(input);
  const logs: ActionExecutionLog[] = [];
  const summaries: string[] = [];

  for (const action of input.plan.actions) {
    const execution = await executeTool(action.tool, action.params, context);

    if (!execution.success || !execution.result) {
      const errorMessage = execution.error ?? `Tool "${action.tool}" failed.`;
      summaries.push(failureSummary(action.justification ?? action.tool, errorMessage));
      logs.push({
        tool: action.tool,
        params: action.params,
        status: 'error',
        errorMessage,
      });
      continue;
    }

    const result = execution.result;

    if (!result.success) {
      const errorMessage = 'Tool reported unsuccessful execution.';
      summaries.push(failureSummary(action.justification ?? action.tool, errorMessage));
      logs.push({
        tool: action.tool,
        params: action.params,
        status: 'error',
        errorMessage,
      });
      continue;
    }

    logs.push({
      tool: action.tool,
      params: action.params,
      status: 'success',
      result: result.result,
    });

    const summaryDescription =
      action.justification ?? result.metadata.logs?.[0] ?? action.tool;

    summaries.push(successSummary(summaryDescription));
  }

  return {
    logs,
    summaries,
  };
};

