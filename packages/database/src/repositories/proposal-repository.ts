/**
 * Proposal Repository
 * 
 * SPECIAL CASE: Proposals do NOT emit events.
 * Proposals ARE part of the event flow (requested → validated state),
 * so emitting events for proposals would be redundant.
 */

import { eq, and, desc } from 'drizzle-orm';
import { proposals } from '../schema/index.js';

export interface CreateProposalInput {
  workspaceId: string;
  targetType: string;
  targetId: string;
  request: Record<string, unknown>;
  status?: string;
}

export interface UpdateProposalInput {
  status?: string;
  reviewedBy?: string;
  reviewedAt?: Date;
  rejectionReason?: string;
}

export class ProposalRepository {
  constructor(private db: any) {}

  /**
   * Create a new proposal
   * NO EVENT EMISSION - proposals are part of the event flow
   */
  async create(data: CreateProposalInput): Promise<any> {
    const [proposal] = await this.db
      .insert(proposals)
      .values({
        ...data,
        status: data.status || 'pending',
      })
      .returning();

    return proposal;
  }

  /**
   * Update proposal status
   * NO EVENT EMISSION
   */
  async update(id: string, data: UpdateProposalInput): Promise<any> {
    const [proposal] = await this.db
      .update(proposals)
      .set({
        ...data,
        updatedAt: new Date(),
      })
      .where(eq(proposals.id, id))
      .returning();

    if (!proposal) {
      throw new Error('Proposal not found');
    }

    return proposal;
  }

  /**
   * Delete a proposal
   * NO EVENT EMISSION
   */
  async delete(id: string): Promise<void> {
    const result = await this.db
      .delete(proposals)
      .where(eq(proposals.id, id))
      .returning();

    if (result.length === 0) {
      throw new Error('Proposal not found');
    }
  }

  /**
   * Find proposals by workspace
   */
  async findByWorkspace(
    workspaceId: string,
    status?: string,
  ): Promise<any[]> {
    const conditions = [eq(proposals.workspaceId, workspaceId)];

    if (status) {
      conditions.push(eq(proposals.status, status));
    }

    return this.db.query.proposals.findMany({
      where: and(...conditions),
      orderBy: [desc(proposals.createdAt)],
    });
  }

  /**
   * Find proposals by target
   */
  async findByTarget(targetType: string, targetId: string): Promise<any[]> {
    return this.db.query.proposals.findMany({
      where: and(
        eq(proposals.targetType, targetType),
        eq(proposals.targetId, targetId),
      ),
      orderBy: [desc(proposals.createdAt)],
    });
  }

  /**
   * Find proposal by ID
   */
  async findById(id: string): Promise<any | null> {
    return this.db.query.proposals.findFirst({
      where: eq(proposals.id, id),
    });
  }

  /**
   * Approve proposal (update status to validated)
   */
  async approve(id: string, reviewedBy: string): Promise<any> {
    return this.update(id, {
      status: 'validated',
      reviewedBy,
      reviewedAt: new Date(),
    });
  }

  /**
   * Reject proposal
   */
  async reject(
    id: string,
    reviewedBy: string,
    reason: string,
  ): Promise<any> {
    return this.update(id, {
      status: 'rejected',
      reviewedBy,
      reviewedAt: new Date(),
      rejectionReason: reason,
    });
  }
}
