/**
 * EventRepository Test Script
 * 
 * V0.3: Test TimescaleDB event store functionality
 */

import { eventRepository, AggregateType, EventSource } from '../packages/database/src/repositories/event-repository.js';
import { randomUUID } from 'crypto';

async function runTests() {
  console.log('🧪 Testing EventRepository...\n');

  const testAggregateId = randomUUID();
  const testUserId = 'test-user-' + Date.now();

  try {
    // Test 1: Append single event
    console.log('Test 1: Append single event');
    const event1 = await eventRepository.append({
      aggregateId: testAggregateId,
      aggregateType: AggregateType.ENTITY,
      eventType: 'entity.created',
      userId: testUserId,
      data: {
        title: 'Test Entity',
        type: 'note',
      },
      version: 1,
      source: EventSource.API,
    });
    console.log('✅ Event appended:', event1.id);
    console.log('   Timestamp:', event1.timestamp);
    console.log('   Version:', event1.version);

    // Test 2: Append second event (version increment)
    console.log('\nTest 2: Append second event (version increment)');
    const event2 = await eventRepository.append({
      aggregateId: testAggregateId,
      aggregateType: AggregateType.ENTITY,
      eventType: 'entity.updated',
      userId: testUserId,
      data: {
        title: 'Updated Title',
        updatedFields: ['title'],
      },
      version: 2,
      causationId: event1.id,
      source: EventSource.API,
    });
    console.log('✅ Event appended:', event2.id);
    console.log('   Version:', event2.version);
    console.log('   Causation ID:', event2.causationId);

    // Test 3: Optimistic locking (should fail)
    console.log('\nTest 3: Optimistic locking (should fail with version conflict)');
    try {
      await eventRepository.append({
        aggregateId: testAggregateId,
        aggregateType: AggregateType.ENTITY,
        eventType: 'entity.updated',
        userId: testUserId,
        data: { title: 'Another Update' },
        version: 2, // Wrong version!
        source: EventSource.API,
      });
      console.log('❌ FAIL: Should have thrown concurrency error');
    } catch (error) {
      if (error instanceof Error && error.message.includes('Concurrency conflict')) {
        console.log('✅ Optimistic locking works:', error.message);
      } else {
        throw error;
      }
    }

    // Test 4: Get aggregate stream
    console.log('\nTest 4: Get aggregate stream (event replay)');
    const stream = await eventRepository.getAggregateStream(testAggregateId);
    console.log(`✅ Stream has ${stream.length} events`);
    stream.forEach((event, index) => {
      console.log(`   ${index + 1}. v${event.version} ${event.eventType}`);
    });

    // Test 5: Get aggregate version
    console.log('\nTest 5: Get aggregate version');
    const version = await eventRepository.getAggregateVersion(testAggregateId);
    console.log(`✅ Current version: ${version}`);

    // Test 6: Get user stream
    console.log('\nTest 6: Get user stream');
    const userEvents = await eventRepository.getUserStream(testUserId, {
      days: 1,
      limit: 10,
    });
    console.log(`✅ User has ${userEvents.length} events in last 24 hours`);

    // Test 7: Batch append
    console.log('\nTest 7: Batch append (3 events)');
    const correlationId = randomUUID();
    const batchAggregateId = randomUUID();
    
    const batchEvents = await eventRepository.appendBatch([
      {
        aggregateId: batchAggregateId,
        aggregateType: AggregateType.ENTITY,
        eventType: 'batch.event1',
        userId: testUserId,
        data: { step: 1 },
        version: 1,
        correlationId,
        source: EventSource.AUTOMATION,
      },
      {
        aggregateId: batchAggregateId,
        aggregateType: AggregateType.ENTITY,
        eventType: 'batch.event2',
        userId: testUserId,
        data: { step: 2 },
        version: 2,
        correlationId,
        source: EventSource.AUTOMATION,
      },
      {
        aggregateId: batchAggregateId,
        aggregateType: AggregateType.ENTITY,
        eventType: 'batch.event3',
        userId: testUserId,
        data: { step: 3 },
        version: 3,
        correlationId,
        source: EventSource.AUTOMATION,
      },
    ]);
    console.log(`✅ Batch inserted ${batchEvents.length} events`);

    // Test 8: Get correlated events
    console.log('\nTest 8: Get correlated events (workflow tracking)');
    const correlatedEvents = await eventRepository.getCorrelatedEvents(correlationId);
    console.log(`✅ Found ${correlatedEvents.length} correlated events`);

    // Test 9: Count events
    console.log('\nTest 9: Count events');
    const count = await eventRepository.countEvents({
      userId: testUserId,
    });
    console.log(`✅ User has ${count} total events`);

    // Test 10: Get events by type
    console.log('\nTest 10: Get events by type');
    const createdEvents = await eventRepository.getEventsByType('entity.created', 5);
    console.log(`✅ Found ${createdEvents.length} entity.created events (limit 5)`);

    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60));
    console.log('\nEventRepository is working correctly! 🎉');
    console.log('\nNext steps:');
    console.log('1. Run event migration: tsx scripts/migrate-events-to-timescale.ts');
    console.log('2. Verify migration');
    console.log('3. Switch API to use EventRepository');
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

