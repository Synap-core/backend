import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type {
  AppendConversationMessageInput,
  ConversationMessage,
  ConversationThreadInfo,
  ConversationThreadSummary,
  HashVerificationResult,
} from '../src/types.js';

vi.mock('@synap/database', () => {
  const defaultRepoMock = {
    appendMessage: vi.fn(),
    getThreadHistory: vi.fn(),
    getThreadInfo: vi.fn(),
    getUserThreads: vi.fn(),
    createBranch: vi.fn(),
    getBranches: vi.fn(),
    verifyHashChain: vi.fn(),
    deleteMessage: vi.fn(),
  };

  return {
    conversationRepository: defaultRepoMock,
    MessageRole: {
      USER: 'user',
      ASSISTANT: 'assistant',
      SYSTEM: 'system',
    },
  };
});

const { ConversationService } = await import('../src/services/conversation.js');

class InMemoryConversationRepo {
  private readonly threads = new Map<string, ConversationMessage[]>();

  async appendMessage(data: AppendConversationMessageInput): Promise<ConversationMessage> {
    const createdAt = new Date();
    const message: ConversationMessage = {
      id: randomUUID(),
      threadId: data.threadId,
      parentId: data.parentId ?? null,
      role: data.role,
      content: data.content,
      metadata: data.metadata ?? null,
      userId: data.userId,
      timestamp: createdAt,
      previousHash: null,
      hash: `hash-${createdAt.getTime()}`,
      deletedAt: null,
    };

    const messages = this.threads.get(data.threadId) ?? [];
    messages.push(message);
    this.threads.set(data.threadId, messages);

    return message;
  }

  async getThreadHistory(threadId: string, limit: number): Promise<ConversationMessage[]> {
    return [...(this.threads.get(threadId) ?? [])].slice(0, limit);
  }

  async getThreadInfo(threadId: string): Promise<ConversationThreadInfo> {
    const messages = this.threads.get(threadId) ?? [];
    return {
      threadId,
      messageCount: messages.length,
      latestMessage: messages.at(-1) ?? null,
      branches: 0,
    };
  }

  async getUserThreads(userId: string, limit: number): Promise<ConversationThreadSummary[]> {
    const result: ConversationThreadSummary[] = [];
    for (const [threadId, messages] of this.threads.entries()) {
      const first = messages[0];
      if (first?.userId === userId) {
        result.push({
          threadId,
          messageCount: messages.length,
          latestMessage: messages.at(-1)!,
        });
      }
      if (result.length >= limit) break;
    }
    return result;
  }

  async createBranch(): Promise<string> {
    return randomUUID();
  }

  async getBranches(): Promise<ConversationMessage[]> {
    return [];
  }

  async verifyHashChain(): Promise<HashVerificationResult> {
    return {
      isValid: true,
      brokenAt: null,
      message: 'Chain intact',
    };
  }

  async deleteMessage(): Promise<void> {}
}

describe('ConversationService', () => {
  const service = new ConversationService(new InMemoryConversationRepo() as any);

  it('appends and retrieves messages', async () => {
    const threadId = randomUUID();
    const userId = 'user-conv';

    await service.appendMessage({
      threadId,
      role: 'user',
      content: 'Hello domain layer',
      userId,
    });

    const history = await service.getThreadHistory(threadId, 10);
    expect(history).toHaveLength(1);
    expect(history[0].content).toBe('Hello domain layer');

    const info = await service.getThreadInfo(threadId);
    expect(info.messageCount).toBe(1);
    expect(info.latestMessage?.content).toBe('Hello domain layer');
  });

  it('verifies hash chain result structure', async () => {
    const result = await service.verifyHashChain(randomUUID());
    expect(result.isValid).toBe(true);
    expect(result.message).toBe('Chain intact');
  });
});


