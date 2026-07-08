/**
 * Canonical provenance stamping — the single derivation used by every write
 * path that records who/what created a row (Wave B3 columns: createdByKind,
 * createdByUserId, agentUserId, sourceProposalId, correlationId).
 */

import type { ProvenanceKind } from "../schema/provenance.js";

export interface StampProvenanceInput {
  userId: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;
  /** Explicit override — defaults to the derived kind when omitted. */
  createdByKind?: ProvenanceKind;
}

export interface ProvenanceStamp {
  createdByKind: ProvenanceKind;
  createdByUserId: string;
  agentUserId?: string;
  sourceProposalId?: string;
  correlationId?: string;
}

/**
 * Derive the canonical provenance block: createdByKind defaults to
 * 'ai_agent' when agentUserId is present, else 'human' — unless the caller
 * passes an explicit override (e.g. 'system' for pod-provisioning writes).
 */
export function stampProvenance(input: StampProvenanceInput): ProvenanceStamp {
  const {
    userId,
    agentUserId,
    sourceProposalId,
    correlationId,
    createdByKind,
  } = input;
  return {
    createdByKind: createdByKind ?? (agentUserId ? "ai_agent" : "human"),
    createdByUserId: userId,
    agentUserId,
    sourceProposalId,
    correlationId,
  };
}
