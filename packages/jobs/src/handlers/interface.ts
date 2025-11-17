/**
 * Event Handler Interface - Phase 2: Worker Layer
 * 
 * Defines the contract that all event handlers must implement.
 * Handlers are responsible for reacting to specific event types
 * and executing business logic in a decoupled, retryable way.
 */

import type { SynapEvent } from '@synap/types';

/**
 * Inngest Step Runner
 * 
 * Provides retry-safe execution context for handler operations.
 * Each step.run() call is independently retryable by Inngest.
 */
export type InngestStep = {
  run<T>(name: string, handler: () => Promise<T> | T): Promise<T>;
};

/**
 * Handler Result
 * 
 * Standard return type for all event handlers.
 * Indicates success/failure and provides optional message.
 */
export interface HandlerResult {
  success: boolean;
  message: string;
  error?: string;
}

/**
 * Event Handler Interface
 * 
 * All event handlers must implement this interface.
 * 
 * @example
 * ```typescript
 * export class MyHandler implements IEventHandler {
 *   eventType = 'my.event.type';
 *   
 *   async handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult> {
 *     await step.run('do-work', async () => {
 *       // Business logic here
 *     });
 *     return { success: true, message: 'Work completed' };
 *   }
 * }
 * ```
 */
export interface IEventHandler {
  /**
   * The event type this handler subscribes to
   * 
   * Examples:
   * - 'note.creation.requested'
   * - 'note.creation.completed'
   * - 'task.completed'
   */
  eventType: SynapEvent['type'] | string;

  /**
   * Handle the event
   * 
   * This method is called by the dispatcher when an event of matching type is received.
   * All business logic should be wrapped in step.run() calls for retry safety.
   * 
   * @param event - The SynapEvent to handle
   * @param step - Inngest step runner for retry-safe operations
   * @returns HandlerResult indicating success/failure
   */
  handle(event: SynapEvent, step: InngestStep): Promise<HandlerResult>;
}

