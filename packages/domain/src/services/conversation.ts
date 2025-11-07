import { conversationRepository, MessageRole as RepoMessageRole } from '@synap/database';
import {
  AppendConversationMessageInputSchema,
  ConversationMessageSchema,
  ConversationThreadInfoSchema,
  ConversationThreadSummarySchema,
  HashVerificationSchema,
  type AppendConversationMessageInput,
  type ConversationMessage,
  type ConversationThreadInfo,
  type ConversationThreadSummary,
  type HashVerificationResult,
} from '../types.js';

const messageRoleMap: Record<string, RepoMessageRole> = {
  user: RepoMessageRole.USER,
  assistant: RepoMessageRole.ASSISTANT,
  system: RepoMessageRole.SYSTEM,
};

export class ConversationService {
  constructor(private readonly repo = conversationRepository) {}

  async appendMessage(input: AppendConversationMessageInput): Promise<ConversationMessage> {
    const parsed = AppendConversationMessageInputSchema.parse(input);
    const record = await this.repo.appendMessage({
      ...parsed,
      role: messageRoleMap[parsed.role],
    });
    return ConversationMessageSchema.parse(record);
  }

  async getThreadHistory(threadId: string, limit = 100): Promise<ConversationMessage[]> {
    const messages = await this.repo.getThreadHistory(threadId, limit);
    return messages.map((message) => ConversationMessageSchema.parse(message));
  }

  async getThreadInfo(threadId: string): Promise<ConversationThreadInfo> {
    const info = await this.repo.getThreadInfo(threadId);
    return ConversationThreadInfoSchema.parse(info);
  }

  async getUserThreads(userId: string, limit = 20): Promise<ConversationThreadSummary[]> {
    const threads = await this.repo.getUserThreads(userId, limit);
    return threads.map((thread) => ConversationThreadSummarySchema.parse(thread));
  }

  async createBranch(parentMessageId: string, userId: string): Promise<string> {
    return this.repo.createBranch(parentMessageId, userId);
  }

  async getBranches(parentId: string): Promise<ConversationMessage[]> {
    const branches = await this.repo.getBranches(parentId);
    return branches.map((message) => ConversationMessageSchema.parse(message));
  }

  async verifyHashChain(threadId: string): Promise<HashVerificationResult> {
    const result = await this.repo.verifyHashChain(threadId);
    return HashVerificationSchema.parse(result);
  }

  async deleteMessage(messageId: string, userId: string): Promise<void> {
    await this.repo.deleteMessage(messageId, userId);
  }
}

export const conversationService = new ConversationService();


