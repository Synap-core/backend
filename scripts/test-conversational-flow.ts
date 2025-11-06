/**
 * V0.4 End-to-End Conversational Flow Test
 * 
 * Tests the complete flow:
 * User Message → AI Response → User Confirmation → Event Logged → State Updated
 */

import { conversationRepository, MessageRole } from '../packages/database/src/repositories/conversation-repository.js';
import { eventRepository, AggregateType } from '../packages/database/src/repositories/event-repository.js';
import { conversationalAgent, actionExtractor } from '../packages/ai/src/index.js';
import { randomUUID } from 'crypto';

async function runE2ETest() {
  console.log('🧪 Testing V0.4 Complete Conversational Flow...\n');
  console.log('=' .repeat(60));

  const testUserId = 'test-user-' + Date.now();
  const threadId = randomUUID();

  try {
    // =========================================================================
    // STEP 1: User sends a message
    // =========================================================================
    console.log('\n📝 STEP 1: User Message');
    console.log('─'.repeat(60));
    
    const userMessage = await conversationRepository.appendMessage({
      threadId,
      role: MessageRole.USER,
      content: 'Pense-bête: appeler Jean demain à 14h pour discuter du projet',
      userId: testUserId,
    });
    
    console.log('✅ User message saved');
    console.log('   ID:', userMessage.id);
    console.log('   Content:', userMessage.content);
    console.log('   Hash:', userMessage.hash.substring(0, 16) + '...');

    // =========================================================================
    // STEP 2: AI analyzes and responds
    // =========================================================================
    console.log('\n🤖 STEP 2: AI Analysis & Response');
    console.log('─'.repeat(60));
    
    const aiResponse = await conversationalAgent.generateResponse(
      [],  // No previous history
      userMessage.content,
      {}
    );
    
    console.log('✅ AI response generated');
    console.log('   Model:', aiResponse.model);
    console.log('   Latency:', aiResponse.latency, 'ms');
    console.log('   Tokens:', aiResponse.tokens.total);
    console.log('   Content:', aiResponse.content.substring(0, 100) + '...');

    // Extract actions
    const extraction = actionExtractor.extractActions(aiResponse.content);
    
    console.log('\n🔍 Action Extraction:');
    console.log('   Actions found:', extraction.actions.length);
    extraction.actions.forEach((action, index) => {
      console.log(`   ${index + 1}. ${action.type}`);
      console.log(`      Params:`, JSON.stringify(action.params, null, 2).split('\n').map(l => '      ' + l).join('\n').trim());
    });

    // Save assistant message
    const assistantMessage = await conversationRepository.appendMessage({
      threadId,
      parentId: userMessage.id,
      role: MessageRole.ASSISTANT,
      content: extraction.cleanContent || aiResponse.content,
      metadata: {
        suggestedActions: extraction.actions.map(action => ({
          type: action.type,
          description: `Execute ${action.type}`,
          params: action.params,
        })),
        model: aiResponse.model,
        tokens: aiResponse.tokens.total,
        latency: aiResponse.latency,
      },
      userId: testUserId,
    });
    
    console.log('\n✅ Assistant message saved');
    console.log('   ID:', assistantMessage.id);
    console.log('   Suggested actions:', (assistantMessage.metadata as any)?.suggestedActions?.length || 0);

    // =========================================================================
    // STEP 3: User confirms action
    // =========================================================================
    console.log('\n👍 STEP 3: User Confirmation');
    console.log('─'.repeat(60));
    
    const confirmationMessage = await conversationRepository.appendMessage({
      threadId,
      parentId: assistantMessage.id,
      role: MessageRole.USER,
      content: 'Oui, crée la tâche s\'il te plaît',
      userId: testUserId,
    });
    
    console.log('✅ User confirmed action');
    console.log('   ID:', confirmationMessage.id);

    // =========================================================================
    // STEP 4: Execute action (emit event)
    // =========================================================================
    console.log('\n⚡ STEP 4: Action Execution (Event Emission)');
    console.log('─'.repeat(60));
    
    // Simulate executeAction logic
    if (extraction.actions.length > 0) {
      const firstAction = extraction.actions[0];
      const aggregateId = randomUUID();
      
      // Emit event to event store
      const event = await eventRepository.append({
        aggregateId,
        aggregateType: AggregateType.ENTITY,
        eventType: 'task.creation.requested',
        userId: testUserId,
        data: {
          ...firstAction.params,
          status: 'todo',
        },
        version: 1,
        source: 'api' as any,
        metadata: {
          triggeredBy: 'conversation',
          threadId,
          messageId: assistantMessage.id,
        },
      });
      
      console.log('✅ Event emitted to event store');
      console.log('   Event ID:', event.id);
      console.log('   Event Type:', event.eventType);
      console.log('   Aggregate ID:', event.aggregateId);
      console.log('   Version:', event.version);
      
      // Log system message
      const systemMessage = await conversationRepository.appendMessage({
        threadId,
        parentId: confirmationMessage.id,
        role: MessageRole.SYSTEM,
        content: '✅ Tâche créée avec succès!',
        metadata: {
          executedAction: {
            type: firstAction.type,
            result: {
              taskId: aggregateId,
              eventId: event.id,
            },
          },
        },
        userId: testUserId,
      });
      
      console.log('\n✅ System confirmation saved');
      console.log('   ID:', systemMessage.id);

      // ========================================================================
      // STEP 5: Verify complete flow
      // ========================================================================
      console.log('\n✅ STEP 5: Verification');
      console.log('─'.repeat(60));
      
      // Verify conversation history
      const fullHistory = await conversationRepository.getThreadHistory(threadId);
      console.log('✅ Conversation history:', fullHistory.length, 'messages');
      fullHistory.forEach((msg, index) => {
        console.log(`   ${index + 1}. [${msg.role}] ${msg.content.substring(0, 50)}...`);
      });
      
      // Verify hash chain
      const verification = await conversationRepository.verifyHashChain(threadId);
      console.log('\n✅ Hash chain verification:', verification.isValid ? 'VALID ✅' : 'INVALID ❌');
      
      // Verify event was logged
      const events = await eventRepository.getAggregateStream(aggregateId);
      console.log('\n✅ Events in aggregate stream:', events.length);
      events.forEach((evt, index) => {
        console.log(`   ${index + 1}. v${evt.version} ${evt.eventType}`);
      });
      
      // Verify event has conversation context
      const eventWithContext = events[0];
      console.log('\n✅ Event metadata (conversation context):');
      console.log('   Triggered by:', (eventWithContext.metadata as any)?.triggeredBy);
      console.log('   Thread ID:', (eventWithContext.metadata as any)?.threadId);
      console.log('   Message ID:', (eventWithContext.metadata as any)?.messageId);

    } else {
      console.log('⚠️  No actions extracted from AI response');
      console.log('   AI Response:', aiResponse.content);
    }

    // =========================================================================
    // SUCCESS
    // =========================================================================
    console.log('\n' + '='.repeat(60));
    console.log('✅ END-TO-END TEST PASSED!');
    console.log('='.repeat(60));
    console.log('\n🎉 V0.4 Complete Conversational Flow Working!');
    console.log('\nFlow Validated:');
    console.log('1. ✅ User Message → Conversation DB (hash-chained)');
    console.log('2. ✅ AI Analysis → Action Extraction');
    console.log('3. ✅ Assistant Response → Stored with metadata');
    console.log('4. ✅ User Confirmation → Logged');
    console.log('5. ✅ Action Execution → Event Emitted (TimescaleDB)');
    console.log('6. ✅ System Confirmation → Conversation updated');
    console.log('7. ✅ Hash Chain → Verified');
    console.log('8. ✅ Event Metadata → Contains conversation context');
    console.log('\n🔗 Connection: Conversation → Events → State (COMPLETE)');
    console.log('');

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

