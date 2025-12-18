/**
 * EventRepository Tests
 * 
 * Test suite for the EventRepository using the correct SynapEvent API.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from '../client-pg.js';
import { eventRepository } from '../repositories/event-repository.js';
import type { SynapEvent } from '@synap/core';
import { cleanTestData, generateTestUserId } from './test-utils.js';

describe('EventRepository', () => {
  beforeEach(async () => {
    await cleanTestData();
  });

  describe('append', () => {
    it('should append event successfully', async () => {
      const userId = generateTestUserId();
      
      const event: SynapEvent = {
        id: crypto.randomUUID(),
        type: 'note.created',
        userId,
        data: { content: 'Test note' },
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      };
      
      const result = await eventRepository.append(event);
      
      expect(result.id).toBe(event.id);
      expect(result.eventType).toBe('note.created');
      expect(result.userId).toBe(userId);
    });

    it('should handle concurrent writes', async () => {
      const userId = generateTestUserId();
      
      const events: SynapEvent[] = Array.from({ length: 10 }, (_, i) => ({
        id: crypto.randomUUID(),
        type: 'test.event',
        userId,
        data: { index: i },
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      }));
      
      await Promise.all(events.map(e => eventRepository.append(e)));
      
      const stored = await sql`
        SELECT * FROM events_timescale WHERE user_id = ${userId}
      `;
      
      expect(stored.length).toBe(10);
    });

    it('should enforce user isolation', async () => {
      const user1 = generateTestUserId();
      const user2 = generateTestUserId();
      
      await eventRepository.append({
        id: crypto.randomUUID(),
        type: 'test.event',
        userId: user1,
        data: {},
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      });
      
      await eventRepository.append({
        id: crypto.randomUUID(),
        type: 'test.event',
        userId: user2,
        data: {},
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      });
      
      const user1Events = await sql`SELECT * FROM events_timescale WHERE user_id = ${user1}`;
      const user2Events = await sql`SELECT * FROM events_timescale WHERE user_id = ${user2}`;
      
      expect(user1Events.length).toBe(1);
      expect(user2Events.length).toBe(1);
    });

    it('should serialize Date objects correctly', async () => {
      const userId = generateTestUserId();
      const timestamp = new Date('2024-01-15T10:30:00Z');
      
      const event: SynapEvent = {
        id: crypto.randomUUID(),
        type: 'note.updated',
        userId,
        data: { 
          updatedAt: timestamp.toISOString(),
          note: 'Date test'
        },
        timestamp,
        source: 'api',
        version: 'v1',
      };
      
      await eventRepository.append(event);
      
      const [stored] = await sql`
        SELECT * FROM events_timescale WHERE id = ${event.id}
      `;
      
      expect(stored.timestamp).toBeDefined();
      const storedTimestamp = new Date(stored.timestamp);
      expect(storedTimestamp.toISOString()).toBe(timestamp.toISOString());
    });

    it('should handle very large event data', async () => {
      const userId = generateTestUserId();
      const largeText = 'x'.repeat(100000); // 100KB
      
      const event: SynapEvent = {
        id: crypto.randomUUID(),
        type: 'note.created',
        userId,
        data: { content: largeText },
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      };
      
      await eventRepository.append(event);
      
      const [stored] = await sql`
        SELECT * FROM events_timescale WHERE id = ${event.id}
      `;
      
      expect(stored.data.content).toBe(largeText);
      expect(stored.data.content.length).toBe(100000);
    });

    it('should handle special characters and unicode', async () => {
      const userId = generateTestUserId();
      const specialData = {
        emoji: '🚀 🎉 ✅ 💡',
        unicode: 'Hello 世界 مرحبا Привет',
        quotes: "It's a \"test\" with 'mixed' quotes",
        newlines: 'Line 1\nLine 2\r\nLine 3',
        symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?',
      };
      
      const event: SynapEvent = {
        id: crypto.randomUUID(),
        type: 'note.created',
        userId,
        data: specialData,
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      };
      
      await eventRepository.append(event);
      
      const [stored] = await sql`
        SELECT * FROM events_timescale WHERE id = ${event.id}
      `;
      
      expect(stored.data).toEqual(specialData);
    });

    it('should  store deeply nested complex data', async () => {
      const userId = generateTestUserId();
      const complexData = {
        title: 'Complex Note',
        tags: ['important', 'test', 'nested'],
        metadata: {
          priority: 1,
          dueDate: '2024-12-31',
          assignee: {
            id: 'user-123',
            name: 'John Doe',
            roles: ['admin', 'editor'],
          },
        },
        nested: {
          level1: {
            level2: {
              level3: {
                value: true,
                data: [1, 2, 3],
              },
            },
          },
        },
      };
      
      const event: SynapEvent = {
        id: crypto.randomUUID(),
        type: 'note.created',
        userId,
        data: complexData,
        timestamp: new Date(),
        source: 'api',
        version: 'v1',
      };
      
      await eventRepository.append(event);
      
      const [stored] = await sql`
        SELECT * FROM events_timescale WHERE id = ${event.id}
      `;
      
      expect(stored.data).toEqual(complexData);
    });
  });

  describe('query operations', () => {
    it('should fetch events in chronological order', async () => {
      const userId = generateTestUserId();
      
      const events = [
        { id: 'e1', timestamp: new Date('2024-01-01T10:00:00Z') },
        { id: 'e2', timestamp: new Date('2024-01-03T10:00:00Z') },
        { id: 'e3', timestamp: new Date('2024-01-02T10:00:00Z') },
      ];
      
      for (const e of events) {
        await eventRepository.append({
          ...e,
          userId,
          type: 'test.event',
          data: {},
          source: 'api',
          version: 'v1',
        });
      }
      
      const fetched = await sql`
        SELECT * FROM events_timescale 
        WHERE user_id = ${userId}
        ORDER BY timestamp ASC
      `;
      
      expect(fetched[0].id).toBe('e1');
      expect(fetched[1].id).toBe('e3');
      expect(fetched[2].id).toBe('e2');
    });

    it('should return empty array for user with no events', async () => {
      const userId = generateTestUserId();
      
      const events = await sql`
        SELECT * FROM events_timescale WHERE user_id = ${userId}
      `;
      
      expect(events.length).toBe(0);
    });
  });
});
