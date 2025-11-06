/**
 * Local MVP Validation Tests
 * 
 * Tests the simplified single-user architecture
 */

import { db, events, entities, contentBlocks } from '@synap/database';

console.log('🧪 Starting Local MVP Validation Tests\n');

// Test configuration
const API_URL = process.env.API_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.SYNAP_SECRET_TOKEN || 'test-token-123';

// Test results tracking
let testsRun = 0;
let testsPassed = 0;
let testsFailed = 0;

function logTest(name: string, passed: boolean, message?: string) {
  testsRun++;
  if (passed) {
    testsPassed++;
    console.log(`✅ ${name}`);
  } else {
    testsFailed++;
    console.log(`❌ ${name}`);
    if (message) console.log(`   Error: ${message}`);
  }
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  LOCAL MVP VALIDATION TESTS');
  console.log('═══════════════════════════════════════════════════════\n');

  // Test 1: Health Check
  try {
    const response = await fetch(`${API_URL}/health`);
    const data = await response.json();
    logTest(
      'Test 1: Health Check',
      response.status === 200 && data.status === 'ok' && data.mode === 'single-user',
      response.status !== 200 ? `Status: ${response.status}` : undefined
    );
  } catch (error) {
    logTest('Test 1: Health Check', false, (error as Error).message);
  }

  // Test 2: Database Connection (SQLite)
  try {
    const result = await db.select().from(events).limit(1);
    logTest('Test 2: Database Connection (SQLite)', true);
  } catch (error) {
    logTest('Test 2: Database Connection (SQLite)', false, (error as Error).message);
  }

  // Test 3: Unauthenticated Request (should fail)
  try {
    const response = await fetch(`${API_URL}/api/trpc/capture.thought`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Test thought',
      }),
    });
    
    logTest(
      'Test 3: Unauthenticated Request Blocked',
      response.status === 401,
      `Expected 401, got ${response.status}`
    );
  } catch (error) {
    logTest('Test 3: Unauthenticated Request Blocked', false, (error as Error).message);
  }

  // Test 4: Authenticated Request (should work)
  try {
    const response = await fetch(`${API_URL}/api/trpc/events.list`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    
    logTest(
      'Test 4: Authenticated Request Works',
      response.status === 200 || response.status === 204,
      response.status >= 400 ? `Got ${response.status}` : undefined
    );
  } catch (error) {
    logTest('Test 4: Authenticated Request Works', false, (error as Error).message);
  }

  // Test 5: End-to-End Thought Capture
  try {
    console.log('\n🔄 Running end-to-end test (this takes ~10 seconds)...\n');
    
    // Count entities before
    const entitiesBefore = await db.select().from(entities);
    const countBefore = entitiesBefore.length;
    
    // Capture a thought
    const captureResponse = await fetch(`${API_URL}/api/trpc/capture.thought`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content: 'Buy milk tomorrow at 3pm',
      }),
    });
    
    if (captureResponse.status !== 200) {
      logTest('Test 5: End-to-End Thought Capture', false, `Capture failed with ${captureResponse.status}`);
    } else {
      // Wait for Inngest to process (AI analysis + entity creation)
      await sleep(8000); // 8 seconds should be enough
      
      // Check if entity was created
      const entitiesAfter = await db.select().from(entities);
      const countAfter = entitiesAfter.length;
      
      if (countAfter > countBefore) {
        const newEntity = entitiesAfter[entitiesAfter.length - 1];
        console.log(`   Created: ${newEntity.title} (type: ${newEntity.type})`);
        
        // Check if content was stored
        const allContent = await db.select().from(contentBlocks).all();
        const content = allContent.filter((c: any) => c.entityId === newEntity.id);
        
        logTest(
          'Test 5: End-to-End Thought Capture',
          content.length > 0 && content[0].content.includes('milk'),
          content.length === 0 ? 'Content not stored' : undefined
        );
      } else {
        logTest('Test 5: End-to-End Thought Capture', false, 'Entity not created');
      }
    }
  } catch (error) {
    logTest('Test 5: End-to-End Thought Capture', false, (error as Error).message);
  }

  // Test 6: Event Log Verification
  try {
    const allEvents = await db.select().from(events);
    const hasCapturedEvent = allEvents.some((e: any) => e.type === 'api/thought.captured' || e.type === 'entity.created');
    
    logTest(
      'Test 6: Event Log Verification',
      hasCapturedEvent,
      !hasCapturedEvent ? 'No capture events found' : undefined
    );
  } catch (error) {
    logTest('Test 6: Event Log Verification', false, (error as Error).message);
  }

  // Print summary
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════\n');
  console.log(`Total Tests:  ${testsRun}`);
  console.log(`✅ Passed:    ${testsPassed}`);
  console.log(`❌ Failed:    ${testsFailed}`);
  console.log(`Success Rate: ${Math.round((testsPassed / testsRun) * 100)}%\n`);

  if (testsFailed === 0) {
    console.log('🎉 All tests passed! Local MVP is working perfectly.\n');
    console.log('Try capturing thoughts:');
    console.log(`  curl -X POST ${API_URL}/api/trpc/capture.thought \\`);
    console.log(`    -H "Authorization: Bearer ${AUTH_TOKEN}" \\`);
    console.log(`    -d '{"content":"Your thought here"}'\n`);
  } else {
    console.log('⚠️  Some tests failed. Please review the errors above.\n');
    process.exit(1);
  }
}

// Run tests
runTests().catch((error) => {
  console.error('\n💥 Test suite crashed:', error);
  process.exit(1);
});

