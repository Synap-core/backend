import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { createLogger } from '@synap/core';
import type {
  ActionExecutionLog,
  AgentContext,
  AgentIntent,
  AgentPlanSummary,
  IntentAnalysis,
  SemanticSearchResult,
  MemoryFact,
} from './types.js';
import { classifyIntent } from './intent-classifier.js';
import { planActions } from './planner.js';
import { executePlan } from './executor.js';
import { generateFinalResponse } from './responder.js';
import { semanticSearchTool } from '../tools/semantic-search-tool.js';
import { knowledgeService } from '@synap/domain';

const agentLogger = createLogger({ module: 'synap-agent' });

const AgentState = Annotation.Root({
  userId: Annotation<string>(),
  threadId: Annotation<string>(),
  userMessage: Annotation<string>(),
  intent: Annotation<AgentIntent | undefined>(),
  intentAnalysis: Annotation<IntentAnalysis | undefined>(),
  context: Annotation<AgentContext | undefined>(),
  plan: Annotation<AgentPlanSummary | undefined>(),
  execution: Annotation<ActionExecutionLog[] | undefined>(),
  executionSummaries: Annotation<string[] | undefined>(),
  response: Annotation<string | undefined>(),
});

type AgentStateValues = typeof AgentState.State;
type AgentUpdate = typeof AgentState.Update;

const unknownIntentAnalysis: IntentAnalysis = {
  label: 'unknown',
  confidence: 0,
  reasoning: 'Intent classifier did not produce a definitive result.',
  needsFollowUp: true,
};

export const parseIntentNode = async (state: AgentStateValues): Promise<AgentUpdate> => {
  const log = agentLogger.child({
    node: 'parse_intent',
    threadId: state.threadId,
    userId: state.userId,
  });

  log.debug({ messagePreview: state.userMessage.slice(0, 120) }, 'Parsing intent');

  try {
    const analysis = await classifyIntent(state.userMessage);
    log.info({ intent: analysis.label, confidence: analysis.confidence }, 'Intent classified');
    return {
      intent: analysis.label,
      intentAnalysis: analysis,
    };
  } catch (error) {
    log.error({ err: error }, 'Intent classification failed');
    return {
      intent: 'unknown',
      intentAnalysis: unknownIntentAnalysis,
    };
  }
};

export const gatherContextNode = async (
  state: AgentStateValues
): Promise<AgentUpdate> => {
  const log = agentLogger.child({
    node: 'gather_context',
    threadId: state.threadId,
    userId: state.userId,
  });

  log.debug('Gathering semantic context and memory facts');

  const trimmedMessage = state.userMessage.trim();
  let semanticResults: SemanticSearchResult[] = [];
  let memoryFacts: MemoryFact[] = [];

  if (trimmedMessage.length > 0) {
    try {
      const semanticSearch = await semanticSearchTool.execute(
        {
          query: trimmedMessage,
          limit: 5,
        },
        {
          userId: state.userId,
          threadId: state.threadId,
        }
      );

      semanticResults = semanticSearch.result.results;
      log.debug({ results: semanticResults.length }, 'Semantic search completed');
    } catch (error) {
      log.error({ err: error }, 'Semantic search tool failed');
    }

    try {
      const facts = await knowledgeService.searchFacts({
        userId: state.userId,
        query: trimmedMessage,
        limit: 5,
      });

      memoryFacts = facts.map((fact) => ({
        factId: fact.id,
        fact: fact.fact,
        confidence: fact.confidence,
        sourceEntityId: fact.sourceEntityId,
        sourceMessageId: fact.sourceMessageId,
      }));
      log.debug({ facts: memoryFacts.length }, 'Memory facts retrieved');
    } catch (error) {
      log.error({ err: error }, 'Knowledge fact search failed');
    }
  }

  return {
    context: {
      semanticResults,
      recentMessages: [],
      memoryFacts,
    },
  };
};

export const planActionsNode = async (state: AgentStateValues): Promise<AgentUpdate> => {
  const log = agentLogger.child({
    node: 'plan_actions',
    threadId: state.threadId,
    userId: state.userId,
  });

  log.debug({ intent: state.intent }, 'Planning actions');

  if (!state.intent) {
    log.warn('Skipping planning: no intent detected');
    return {
      plan: {
        reasoning: 'No intent detected. Planner skipped.',
        actions: [],
      },
    };
  }

  try {
    const plannerOutput = await planActions({
      intent: state.intent,
      userMessage: state.userMessage,
      context: state.context,
    });

    log.info({ actionCount: plannerOutput.actions.length }, 'Planner produced actions');
    return {
      plan: plannerOutput,
    };
  } catch (error) {
    log.error({ err: error }, 'Planner failed');
    return {
      plan: {
        reasoning: 'Planner failed to generate a plan.',
        actions: [],
      },
    };
  }
};

export const executeActionsNode = async (state: AgentStateValues): Promise<AgentUpdate> => {
  const log = agentLogger.child({
    node: 'execute_actions',
    threadId: state.threadId,
    userId: state.userId,
  });

  log.debug({ actionCount: state.plan?.actions.length ?? 0 }, 'Executing planned actions');

  if (!state.plan) {
    return {
      execution: [],
      executionSummaries: ['ℹ️ Aucun plan à exécuter.'],
    };
  }

  try {
    const executionResult = await executePlan({
      userId: state.userId,
      threadId: state.threadId,
      plan: state.plan,
    });

    log.info({ successCount: executionResult.logs.filter((logEntry) => logEntry.status === 'success').length }, 'Action execution complete');
    return {
      execution: executionResult.logs,
      executionSummaries: executionResult.summaries,
    };
  } catch (error) {
    log.error({ err: error }, 'Execution node failed');
    return {
      execution: [],
      executionSummaries: ['⚠️ Échec lors de l’exécution du plan.'],
    };
  }
};

export const generateFinalResponseNode = async (
  state: AgentStateValues
): Promise<AgentUpdate> => {
  const log = agentLogger.child({
    node: 'generate_final_response',
    threadId: state.threadId,
    userId: state.userId,
  });

  log.debug('Generating final response');

  try {
    const message = await generateFinalResponse({
      userMessage: state.userMessage,
      plan: state.plan,
      executionLogs: state.execution ?? [],
      executionSummaries: state.executionSummaries ?? [],
    });

    log.info('Final response produced');
    return {
      response: message,
    };
  } catch (error) {
    log.error({ err: error }, 'Final response generation failed');
    return {
      response:
        "Je n'ai pas pu générer une réponse finale pour le moment. Réessaie ou vérifie les journaux.",
    };
  }
};

const workflow = new StateGraph(AgentState)
  .addNode('parse_intent', parseIntentNode)
  .addNode('gather_context', gatherContextNode)
  .addNode('plan_actions', planActionsNode)
  .addNode('execute_actions', executeActionsNode)
  .addNode('generate_final_response', generateFinalResponseNode)
  .addEdge(START, 'parse_intent')
  .addEdge('parse_intent', 'gather_context')
  .addEdge('gather_context', 'plan_actions')
  .addEdge('plan_actions', 'execute_actions')
  .addEdge('execute_actions', 'generate_final_response')
  .addEdge('generate_final_response', END);

export const synapAgentGraph = workflow.compile();

export interface SynapAgentInput {
  userId: string;
  threadId: string;
  message: string;
}

export type SynapAgentResult = AgentStateValues;

export async function runSynapAgent(input: SynapAgentInput): Promise<SynapAgentResult> {
  const invocationLog = agentLogger.child({
    userId: input.userId,
    threadId: input.threadId,
  });

  const startedAt = Date.now();
  invocationLog.info({ messagePreview: input.message.slice(0, 120) }, 'Synap agent invocation started');

  try {
    const result = await synapAgentGraph.invoke({
      userId: input.userId,
      threadId: input.threadId,
      userMessage: input.message,
    });

    invocationLog.info({ durationMs: Date.now() - startedAt }, 'Synap agent invocation completed');
    return result;
  } catch (error) {
    invocationLog.error({ err: error }, 'Synap agent invocation failed');
    throw error;
  }
}

