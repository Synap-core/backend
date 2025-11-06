/**
 * Conversational Agent - The Brain of Synap
 * 
 * V0.4: AI-powered conversation with action suggestion
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt } from './prompts.js';

// ============================================================================
// TYPES
// ============================================================================

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AgentResponse {
  content: string;
  model: string;
  tokens: {
    input: number;
    output: number;
    total: number;
  };
  latency: number;
  rawResponse?: any;
}

export interface AgentConfig {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// ============================================================================
// CONVERSATIONAL AGENT
// ============================================================================

export class ConversationalAgent {
  private client: Anthropic;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: AgentConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
    });
    
    this.model = config.model || 'claude-3-haiku-20240307'; // Claude 3 Haiku (fast & cheap)
    this.maxTokens = config.maxTokens || 2048;
    this.temperature = config.temperature || 0.7;
  }

  /**
   * Generate AI response based on conversation history
   */
  async generateResponse(
    history: ConversationMessage[],
    userMessage: string,
    context?: {
      userName?: string;
      recentEntities?: Array<{ type: string; title: string }>;
    }
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    
    // Build system prompt with context
    const systemPrompt = getSystemPrompt({
      userName: context?.userName,
      recentEntities: context?.recentEntities,
      currentDate: new Date(),
    });
    
    // Format messages for Anthropic API
    const messages: Anthropic.MessageParam[] = [
      // Add conversation history
      ...history.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: msg.content,
      })),
      // Add new user message
      {
        role: 'user' as const,
        content: userMessage,
      },
    ];
    
    try {
      // Call Anthropic API
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        system: systemPrompt,
        messages,
      });
      
      const latency = Date.now() - startTime;
      
      // Extract text content
      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => (block as Anthropic.TextBlock).text)
        .join('\n');
      
      return {
        content,
        model: response.model,
        tokens: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
          total: response.usage.input_tokens + response.usage.output_tokens,
        },
        latency,
        rawResponse: response,
      };
      
    } catch (error) {
      console.error('❌ Anthropic API error:', error);
      throw new Error(
        `Failed to generate AI response: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Generate response with streaming (for future real-time UI)
   */
  async *generateResponseStream(
    history: ConversationMessage[],
    userMessage: string,
    context?: {
      userName?: string;
      recentEntities?: Array<{ type: string; title: string }>;
    }
  ): AsyncGenerator<string, void, unknown> {
    const systemPrompt = getSystemPrompt({
      userName: context?.userName,
      recentEntities: context?.recentEntities,
      currentDate: new Date(),
    });
    
    const messages: Anthropic.MessageParam[] = [
      ...history.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: msg.content,
      })),
      {
        role: 'user' as const,
        content: userMessage,
      },
    ];
    
    const stream = await this.client.messages.stream({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      system: systemPrompt,
      messages,
    });
    
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        yield chunk.delta.text;
      }
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

let _agent: ConversationalAgent | null = null;

export function getConversationalAgent(): ConversationalAgent {
  if (!_agent) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required');
    }
    
    _agent = new ConversationalAgent({
      apiKey,
      model: 'claude-3-haiku-20240307',  // Fast & cheap for conversation
      maxTokens: 2048,
      temperature: 0.7,
    });
  }
  
  return _agent;
}

export const conversationalAgent = getConversationalAgent();

