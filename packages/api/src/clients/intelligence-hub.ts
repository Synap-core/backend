/**
 * Intelligence Hub Client
 *
 * REST client for calling Intelligence Hub from Backend
 */

import type {
  HubResponse,
  HubStreamEvent,
  ExtractedEntity,
  BranchDecision,
  TokenUsage,
  AIStep,
} from "@synap-core/types";

export interface IntelligenceHubRequest {
  query: string;
  threadId: string;
  userId: string;
  agentId?: string;
  agentType?: string;
  agentConfig?: Record<string, unknown>;
  projectId?: string;
  // Data Pod credentials for Hub Protocol access
  dataPodUrl?: string;
  dataPodApiKey?: string;
}

// Re-export HubResponse from types package
export type {
  HubResponse,
  ExtractedEntity,
  BranchDecision,
  TokenUsage,
  AIStep,
};

// Legacy interface for backwards compatibility
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IntelligenceHubResponse extends HubResponse {
  // All fields inherited from HubResponse
}

/**
 * Intelligence Hub REST Client
 */
export class IntelligenceHubClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl =
      baseUrl || process.env.INTELLIGENCE_HUB_URL || "http://localhost:3002";
  }

  /**
   * Send message to orchestrator agent
   */
  async sendMessage(
    request: IntelligenceHubRequest
  ): Promise<IntelligenceHubResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/expertise/request`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": process.env.INTELLIGENCE_HUB_API_KEY || "",
        },
        body: JSON.stringify({
          query: request.query,
          threadId: request.threadId,
          userId: request.userId,
          agentId: request.agentId || "orchestrator",
          projectId: request.projectId,
          dataPodUrl:
            request.dataPodUrl ||
            process.env.PUBLIC_URL ||
            "http://localhost:3000",
          dataPodApiKey:
            request.dataPodApiKey || process.env.HUB_PROTOCOL_API_KEY || "",
        }),
      });

      if (!response.ok) {
        throw new Error(`Intelligence Hub error: ${response.statusText}`);
      }

      const data = (await response.json()) as IntelligenceHubResponse;
      return data;
    } catch (error) {
      console.error("Failed to call Intelligence Hub:", error);
      throw error;
    }
  }

  /**
   * Generate embedding for text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": process.env.INTELLIGENCE_HUB_API_KEY || "",
      },
      body: JSON.stringify({ text }),
    });

    if (!response.ok) {
      throw new Error(
        `Intelligence Hub embedding error: ${response.statusText}`
      );
    }

    const data = (await response.json()) as { embedding: number[] };
    return data.embedding;
  }

  /**
   * Send message with streaming support
   */
  async *sendMessageStream(
    request: IntelligenceHubRequest
  ): AsyncGenerator<HubStreamEvent> {
    const response = await fetch(`${this.baseUrl}/api/chat/stream`, {
      // ✅ UPDATED: New endpoint
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-API-Key": process.env.INTELLIGENCE_HUB_API_KEY || "",
      },
      body: JSON.stringify({
        query: request.query,
        threadId: request.threadId,
        userId: request.userId,
        agentId: request.agentId || "orchestrator",
        agentType: request.agentType,
        agentConfig: request.agentConfig,
        projectId: request.projectId,
        stream: true,
        dataPodUrl:
          request.dataPodUrl ||
          process.env.PUBLIC_URL ||
          "http://localhost:3000",
        dataPodApiKey:
          request.dataPodApiKey || process.env.HUB_PROTOCOL_API_KEY || "",
      }),
    });

    if (!response.ok) {
      throw new Error(`Intelligence Hub error: ${response.statusText}`);
    }

    // Parse SSE stream
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) {
      throw new Error("No response body");
    }

    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          yield { type: "complete" };
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));

              if (data.type === "content" && data.content) {
                yield { type: "chunk", content: data.content };
              } else if (data.type === "step" && data.step) {
                yield { type: "step", step: data.step };
              } else if (data.type === "entities" && data.entities) {
                yield { type: "entities", entities: data.entities }; // ✅ ADDED
              } else if (data.type === "branch_decision" && data.decision) {
                yield { type: "branch_decision", decision: data.decision }; // ✅ ADDED
              } else if (data.type === "error") {
                yield { type: "error", error: data.error }; // ✅ ADDED
              } else if (data.type === "complete") {
                yield { type: "complete", data: data.data }; // ✅ FIXED: Include data
              }
            } catch (parseError) {
              console.error("Failed to parse SSE data:", line, parseError);
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/health`);
      return response.ok;
    } catch (error) {
      console.error("Intelligence Hub health check failed:", error);
      return false;
    }
  }
}

// Singleton instance
export const intelligenceHubClient = new IntelligenceHubClient();
