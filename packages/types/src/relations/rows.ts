/**
 * The relation row on the wire (`relations` table) as the pod reads and
 * inserts it.
 *
 * The pod's type is inferred from its drizzle table; this package cannot see
 * that table, so the wire shape is declared here and `@synap/database` proves
 * it equal to the inferred one (`src/wire-parity/relations.ts`): a column added
 * on one side only fails the database build.
 */

import type { ProvenanceKind } from "../documents/rows.js";

/** What a relation endpoint points at: an entity, or a cell instance. */
export type RelationEndpointKind = "entity" | "cell";

export interface Relation {
  id: string;
  userId: string;
  workspaceId: string | null;
  sourceEntityId: string | null;
  targetEntityId: string | null;
  sourceKind: RelationEndpointKind;
  targetKind: RelationEndpointKind;
  sourceCellId: string | null;
  targetCellId: string | null;
  type: string;
  metadata: unknown;
  createdByKind: ProvenanceKind | null;
  createdByUserId: string | null;
  agentUserId: string | null;
  sourceProposalId: string | null;
  correlationId: string | null;
  createdAt: Date;
}

export interface NewRelation {
  id?: string;
  userId: string;
  workspaceId?: string | null;
  sourceEntityId?: string | null;
  targetEntityId?: string | null;
  sourceKind?: RelationEndpointKind;
  targetKind?: RelationEndpointKind;
  sourceCellId?: string | null;
  targetCellId?: string | null;
  type: string;
  metadata?: unknown;
  createdByKind?: ProvenanceKind | null;
  createdByUserId?: string | null;
  agentUserId?: string | null;
  sourceProposalId?: string | null;
  correlationId?: string | null;
  createdAt?: Date;
}
