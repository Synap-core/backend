/**
 * Business Facade - Couche 2: Façade Métier
 * 
 * High-level convenience methods that abstract the event-driven architecture.
 * These methods provide a simple, semantic API for common operations.
 */

import type { TRPCClient } from '@trpc/client';
import type { AppRouter } from './types.js';

export { ContentFacade } from './facades/content.js';
export { CapabilitiesFacade } from './facades/capabilities.js';

/**
 * Business Facade for Notes
 */
export class NotesFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * Create a note
   * 
   * @example
   * ```typescript
   * const result = await synap.notes.create({
   *   content: '# My Note\n\nContent here',
   *   title: 'My Note',
   * });
   * ```
   */
  async create(input: {
    content: string;
    title?: string;
    tags?: string[];
  }): Promise<{
    success: boolean;
    status: 'pending';
    requestId: string;
    entityId: string;
  }> {
    const notesRouter = this.rpc.notes as any;
    return notesRouter.create.mutate(input);
  }

  /**
   * List notes
   */
  async list(options?: {
    limit?: number;
    offset?: number;
    type?: 'note' | 'task' | 'all';
  }): Promise<Array<{
    id: string;
    title: string | null;
    preview: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>> {
    const notesRouter = this.rpc.notes as any;
    return notesRouter.list.query(options || {});
  }

  /**
   * Get a note by ID
   */
  async get(id: string): Promise<{
    id: string;
    title: string | null;
    preview: string | null;
    content?: string;
    fileUrl?: string;
    createdAt: Date;
    updatedAt: Date;
  }> {
    const notesRouter = this.rpc.notes as any;
    return notesRouter.get.query({ id });
  }
}

/**
 * Business Facade for Chat
 */
export class ChatFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * Send a message to the AI assistant
   * 
   * @example
   * ```typescript
   * const result = await synap.chat.sendMessage({
   *   content: 'Create a note about AI',
   *   threadId: 'thread-123',
   * });
   * ```
   */
  async sendMessage(input: {
    content: string;
    threadId?: string;
    parentId?: string;
  }): Promise<{
    success: boolean;
    status: 'pending';
    requestId: string;
    threadId: string;
    websocketUrl: string;
  }> {
    const chatRouter = this.rpc.chat as any;
    return chatRouter.sendMessage.mutate(input);
  }

  /**
   * Get thread history
   */
  async getThread(threadId: string): Promise<{
    id: string;
    messages: Array<{
      id: string;
      role: 'user' | 'assistant';
      content: string;
      createdAt: Date;
    }>;
  }> {
    const chatRouter = this.rpc.chat as any;
    return chatRouter.getThread.query({ threadId });
  }

  /**
   * List all threads
   */
  async listThreads(): Promise<Array<{
    id: string;
    preview: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>> {
    const chatRouter = this.rpc.chat as any;
    return chatRouter.listThreads.query();
  }
}

/**
 * Business Facade for Tasks
 * 
 * Note: Tasks are managed through the events API in the current architecture.
 * This facade provides convenience methods that abstract the event-driven flow.
 */
export class TasksFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * Complete a task
   * 
   * This is a convenience method that publishes a task.completion.requested event.
   * 
   * @example
   * ```typescript
   * await synap.tasks.complete('task-123');
   * ```
   */
  async complete(taskId: string): Promise<{
    success: boolean;
    eventId: string;
  }> {
    // Publish task completion event
    const eventsRouter = this.rpc.events as any;
    return eventsRouter.log.mutate({
      eventType: 'task.completion.requested',
      data: {
        entityId: taskId,
      },
    });
  }
}

/**
 * Business Facade for Capture
 */
export class CaptureFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * Capture a raw thought
   * 
   * The AI will analyze the thought and create appropriate entities.
   * 
   * @example
   * ```typescript
   * await synap.capture.thought('I need to remember to buy milk');
   * ```
   */
  async thought(content: string, context?: Record<string, unknown>): Promise<{
    success: boolean;
    message: string;
  }> {
    const captureRouter = this.rpc.capture as any;
    return captureRouter.thought.mutate({
      content,
      context,
    });
  }
}

/**
 * Business Facade for System
 */
export class SystemFacade {
  constructor(private rpc: TRPCClient<AppRouter>) {}

  /**
   * Health check
   */
  async health(): Promise<{
    status: string;
    timestamp: string;
  }> {
    const systemRouter = this.rpc.system as any;
    return systemRouter.health.query();
  }

  /**
   * Get system information
   */
  async info(): Promise<{
    version: string;
    environment: string;
    database: {
      dialect: string;
      connected: boolean;
    };
    storage: {
      provider: string;
      configured: boolean;
    };
  }> {
    const systemRouter = this.rpc.system as any;
    return systemRouter.info.query();
  }
}

