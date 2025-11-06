/**
 * @initiativ/memory
 * Custom memory layer for Initiativ Core
 * 
 * Extracts and stores user facts/preferences from conversation history
 * Simple implementation (~50-100 lines) - no external dependencies
 */

import Anthropic from '@anthropic-ai/sdk';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface Fact {
  id: string;
  fact: string;
  confidence: number;
  sourceThread?: string;
  extractedAt: string;
  category?: string;
}

export interface MemoryConfig {
  apiKey: string;
  model?: string;
}

export class UserMemory {
  private anthropic: Anthropic;
  private model: string;
  private facts: Map<string, Fact>;

  constructor(config: MemoryConfig) {
    this.anthropic = new Anthropic({ apiKey: config.apiKey });
    this.model = config.model || 'claude-3-haiku-20240307'; // Use cheap model for fact extraction
    this.facts = new Map();
  }

  /**
   * Extract facts from conversation messages
   */
  async extractFacts(messages: Message[], threadId?: string): Promise<Fact[]> {
    if (messages.length === 0) {
      return [];
    }

    // Build conversation context
    const conversationContext = messages
      .map(m => `${m.role}: ${m.content}`)
      .join('\n\n');

    const prompt = `Analyze this conversation and extract user facts, preferences, or important information.

Conversation:
${conversationContext}

Extract facts in JSON format. Each fact should be:
- A clear statement about the user
- Something that could be useful in future conversations
- High confidence (not speculation)

Return JSON array:
[
  {
    "fact": "User prefers simple design over complex",
    "confidence": 0.9,
    "category": "preferences"
  }
]

If no clear facts, return empty array [].`;

    try {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: prompt
        }]
      });

      const textContent = response.content[0].type === 'text' 
        ? response.content[0].text 
        : '';

      // Parse JSON from response
      const jsonMatch = textContent.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const extractedFacts = JSON.parse(jsonMatch[0]) as Array<{
        fact: string;
        confidence: number;
        category?: string;
      }>;

      // Convert to Fact objects and store
      const facts: Fact[] = [];
      for (const extracted of extractedFacts) {
        const fact: Fact = {
          id: this.generateId(),
          fact: extracted.fact,
          confidence: extracted.confidence,
          sourceThread: threadId,
          extractedAt: new Date().toISOString(),
          category: extracted.category
        };

        this.facts.set(fact.id, fact);
        facts.push(fact);
      }

      return facts;
    } catch (error) {
      console.error('Failed to extract facts:', error);
      return [];
    }
  }

  /**
   * Get all stored facts
   */
  getFacts(query?: string): Fact[] {
    const allFacts = Array.from(this.facts.values());

    if (!query) {
      return allFacts;
    }

    // Simple keyword search
    const queryLower = query.toLowerCase();
    return allFacts.filter(f => 
      f.fact.toLowerCase().includes(queryLower) ||
      f.category?.toLowerCase().includes(queryLower)
    );
  }

  /**
   * Get fact by ID
   */
  getFact(id: string): Fact | undefined {
    return this.facts.get(id);
  }

  /**
   * Remove fact
   */
  removeFact(id: string): void {
    this.facts.delete(id);
  }

  /**
   * Clear all facts
   */
  clear(): void {
    this.facts.clear();
  }

  /**
   * Get facts count
   */
  size(): number {
    return this.facts.size;
  }

  /**
   * Generate unique ID for fact
   */
  private generateId(): string {
    return `fact_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }
}

