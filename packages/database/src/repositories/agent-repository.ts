/**
 * Agent Repository
 *
 * Manages AI agent configurations (system and user-created).
 * Standalone implementation for agent CRUD operations.
 */

import { eq, and, desc, or } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { agents, type Agent } from "../schema/agents.js";
import { EventRepository } from "./event-repository.js";

export interface CreateAgentData {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  userId?: string;
  llmProvider?: "claude" | "openai" | "ollama" | "gemini";
  llmModel: string;
  capabilities: string[];
  systemPrompt: string;
  toolsConfig?: Record<string, unknown>;
  executionMode?: "simple" | "react" | "langgraph";
  maxIterations?: number;
  timeoutSeconds?: number;
  weight?: string;
  performanceMetrics?: Record<string, unknown>;
  active?: boolean;
}

export interface UpdateAgentData {
  name?: string;
  description?: string;
  llmProvider?: "claude" | "openai" | "ollama" | "gemini";
  llmModel?: string;
  capabilities?: string[];
  systemPrompt?: string;
  toolsConfig?: Record<string, unknown>;
  executionMode?: "simple" | "react" | "langgraph";
  maxIterations?: number;
  timeoutSeconds?: number;
  weight?: string;
  performanceMetrics?: Record<string, unknown>;
  active?: boolean;
}

export class AgentRepository {
  private eventRepo: EventRepository;

  constructor(private db: NodePgDatabase<any>) {
    this.eventRepo = new EventRepository(db as any);
  }

  /**
   * Create a new agent
   */
  async create(data: CreateAgentData, userId: string): Promise<Agent> {
    const [agent] = await this.db
      .insert(agents)
      .values({
        id: data.id,
        name: data.name,
        description: data.description,
        createdBy: data.createdBy,
        userId: data.userId,
        llmProvider: data.llmProvider || "claude",
        llmModel: data.llmModel,
        capabilities: data.capabilities,
        systemPrompt: data.systemPrompt,
        toolsConfig: data.toolsConfig,
        executionMode: data.executionMode || "simple",
        maxIterations: data.maxIterations || 5,
        timeoutSeconds: data.timeoutSeconds || 30,
        weight: data.weight || "1.0",
        performanceMetrics: data.performanceMetrics,
        active: data.active !== undefined ? data.active : true,
      })
      .returning();

    await this.emitCompleted("create", agent.id, userId);
    return agent;
  }

  /**
   * Update an agent
   */
  async update(
    id: string,
    data: UpdateAgentData,
    userId: string
  ): Promise<Agent> {
    const [agent] = await this.db
      .update(agents)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(agents.id, id))
      .returning();

    if (!agent) {
      throw new Error(`Agent ${id} not found`);
    }

    await this.emitCompleted("update", id, userId);
    return agent;
  }

  /**
   * Delete an agent
   */
  async delete(id: string, userId: string): Promise<void> {
    await this.db
      .update(agents)
      .set({ active: false, updatedAt: new Date() })
      .where(eq(agents.id, id));

    await this.emitCompleted("delete", id, userId);
  }

  /**
   * Get agent by ID
   */
  async getById(id: string): Promise<Agent | null> {
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(eq(agents.id, id))
      .limit(1);
    return agent || null;
  }

  /**
   * List all active agents (system + user's custom agents)
   */
  async listActive(userId?: string): Promise<Agent[]> {
    const conditions = [eq(agents.active, true)];

    if (userId) {
      // Include system agents and user's custom agents
      conditions.push(
        or(eq(agents.createdBy, "system"), eq(agents.userId, userId))!
      );
    } else {
      // Only system agents
      conditions.push(eq(agents.createdBy, "system"));
    }

    return await this.db
      .select()
      .from(agents)
      .where(and(...conditions))
      .orderBy(desc(agents.createdAt));
  }

  /**
   * List user's custom agents
   */
  async listByUser(userId: string): Promise<Agent[]> {
    return await this.db
      .select()
      .from(agents)
      .where(eq(agents.userId, userId))
      .orderBy(desc(agents.createdAt));
  }

  /**
   * Emit completed event
   */
  private async emitCompleted(
    action: "create" | "update" | "delete",
    agentId: string,
    userId: string
  ): Promise<void> {
    await this.eventRepo.append({
      id: crypto.randomUUID(),
      version: "v1",
      type: `agents.${action}.completed`,
      subjectId: agentId,
      subjectType: "agent",
      data: { id: agentId },
      userId,
      source: "api",
      timestamp: new Date(),
      metadata: {},
    });
  }
}
