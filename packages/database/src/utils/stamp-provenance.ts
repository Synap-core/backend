/**
 * Canonical provenance stamping — the single derivation used by every write
 * path that records who/what created a row (Wave B3 columns: createdByKind,
 * createdByUserId, agentUserId, sourceProposalId, correlationId).
 */

import type { ProvenanceKind } from "../schema/provenance.js";
import { getActingAgentUserId } from "./request-write-context.js";

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
 *
 * With neither an agent nor an override, the agent acting in this request
 * (`getActingAgentUserId()`, entered at the key-auth doors) is the author: a
 * composite write (the capture graph's internal callers) carries no
 * `agentUserId` of its own and was stamped 'human' (ticket 63a0c0d8).
 */
export function stampProvenance(input: StampProvenanceInput): ProvenanceStamp {
  const {
    userId,
    agentUserId,
    sourceProposalId,
    correlationId,
    createdByKind,
  } = input;
  const agent =
    agentUserId ?? (createdByKind ? undefined : getActingAgentUserId());
  return {
    createdByKind: createdByKind ?? (agent ? "ai_agent" : "human"),
    createdByUserId: userId,
    agentUserId: agent,
    sourceProposalId,
    correlationId,
  };
}
