/**
 * Conversational Agent - Provider agnostic orchestration layer
 */

import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { getSystemPrompt } from './prompts.js';
import { createChatModel } from './providers/chat.js';
import { extractTokenUsage, messageContentToString } from './providers/utils.js';

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
  rawResponse?: unknown;
}

export interface AgentConfig {
  provider: 'anthropic' | 'openai';
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

// ============================================================================
// CONVERSATIONAL AGENT
// ============================================================================

export class ConversationalAgent {
  private readonly provider: AgentConfig['provider'];
  private readonly model?: string;
  private readonly maxTokens: number;
  private readonly temperature: number;

  constructor(config: AgentConfig) {
    this.provider = config.provider;
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 2048;
    this.temperature = config.temperature ?? 0.7;
  }

  private buildMessageSequence(
    systemPrompt: string,
    history: ConversationMessage[],
    userMessage: string
  ): Array<SystemMessage | AIMessage | HumanMessage> {
    const sequence: Array<SystemMessage | AIMessage | HumanMessage> = [
      new SystemMessage(systemPrompt),
    ];

    for (const snippet of history) {
      if (snippet.role === 'assistant') {
        sequence.push(new AIMessage(snippet.content));
      } else if (snippet.role === 'system') {
        sequence.push(new SystemMessage(snippet.content));
      } else {
        sequence.push(new HumanMessage(snippet.content));
      }
    }

    sequence.push(new HumanMessage(userMessage));
    return sequence;
  }

  async generateResponse(
    history: ConversationMessage[],
    userMessage: string,
    context?: {
      userName?: string;
      recentEntities?: Array<{ type: string; title: string }>;
    }
  ): Promise<AgentResponse> {
    const startTime = Date.now();

    const systemPrompt = getSystemPrompt({
      userName: context?.userName,
      recentEntities: context?.recentEntities,
      currentDate: new Date(),
    });

    const messages = this.buildMessageSequence(systemPrompt, history, userMessage);
    const chatModel = createChatModel({
      purpose: 'chat',
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      streaming: false,
    });

    const response = await chatModel.invoke(messages);
    const latency = Date.now() - startTime;

    const content = messageContentToString(response);
    const metadata = (response as any).response_metadata ?? (response as any).usage_metadata ?? {};
    const usage = extractTokenUsage(metadata);
    const resolvedModel =
      (metadata && typeof metadata === 'object' && 'model' in metadata
        ? (metadata as Record<string, string>).model
        : undefined) ?? this.model ?? this.provider;

    return {
      content,
      model: resolvedModel,
      tokens: usage,
      latency,
      rawResponse: response,
    };
  }

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

    const messages = this.buildMessageSequence(systemPrompt, history, userMessage);
    const chatModel = createChatModel({
      purpose: 'chat',
      model: this.model,
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      streaming: true,
    });

    const stream = await chatModel.stream(messages);
    for await (const chunk of stream) {
      const delta = messageContentToString(chunk);
      if (delta.length > 0) {
        yield delta;
      }
    }
  }
}

// ============================================================================
// SINGLETON EXPORT
// ============================================================================

let coreModule: typeof import('@synap/core') | null = null;
let _aiConfig: typeof import('@synap/core')['config']['ai'] | null = null;

async function loadCore() {
  if (!coreModule) {
    coreModule = await import('@synap/core');
    _aiConfig = coreModule.config.ai;
  }
  return coreModule!;
}

function getAISettings() {
  if (!_aiConfig) {
    // Config not loaded yet - this should not happen in practice
    // but we'll throw a helpful error
    throw new Error(
      'AI config not loaded. Please ensure @synap/core is imported before using AI features.'
    );
  }
  return _aiConfig;
}

// Pre-load config in the background
loadCore().catch(() => {
  // Will be loaded on first access
});

let agentSingleton: ConversationalAgent | null = null;

export function getConversationalAgent(): ConversationalAgent {
  if (!agentSingleton) {
    const ai = getAISettings();
    if (ai.provider === 'anthropic') {
      if (!ai.anthropic.apiKey) {
        throw new Error('ANTHROPIC_API_KEY environment variable is required');
      }

      const config = ai.anthropic;
      agentSingleton = new ConversationalAgent({
        provider: 'anthropic',
        model: config.models.chat ?? config.model,
        maxTokens: config.maxOutputTokens,
        temperature: config.temperature,
      });
    } else {
      if (!ai.openai.apiKey) {
        throw new Error('OPENAI_API_KEY environment variable is required');
      }

      const config = ai.openai;
      agentSingleton = new ConversationalAgent({
        provider: 'openai',
        model: config.models.chat ?? config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });
    }
  }

  return agentSingleton;
}

export const conversationalAgent = getConversationalAgent();


