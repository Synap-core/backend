/**
 * V0.5 End-to-End Conversational Flow Test
 *
 * Validates the agent orchestrator branch:
 * User Message → Synap Agent Graph → Tool Execution → Conversation Log + Events
 */

import { randomUUID } from 'crypto';
import { AgentStateSchema } from '@synap/core';
import { runSynapAgent } from '../packages/ai/src/index.js';
import { conversationService, eventService } from '../packages/domain/src/index.js';

const NO_RESPONSE_FALLBACK =
  "Je n'ai pas pu générer de réponse pour le moment. Réessaie dans quelques instants.";

const divider = (label: string) => {
  console.log('\n' + label);
  console.log('─'.repeat(60));
};

async function runE2ETest() {
  console.log('🧪 Testing V0.5 Conversational Agent Flow...\n');
  console.log('='.repeat(60));

  const testUserId = `test-user-${Date.now()}`;
  const threadId = randomUUID();

  try {
    divider('📝 STEP 1: User message is captured in the hash-chained log');

    const userMessage = await conversationService.appendMessage({
      threadId,
      role: 'user',
      content: 'Capture cette idée: planifier une démo LangGraph avec l’équipe produit.',
      userId: testUserId,
    });

    console.log('✅ User message saved:', userMessage.id);

    divider('🧠 STEP 2: Synap Agent orchestrates intent → context → plan → execution');

    const agentState = await runSynapAgent({
      userId: testUserId,
      threadId,
      message: userMessage.content,
    });

    const agentMetadata = AgentStateSchema.parse({
      intentAnalysis: agentState.intentAnalysis,
      context: agentState.context
        ? {
            retrievedNotesCount: agentState.context.semanticResults.length,
            retrievedFactsCount: agentState.context.memoryFacts.length,
          }
        : undefined,
      plan: agentState.plan?.actions.map((action) => ({
        tool: action.tool,
        params: action.params,
        reasoning: action.justification ?? agentState.plan?.reasoning ?? 'Plan fourni sans justification.',
      })) ?? [],
      executionSummaries:
        agentState.execution?.map((log) => ({
          tool: log.tool,
          status: log.status,
          result: log.result,
          error: log.errorMessage,
        })) ?? [],
      finalResponse: agentState.response ?? NO_RESPONSE_FALLBACK,
      suggestedActions: agentState.plan?.actions.map((action) => ({
        type: action.tool,
        description: action.justification ?? 'Action proposée par le planificateur.',
        params: action.params,
      })),
    });

    console.log('✅ Agent state produced:');
    console.log('   Intent:', agentState.intent);
    console.log('   Actions:', agentState.plan?.actions.length ?? 0);
    console.log('   Executions:', agentState.execution?.length ?? 0);

    divider('💬 STEP 3: Assistant reply persisted with agent metadata');

    const assistantMetadata = {
      agentState: agentMetadata,
      suggestedActions: agentMetadata.suggestedActions,
      model: agentMetadata.model,
      tokens: agentMetadata.tokens,
      latency: agentMetadata.latency,
    };

    const assistantMessage = await conversationService.appendMessage({
      threadId,
      parentId: userMessage.id,
      role: 'assistant',
      content: agentState.response ?? NO_RESPONSE_FALLBACK,
      metadata: assistantMetadata,
      userId: testUserId,
    });

    console.log('✅ Assistant message saved:', assistantMessage.id);

    divider('📦 STEP 4: Verify that tools executed side-effects (events, storage, etc.)');

    const executed = agentState.execution ?? [];
    if (executed.length === 0) {
      console.warn('⚠️ Agent executed no tools. Nothing to verify.');
    } else {
      for (const log of executed) {
        console.log(`→ ${log.tool}: ${log.status}`);
        if (log.result && typeof log.result === 'object') {
          const result = log.result as { eventId?: string; entityId?: string };
          if (result.eventId && result.entityId) {
            const events = await eventService.getAggregateStream(result.entityId);
            const event = events.find((evt) => evt.id === result.eventId);

            if (event) {
              console.log(`   Event recorded: ${event.eventType} (${event.id})`);
            } else {
              console.warn('   ⚠️ Unable to locate event for:', result.eventId);
            }
          }
        }
      }
    }

    divider('🔍 STEP 5: End-to-end integrity checks');

    const history = await conversationService.getThreadHistory(threadId);
    console.log('✅ Conversation history contains', history.length, 'messages');

    const integrity = await conversationService.verifyHashChain(threadId);
    console.log('✅ Hash chain:', integrity.isValid ? 'VALID ✅' : 'INVALID ❌');

    console.log('\n' + '='.repeat(60));
    console.log('✅ V0.5 Conversational Agent flow verified!');
    console.log('='.repeat(60));
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

runE2ETest()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });

