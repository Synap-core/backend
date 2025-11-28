/**
 * Conversational Agent Base Class
 * 
 * Base class for creating conversational agents in the Data Pod.
 * Plugins can extend this to create custom conversational experiences.
 * 
 * @example
 * ```typescript
 * export class MyConversationalAgent extends ConversationalAgent {
 *   async processMessage(message: string, context: ConversationContext) {
 *     // Your logic here
 *     return { response: 'Hello!', actions: [] };
 *   }
 * }
 * ```
 */

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: Date;
}

export interface ConversationContext {
  userId: string;
  conversationId?: string;
  history?: ConversationMessage[];
  metadata?: Record<string, unknown>;
}

export interface ConversationResponse {
  response: string;
  actions?: Array<{ type: string; data: unknown }>;
  metadata?: Record<string, unknown>;
}

/**
 * Abstract base class for conversational agents
 */
export abstract class ConversationalAgent {
  protected history: ConversationMessage[] = [];

  /**
   * Process a user message and generate a response
   */
  abstract processMessage(
    message: string,
    context: ConversationContext
  ): Promise<ConversationResponse>;

  /**
   * Add a message to the conversation history
   */
  protected addToHistory(message: ConversationMessage): void {
    this.history.push({
      ...message,
      timestamp: message.timestamp || new Date(),
    });
  }

  /**
   * Get conversation history
   */
  getHistory(): ConversationMessage[] {
    return [...this.history];
  }

  /**
   * Clear conversation history
   */
  clearHistory(): void {
    this.history = [];
  }

  /**
   * Initialize the agent (optional hook)
   */
  async initialize?(): Promise<void>;

  /**
   * Cleanup resources (optional hook)
   */
  async destroy?(): Promise<void>;
}
