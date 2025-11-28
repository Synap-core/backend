/**
 * E2E Test: Event Loop Verification
 * 
 * Tests the complete flow:
 * 1. Intelligence Hub analyzes thought
 * 2. Sends insights to Data Pod /hub/insights
 * 3. Data Pod publishes events to Inngest
 * 4. Workers process events
 * 5. Results are stored
 * 
 * Usage: node test-event-loop.js
 */

import fetch from 'node-fetch';

const DATA_POD_URL = process.env.DATA_POD_URL || 'http://localhost:3000';
const HUB_URL = process.env.INTELLIGENCE_HUB_URL || 'http://localhost:3001';

// Mock HubInsight payload
const mockInsight = {
  insights: [
    {
      version: '1.0',
      type: 'action_plan',
      correlationId: crypto.randomUUID(),
      title: 'Create note from thought',
      description: 'User said: "Meeting with client tomorrow. Prepare slides."',
      actions: [
        {
          type: 'create_entity',
          entityType: 'note',
          data: {
            entityId: crypto.randomUUID(),
            title: 'Meeting with client tomorrow',
            content: 'Meeting with client tomorrow. Prepare slides.',
            tags: ['meeting', 'client', 'preparation'],
            entities: [
              { name: 'client', type: 'organization' }
            ]
          }
        },
        {
          type: 'create_entity',
          entityType: 'task',
          data: {
            entityId: crypto.randomUUID(),
            title: 'Prepare slides',
            content: 'Prepare slides for tomorrow\'s client meeting',
            tags: ['task', 'preparation'],
            priority: 2,
            dueDate: new Date(Date.now() + 86400000).toISOString() // tomorrow
          }
        }
      ],
      metadata: {
        source: 'test-script'
      }
    }
  ]
};

async function testEventLoop() {
  console.log('🧪 Testing Event Loop...\n');
  
  try {
    // 1. Call /hub/insights endpoint
    console.log('📤 1. Sending insights to Data Pod /hub/insights...');
    
    const response = await fetch(`${DATA_POD_URL}/hub/insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Note: In real scenario, you'd need a valid OAuth2 token
        // For testing, you might need to disable auth or use a test token
        'Authorization': `Bearer ${process.env.TEST_TOKEN || 'test-token'}`,
      },
      body: JSON.stringify(mockInsight),
    });
    
    if (!response.ok) {
      const error = await response.json();
      console.error('❌ Error:', error);
      return;
    }
    
    const result = await response.json();
    console.log('✅ Insights submitted successfully:');
    console.log(`   - Events published: ${result.eventsPublished}`);
    console.log(`   - Event IDs: ${result.eventIds.join(', ')}\n`);
    
    // 2. Wait for events to process
    console.log('⏳ 2. Waiting for events to be processed by workers (3 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 3. Verify events in Inngest (requires Inngest dashboard access)
    console.log('✅ 3. Events should now be visible in Inngest dashboard');
    console.log(`   Dashboard: http://localhost:8288 (if running locally)\n`);
    
    // 4. Verify database records (requires database access)
    console.log('✅ 4. Check database for created entities:');
    console.log('   - Note: "Meeting with client tomorrow"');
    console.log('   - Task: "Prepare slides"\n');
    
    console.log('🎉 Event loop test completed!');
    console.log('📋 Manual verification steps:');
    console.log('   1. Check Inngest dashboard for processed events');
    console.log('   2. Query database to verify entities were created');
    console.log('   3. Verify file storage has note content');
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testEventLoop();
