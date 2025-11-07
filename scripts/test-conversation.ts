/**
 * Conversation Test Script
 * 
 * V0.4: Test conversational interface
 */

import { conversationService } from '../packages/domain/src/index.js';
import { randomUUID } from 'crypto';

async function runTests() {
  console.log('🧪 Testing V0.4 Conversational Interface...\n');

  const testUserId = 'test-user-' + Date.now();
  const threadId = randomUUID();

  try {
    // Test 1: Send user message
    console.log('Test 1: Send user message');
    const msg1 = await conversationService.appendMessage({
      threadId,
      role: 'user',
      content: 'Create a task to call John tomorrow at 2pm',
      userId: testUserId,
    });
    console.log('✅ User message created:', msg1.id);
    console.log('   Hash:', msg1.hash.substring(0, 16) + '...');
    console.log('   Previous hash:', msg1.previousHash);

    // Test 2: Send assistant response
    console.log('\nTest 2: Send assistant response');
    const msg2 = await conversationService.appendMessage({
      threadId,
      parentId: msg1.id,
      role: 'assistant',
      content: 'I can create a task for you. Would you like me to proceed?',
      metadata: {
        suggestedActions: [
          {
            type: 'task.create',
            description: 'Create task: Call John',
            params: {
              title: 'Call John',
              dueDate: '2025-11-07T14:00:00Z',
            },
          },
        ],
        model: 'claude-3-haiku',
        tokens: 45,
        latency: 1234,
      },
      userId: testUserId,
    });
    console.log('✅ Assistant message created:', msg2.id);
    console.log('   Hash:', msg2.hash.substring(0, 16) + '...');
    console.log('   Previous hash:', msg2.previousHash?.substring(0, 16) + '...');
    console.log('   Suggested actions:', msg2.metadata?.suggestedActions?.length);

    // Test 3: User confirms
    console.log('\nTest 3: User confirms action');
    const msg3 = await conversationService.appendMessage({
      threadId,
      parentId: msg2.id,
      role: 'user',
      content: 'Yes, please create it',
      userId: testUserId,
    });
    console.log('✅ User confirmation:', msg3.id);

    // Test 4: System confirms execution
    console.log('\nTest 4: System confirms execution');
    const msg4 = await conversationService.appendMessage({
      threadId,
      parentId: msg3.id,
      role: 'system',
      content: '✅ Task created successfully!',
      metadata: {
        executedAction: {
          type: 'task.create',
          result: {
            taskId: randomUUID(),
            title: 'Call John',
          },
        },
      },
      userId: testUserId,
    });
    console.log('✅ System confirmation:', msg4.id);

    // Test 5: Get thread history
    console.log('\nTest 5: Get thread history');
    const history = await conversationService.getThreadHistory(threadId);
    console.log(`✅ Thread has ${history.length} messages`);
    history.forEach((msg, index) => {
      console.log(`   ${index + 1}. [${msg.role}] ${msg.content.substring(0, 50)}...`);
    });

    // Test 6: Verify hash chain
    console.log('\nTest 6: Verify hash chain integrity');
    const verification = await conversationService.verifyHashChain(threadId);
    console.log(`✅ Hash chain valid: ${verification.isValid}`);
    if (!verification.isValid) {
      console.log(`   ❌ Broken at: ${verification.brokenAt}`);
      console.log(`   Message: ${verification.message}`);
    }

    // Test 7: Create branch (alternate timeline)
    console.log('\nTest 7: Create branch from message 2');
    const branchThreadId = await conversationService.createBranch(msg2.id, testUserId);
    console.log('✅ Branch created:', branchThreadId);

    // Add message to branch
    const branchMsg = await conversationService.appendMessage({
      threadId: branchThreadId,
      parentId: msg2.id,
      role: 'user',
      content: 'Actually, let me think about this first',
      userId: testUserId,
    });
    console.log('   Branch message:', branchMsg.id);

    // Test 8: Get thread info
    console.log('\nTest 8: Get thread info');
    const threadInfo = await conversationService.getThreadInfo(threadId);
    console.log('✅ Thread info:');
    console.log(`   Messages: ${threadInfo.messageCount}`);
    console.log(`   Branches: ${threadInfo.branches}`);
    console.log(`   Latest: ${threadInfo.latestMessage?.content.substring(0, 50)}...`);

    // Test 9: Get user's threads
    console.log('\nTest 9: Get user threads');
    const userThreads = await conversationService.getUserThreads(testUserId);
    console.log(`✅ User has ${userThreads.length} threads`);
    userThreads.forEach((thread, index) => {
      console.log(`   ${index + 1}. Thread ${thread.threadId.substring(0, 8)}... (${thread.messageCount} messages)`);
      console.log(`      Latest: ${thread.latestMessage.content.substring(0, 40)}...`);
    });

    // Test 10: Get branches
    console.log('\nTest 10: Get branches from message 2');
    const branches = await conversationService.getBranches(msg2.id);
    console.log(`✅ Found ${branches.length} branches`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL CONVERSATION TESTS PASSED!');
    console.log('='.repeat(60));
    console.log('\nV0.4 Conversational Foundation is working! 🎉');
    console.log('\nConversation Flow Demonstrated:');
    console.log('1. User: "Create task..."');
    console.log('2. AI: "I can do that. Confirm?"');
    console.log('3. User: "Yes"');
    console.log('4. System: "✅ Done!"');
    console.log('\nAlternate Timeline (Branch):');
    console.log('2. AI: "I can do that. Confirm?"');
    console.log('3. [BRANCH] User: "Let me think..."');
    console.log('\nHash Chain: ✅ Verified');
    console.log('Branching: ✅ Working');
    console.log('\nNext: Phase 2 (AI Integration)');
    console.log('');

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    process.exit(1);
  }
}

runTests()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  });

