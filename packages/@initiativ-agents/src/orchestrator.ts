/**
 * Agent orchestrator using LangChain
 */

import { ChatAnthropic } from '@langchain/anthropic';
import { AgentExecutor, createToolCallingAgent } from 'langchain/agents';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import type { BaseLanguageModel } from '@langchain/core/language_models/base';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { AgentConfig, AgentResponse } from './types.js';

export class AgentOrchestrator {
  private llm: ChatAnthropic;
  private agent?: AgentExecutor;
  private tools: StructuredToolInterface[];

  constructor(config: AgentConfig) {
    this.llm = new ChatAnthropic({
      anthropicApiKey: config.apiKey,
      modelName: config.model || 'claude-3-haiku-20240307',
      temperature: config.temperature ?? 0,
      maxTokens: config.maxTokens
    });

    this.tools = [];
  }

  /**
   * Register tools for the agent
   */
  registerTools(tools: StructuredToolInterface[]): void {
    this.tools = tools;
  }

  /**
   * Initialize the agent with tools
   */
  async initialize(): Promise<void> {
    if (this.tools.length === 0) {
      throw new Error('No tools registered. Call registerTools() first.');
    }

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', `You are a helpful AI assistant with access to the user's knowledge base and tools.

Your role is to:
- Help the user organize their thoughts and notes
- Search through their knowledge base when relevant
- Create new notes to capture important information
- Manage conversation branches for focused work
- Extract and remember user preferences

Always use tools when appropriate. Be concise and helpful.`],
      ['placeholder', '{chat_history}'],
      ['human', '{input}'],
      ['placeholder', '{agent_scratchpad}']
    ]);

    const agent = await createToolCallingAgent({
      llm: this.llm as BaseLanguageModel,
      tools: this.tools,
      prompt
    });

    this.agent = new AgentExecutor({
      agent,
      tools: this.tools,
      verbose: false
    });
  }

  /**
   * Execute agent with user input
   */
  async execute(input: string, chatHistory?: Array<{ role: string; content: string }>): Promise<AgentResponse> {
    if (!this.agent) {
      throw new Error('Agent not initialized. Call initialize() first.');
    }

    const result = await this.agent.invoke({
      input,
      chat_history: chatHistory || []
    });

    return {
      content: result.output,
      stopReason: result.stopReason
    };
  }

  /**
   * Simple enrichment methods (no LangChain overhead for basic tasks)
   */

  /**
   * Generate tags for content (simple prompt, no tools)
   */
  async generateTags(content: string, maxTags: number = 5): Promise<string[]> {
    const prompt = `Extract ${maxTags} relevant tags from this note. Return ONLY the tags as a JSON array, nothing else.

Note:
${content.substring(0, 2000)}

Tags (JSON array):`;

    const response = await this.llm.invoke(prompt);
    const text = response.content.toString();

    try {
      // Try to extract JSON array from response
      const jsonMatch = text.match(/\[[\s\S]*?\]/);
      if (jsonMatch) {
        const tags = JSON.parse(jsonMatch[0]) as string[];
        return tags.slice(0, maxTags);
      }
      
      // Fallback: split by comma
      return text
        .split(',')
        .map(tag => tag.trim().replace(/["\[\]]/g, ''))
        .filter(tag => tag.length > 0)
        .slice(0, maxTags);
    } catch {
      return [];
    }
  }

  /**
   * Generate title for content (simple prompt, no tools)
   */
  async generateTitle(content: string, maxLength: number = 60): Promise<string> {
    const prompt = `Generate a short, descriptive title (max ${maxLength} chars) for this note. Return ONLY the title, nothing else.

Note:
${content.substring(0, 1000)}

Title:`;

    const response = await this.llm.invoke(prompt);
    let title = response.content.toString().trim();

    // Remove quotes if present
    title = title.replace(/^["']|["']$/g, '');

    // Truncate if too long
    if (title.length > maxLength) {
      title = title.substring(0, maxLength - 3) + '...';
    }

    return title || 'Untitled';
  }
}

