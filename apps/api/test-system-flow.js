
import { Client } from 'pg';
import crypto from 'crypto';

const API_URL = 'http://localhost:3000';
const TEST_USER_ID = 'test-user-system-flow';
const DB_CONNECTION_STRING = 'postgresql://postgres:synap_dev_password@localhost:5432/synap';

// Test Data
const THOUGHT_CONTENT = `System Flow Test Thought ${Date.now()}`;
const NOTE_TITLE = `System Flow Test Note ${Date.now()}`;
const NOTE_CONTENT = 'This is a test note created via tRPC';
const TASK_TITLE = `System Flow Test Task ${Date.now()}`;

async function runTest() {
  console.log('🚀 Starting Deep Dive System Validation...');
  console.log(`👤 User ID: ${TEST_USER_ID}`);

  // 1. Test Capture Flow
  console.log('\n📡 1. Testing Capture Flow (POST /trpc/capture.thought)...');
  try {
    const response = await fetch(`${API_URL}/trpc/capture.thought?batch=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': TEST_USER_ID,
      },
      body: JSON.stringify({
        0: { content: THOUGHT_CONTENT }
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Capture failed: ${response.status} ${text}`);
    }
    
    const result = await response.json();
    console.log('✅ Capture request successful:', JSON.stringify(result[0].result.data));
  } catch (error) {
    console.error('❌ Capture Flow Failed:', error);
    process.exit(1);
  }

  // 2. Test Note Creation Flow
  console.log('\n📝 2. Testing Note Creation Flow (POST /trpc/notes.create)...');
  try {
    const response = await fetch(`${API_URL}/trpc/notes.create?batch=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': TEST_USER_ID,
      },
      body: JSON.stringify({
        0: { 
          title: NOTE_TITLE,
          content: NOTE_CONTENT,
          tags: ['test', 'system-flow']
        }
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Note creation failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    console.log('✅ Note creation request successful:', JSON.stringify(result[0].result.data));
  } catch (error) {
    console.error('❌ Note Creation Flow Failed:', error);
    process.exit(1);
  }

  // 3. Test Hub Insight Flow
  console.log('\n🧠 3. Testing Hub Insight Flow (POST /hub/insights)...');
  try {
    const response = await fetch(`${API_URL}/hub/insights`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-test-user-id': TEST_USER_ID,
      },
      body: JSON.stringify({
        insights: [
          {
            version: '1.0',
            type: 'action_plan',
            correlationId: crypto.randomUUID(),
            confidence: 0.99,
            reasoning: 'System flow test',
            actions: [
              {
                eventType: 'task.creation.requested',
                data: {
                  entityId: crypto.randomUUID(),
                  title: TASK_TITLE,
                  content: 'Task created via Hub Insight',
                  tags: ['test', 'hub'],
                  priority: 1
                }
              }
            ]
          }
        ]
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hub Insight failed: ${response.status} ${text}`);
    }

    const result = await response.json();
    console.log('✅ Hub Insight submitted successfully');
  } catch (error) {
    console.error('❌ Hub Insight Flow Failed:', error);
    process.exit(1);
  }

  // 4. Wait for Processing
  console.log('\n⏳ Waiting 10 seconds for Inngest processing...');
  await new Promise(resolve => setTimeout(resolve, 10000));

  // 5. Verify Database
  console.log('\n🔍 5. Verifying Database Records...');
  const client = new Client({ connectionString: DB_CONNECTION_STRING });
  
  try {
    await client.connect();
    
    // Check for Captured Thought (Note)
    // Note: The thought processor creates a note with the thought content
    // Since we don't know the exact title AI generated (or fallback), we search by content/preview
    // Actually, fallback title is content.substring(0, 100)
    
    console.log('  Checking for Captured Thought...');
    const thoughtRes = await client.query(
      'SELECT id, title, type FROM entities WHERE user_id = $1 AND (preview LIKE $2 OR title = $3)',
      [TEST_USER_ID, `%${THOUGHT_CONTENT}%`, THOUGHT_CONTENT.substring(0, 100)]
    );
    
    if (thoughtRes.rows.length > 0) {
      console.log('  ✅ Captured Thought found:', thoughtRes.rows[0]);
    } else {
      console.error('  ❌ Captured Thought NOT found in DB');
    }

    // Check for Created Note
    console.log('  Checking for Created Note...');
    const noteRes = await client.query(
      'SELECT id, title, type FROM entities WHERE user_id = $1 AND title = $2',
      [TEST_USER_ID, NOTE_TITLE]
    );

    if (noteRes.rows.length > 0) {
      console.log('  ✅ Created Note found:', noteRes.rows[0]);
    } else {
      console.error('  ❌ Created Note NOT found in DB');
    }

    // Check for Created Task
    console.log('  Checking for Created Task...');
    const taskRes = await client.query(
      'SELECT id, title, type FROM entities WHERE user_id = $1 AND title = $2',
      [TEST_USER_ID, TASK_TITLE]
    );

    if (taskRes.rows.length > 0) {
      console.log('  ✅ Created Task found:', taskRes.rows[0]);
    } else {
      console.error('  ❌ Created Task NOT found in DB');
    }

    // Final Summary
    const totalFound = (thoughtRes.rows.length > 0 ? 1 : 0) + (noteRes.rows.length > 0 ? 1 : 0) + (taskRes.rows.length > 0 ? 1 : 0);
    if (totalFound === 3) {
      console.log('\n🎉 ALL SYSTEMS GO! All flows validated successfully.');
    } else {
      console.log(`\n⚠️  Validation Incomplete: Found ${totalFound}/3 entities.`);
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Database Verification Failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runTest();
