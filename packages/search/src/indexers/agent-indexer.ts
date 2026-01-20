/**
 * Agent Indexer
 */

import { BaseIndexer } from "./base-indexer.js";
import type { SearchDocument } from "../types/index.js";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  systemPrompt: string | null;
  userId: string;
  workspaceId: string;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export class AgentIndexer extends BaseIndexer<Agent> {
  collectionName = "agents";

  async toSearchDocument(agent: Agent): Promise<SearchDocument> {
    const doc: SearchDocument = {
      id: agent.id,
      name: agent.name,
      description: agent.description || undefined,
      systemPrompt: agent.systemPrompt || undefined,
      userId: agent.userId,
      workspaceId: agent.workspaceId,
      isSystem: agent.isSystem,
      createdAt: this.toTimestamp(agent.createdAt),
      updatedAt: this.toTimestamp(agent.updatedAt),
      usageCount: 0, // TODO: Track from analytics
      lastAccessedAt: undefined,
    };

    this.validateDocument(doc);
    return doc;
  }
}
