/**
 * Intelligence Hub Client
 * 
 * REST client for calling Intelligence Hub from Backend
 */

export interface IntelligenceHubRequest {
  query: string;
  threadId: string;
  userId: string;
  agentId?: string;
  projectId?: string;
}

export interface IntelligenceHubResponse {
  content: string;
  thinkingSteps: string[];
  entities: Array<{
    type: string;
    title: string;
    description?: string;
    properties?: Record<string, any>;
  }>;
  branchDecision?: {
    shouldBranch: boolean;
    branchType?: string;
    purpose?: string;
    agentId?: string;
    reasoning: string;
  };
  toolCalls?: any[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Intelligence Hub REST Client
 */
export class IntelligenceHubClient {
  private baseUrl: string;
  
  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || process.env.INTELLIGENCE_HUB_URL || 'http://localhost:3002';
  }
  
  /**
   * Send message to orchestrator agent
   */
  async sendMessage(request: IntelligenceHubRequest): Promise<IntelligenceHubResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/expertise/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: request.query,
          threadId: request.threadId,
          userId: request.userId,
          agentId: request.agentId || 'orchestrator',
          projectId: request.projectId,
        }),
      });
      
      if (!response.ok) {
        throw new Error(`Intelligence Hub error: ${response.statusText}`);
      }
      
      const data = await response.json();
      return data;
    } catch (error) {
      console.error('Failed to call Intelligence Hub:', error);
      throw error;
    }
  }
  
  /**
   * Generate embedding for text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    
    if (!response.ok) {
      throw new Error(`Intelligence Hub embedding error: ${response.statusText}`);
    }
    
    const data = await response.json();
    return data.embedding;
  }
  
  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch (error) {
      console.error('Intelligence Hub health check failed:', error);
      return false;
    }
  }
}

// Singleton instance
export const intelligenceHubClient = new IntelligenceHubClient();
