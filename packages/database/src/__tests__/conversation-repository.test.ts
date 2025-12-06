/**
 * ConversationRepository Tests
 * 
 * Tests for conversation and message storage.
 * Validates conversation creation, message appending, and user isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '../index.js';
import { generateTestUserId } from './test-utils.js';

describe('ConversationRepository', () => {
  beforeAll(async () => {
    await sql`DELETE FROM conversation_messages WHERE user_id LIKE 'test-%'`;
  });

  afterAll(async () => {
    await sql`DELETE FROM conversation_messages WHERE user_id LIKE 'test-%'`;
  });

  describe('message storage', () => {
    it('should store conversation message', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();
      const messageId = crypto.randomUUID();

      await sql`
        INSERT INTO conversation_messages (
          id, user_id, thread_id, role, content, created_at
        ) VALUES (
          ${messageId}, ${userId}, ${conversationId}, 'user', 'Hello, how are you?', NOW()
        )
      `;

      const [stored] = await sql`
        SELECT * FROM conversation_messages WHERE id = ${messageId}
      `;

      expect(stored.role).toBe('user');
      expect(stored.content).toBe('Hello, how are you?');
      expect(stored.thread_id).toBe(conversationId);
    });

    it('should handle different message roles', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();

      const messages = [
        { role: 'user', content: 'What is the capital of France?' },
        { role: 'assistant', content: 'The capital of France is Paris.' },
        { role: 'system', content: 'You are a helpful assistant.' },
      ];

      for (const msg of messages) {
        await sql`
          INSERT INTO conversation_messages (
            id, user_id, thread_id, role, content, created_at
          ) VALUES (
            ${crypto.randomUUID()}, ${userId}, ${conversationId}, ${msg.role}, ${msg.content}, NOW()
          )
        `;
      }

      const stored = await sql`
        SELECT * FROM conversation_messages 
        WHERE thread_id = ${conversationId}
        ORDER BY created_at ASC
      `;

      expect(stored.length).toBe(3);
      expect(stored[0].role).toBe('user');
      expect(stored[1].role).toBe('assistant');
      expect(stored[2].role).toBe('system');
    });

    it('should maintain message order within conversation', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();

      // Insert messages with slight delays to ensure ordering
      for (let i = 1; i <= 5; i++) {
        await sql`
          INSERT INTO conversation_messages (
            id, user_id, thread_id, role, content, created_at
          ) VALUES (
            ${crypto.randomUUID()}, ${userId}, ${conversationId}, 'user', 
            ${'Message ' + i}, NOW()
          )
        `;
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const messages = await sql`
        SELECT content FROM conversation_messages 
        WHERE thread_id = ${conversationId}
        ORDER BY created_at ASC
      `;

      expect(messages.map(m => m.content)).toEqual([
        'Message 1',
        'Message 2',
        'Message 3',
        'Message 4',
        'Message 5',
      ]);
    });
  });

  describe('conversation management', () => {
    it('should group messages by conversation', async () => {
      const userId = generateTestUserId();
      const conv1 = crypto.randomUUID();
      const conv2 = crypto.randomUUID();

      await sql`
        INSERT INTO conversation_messages (id, user_id, thread_id, role, content, created_at)
        VALUES 
          (${crypto.randomUUID()}, ${userId}, ${conv1}, 'user', 'Conv1 Msg1', NOW()),
          (${crypto.randomUUID()}, ${userId}, ${conv1}, 'assistant', 'Conv1 Msg2', NOW()),
          (${crypto.randomUUID()}, ${userId}, ${conv2}, 'user', 'Conv2 Msg1', NOW())
      `;

      const conv1Messages = await sql`
        SELECT * FROM conversation_messages WHERE thread_id = ${conv1}
      `;

      const conv2Messages = await sql`
        SELECT * FROM conversation_messages WHERE thread_id = ${conv2}
      `;

      expect(conv1Messages.length).toBe(2);
      expect(conv2Messages.length).toBe(1);
    });

    it('should enforce user isolation', async () => {
      const user1 = generateTestUserId();
      const user2 = generateTestUserId();
      const conversationId = crypto.randomUUID();

      await sql`
        INSERT INTO conversation_messages (id, user_id, thread_id, role, content, created_at)
        VALUES 
          (${crypto.randomUUID()}, ${user1}, ${conversationId}, 'user', 'User 1 message', NOW()),
          (${crypto.randomUUID()}, ${user2}, ${conversationId}, 'user', 'User 2 message', NOW())
      `;

      const user1Messages = await sql`
        SELECT * FROM conversation_messages WHERE user_id = ${user1}
      `;

      expect(user1Messages.length).toBe(1);
      expect(user1Messages[0].content).toBe('User 1 message');
    });
  });

  describe('message content', () => {
    it('should handle long messages', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();
      const longContent = 'A'.repeat(10000); // 10KB message

      await sql`
        INSERT INTO conversation_messages (
          id, user_id, thread_id, role, content, created_at
        ) VALUES (
          ${crypto.randomUUID()}, ${userId}, ${conversationId}, 'user', ${longContent}, NOW()
        )
      `;

      const [stored] = await sql`
        SELECT content FROM conversation_messages WHERE thread_id = ${conversationId}
      `;

      expect(stored.content.length).toBe(10000);
    });

    it('should handle special characters in messages', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();
      const specialContent = "It's a test with \"quotes\" and \n newlines & symbols: @#$%";

      await sql`
        INSERT INTO conversation_messages (
          id, user_id, thread_id, role, content, created_at
        ) VALUES (
          ${crypto.randomUUID()}, ${userId}, ${conversationId}, 'user', ${specialContent}, NOW()
        )
      `;

      const [stored] = await sql`
        SELECT content FROM conversation_messages WHERE thread_id = ${conversationId}
      `;

      expect(stored.content).toBe(specialContent);
    });

    it('should handle unicode content', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();
      const unicodeContent = '你好 👋 مرحبا Привет';

      await sql`
        INSERT INTO conversation_messages (
          id, user_id, thread_id, role, content, created_at
        ) VALUES (
          ${crypto.randomUUID()}, ${userId}, ${conversationId}, 'user', ${unicodeContent}, NOW()
        )
      `;

      const [stored] = await sql`
        SELECT content FROM conversation_messages WHERE thread_id = ${conversationId}
      `;

      expect(stored.content).toBe(unicodeContent);
    });
  });

  describe('queries', () => {
    it('should retrieve conversation history in order', async () => {
      const userId = generateTestUserId();
      const conversationId = crypto.randomUUID();

      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there!' },
        { role: 'user', content: 'How are you?' },
        { role: 'assistant', content: 'I am doing well, thanks!' },
      ];

      for (const msg of messages) {
        await sql`
          INSERT INTO conversation_messages (
            id, user_id, thread_id, role, content, created_at
          ) VALUES (
            ${crypto.randomUUID()}, ${userId}, ${conversationId}, ${msg.role}, ${msg.content}, NOW()
          )
        `;
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      const history = await sql`
        SELECT role, content FROM conversation_messages 
        WHERE thread_id = ${conversationId}
        ORDER BY created_at ASC
      `;

      expect(history.map(h => ({ role: h.role, content: h.content }))).toEqual(messages);
    });

    it('should handle empty conversation', async () => {
      const conversationId = crypto.randomUUID();

      const messages = await sql`
        SELECT * FROM conversation_messages WHERE thread_id = ${conversationId}
      `;

      expect(messages).toEqual([]);
    });
  });
});
