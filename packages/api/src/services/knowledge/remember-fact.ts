/**
 * rememberFact — shared service behind the MCP `synap_remember_fact` tool.
 *
 * A fact about the user is a `user_observation` ENTITY, not a loose row: that
 * profile is the governed home for it (pod-wide, typed `uo_*` properties) and
 * the policy engine already has a rung for it — AI-INFERRED → propose,
 * USER-STATED (`uo_validated === true`) → auto-approve
 * (`governance-policy/src/index.ts` §2.6). So the write goes through the SAME
 * governed door every other entity write uses (`entities.createEntity` on the
 * hub caller, which carries `agentUserId` + `sessionId`), and the fact becomes
 * addressable, linkable and revertible.
 *
 * RECALL (why the `knowledge_facts` row is still written): `ask`'s EPISODIC
 * substrate reads `knowledgeRepository.searchFacts()` — i.e. `knowledge_facts`
 * — and nothing else (`services/knowledge/ask.ts`). Dropping that write would
 * silently kill episodic recall, and a PROPOSED observation materializes no
 * entity at all until a human accepts it, so an entity-only write would leave
 * the fact unrecallable for an unbounded window. The row is therefore kept as a
 * transitional RECALL INDEX, stamped with `sourceEntityId` pointing at the
 * governed record. TECH DEBT: two stores for one fact — retire when the
 * episodic leg reads `user_observation` entities (and only then).
 *
 * Embedding is best-effort through the same path entity/recall writes use
 * (`@synap/ai-embeddings`); on failure it falls back to a zero vector (keyword
 * search still works) rather than failing the write.
 */

import { knowledgeRepository } from "@synap/database";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "remember-fact" });

/** `uo_category` enum — seeded in `ensure-system-profiles.ts`. */
export const USER_OBSERVATION_CATEGORIES = [
  "working_style",
  "communication",
  "focus",
  "preferences",
  "habits",
  "technical",
] as const;

export type UserObservationCategory =
  (typeof USER_OBSERVATION_CATEGORIES)[number];

/**
 * The slice of the Hub-Protocol caller this service needs. Declared structurally
 * (method syntax → bivariant) so the MCP adapter can pass its existing
 * `lensCaller` without this module importing the router type.
 */
export interface RememberFactCaller {
  entities: {
    createEntity(input: {
      userId: string;
      profileSlug?: string;
      title: string;
      description?: string;
      properties?: Record<string, unknown>;
      agentUserId?: string;
      reasoning?: string;
      aiMetadata?: { model?: string; reasoning?: string; confidence?: number };
    }): Promise<{
      status: string;
      message?: string;
      id?: string | null;
      proposalId?: string | null;
      proposalType?: string;
      reviewUrl?: string;
      proposedEntityId?: string;
    }>;
  };
}

export interface RememberFactResult {
  /**
   * BACK-COMPAT: the pre-governance return was `{ success, message }` and
   * existing callers (CLI, skills, Raycast, IS) still branch on it. A QUEUED
   * PROPOSAL IS NOT A FAILURE — it is an accepted governed write awaiting
   * review — so both "created" and "proposed" are `true`; only a refused or
   * failed verdict is `false`. Read `status` for the precise outcome.
   */
  success: boolean;
  /** "created" (auto-approved) | "proposed" (queued for review) | door verdict. */
  status: string;
  /** The `user_observation` entity id — present once it materialized. */
  entityId: string | null;
  /** Stable id the entity WILL get on approval (proposal-gated path only). */
  proposedEntityId?: string;
  proposalId?: string;
  proposalType?: string;
  reviewUrl?: string;
  /** Always populated — the door's message, or a verdict-shaped fallback. */
  message: string;
  /** Whether the fact was recorded as user-stated (auto-approve) or inferred. */
  validated: boolean;
  category: UserObservationCategory;
  confidence: number;
  /** The transitional episodic-recall row (see module doc). */
  recallIndex: { factId: string | null; indexed: boolean };
}

/** Entities need a title; the full text always lives in `uo_observation`. */
function toTitle(fact: string): string {
  const flat = fact.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}…` : flat;
}

export async function rememberFact(params: {
  /** Hub-Protocol caller (carries agentUserId + sessionId + the workspace lens). */
  caller: RememberFactCaller;
  userId: string;
  fact: string;
  confidence?: number;
  /** `uo_category`; defaults to the generic "preferences" bucket. */
  category?: UserObservationCategory;
  /**
   * The user DIRECTLY STATED this (not an AI inference). Sets `uo_validated`,
   * which is the ONLY signal that makes the policy rung auto-approve. Default
   * false → AI-inferred → proposed. Never guessed: the caller must say so.
   */
  userStated?: boolean;
  /** The authoring agent — makes governance treat the write as an AI action. */
  agentUserId?: string;
}): Promise<RememberFactResult> {
  const { caller, userId, fact } = params;

  const confidence = params.confidence ?? 0.8;
  const category = params.category ?? "preferences";
  const validated = params.userStated === true;

  // 1. Governed write — the policy rung decides execute vs propose from
  //    `uo_validated`, never from a caller flag or from which door was used.
  //    No explicit workspaceId: `user_observation` is a pod-scope kind, so
  //    placement resolves to pod-wide (NULL) from the profile's entityScope.
  const created = await caller.entities.createEntity({
    userId,
    profileSlug: "user_observation",
    title: toTitle(fact),
    properties: {
      uo_observation: fact,
      uo_category: category,
      uo_confidence: confidence,
      uo_validated: validated,
    },
    ...(params.agentUserId ? { agentUserId: params.agentUserId } : {}),
    reasoning: validated
      ? "User stated this directly"
      : "Observed about the user during this session",
    aiMetadata: { model: "mcp", reasoning: "MCP tool: synap_remember_fact" },
  });

  const entityId = created.id ?? null;

  // 2. Transitional recall index — keeps `ask`'s episodic substrate working
  //    (see module doc). Best-effort: recall is an index, never the record of
  //    truth, so an embedding or index failure must not fail a governed write
  //    that already succeeded.
  let factId: string | null = null;
  try {
    let embedding: number[];
    try {
      const { generateEmbedding } = await import("@synap/ai-embeddings");
      embedding = await generateEmbedding(fact);
    } catch {
      embedding = new Array(1536).fill(0);
    }

    const record = await knowledgeRepository.saveFact({
      userId,
      fact,
      confidence,
      embedding,
      // Points the loose row at its governed record. On the proposal-gated path
      // the entity does not exist yet, so `proposedEntityId` (the id it WILL
      // get) is deliberately NOT written — the column carries no FK, so a
      // dangling id would never be caught and would read as a real link.
      ...(entityId ? { sourceEntityId: entityId } : {}),
    });
    factId = record.id;
  } catch (err) {
    logger.error(
      { err, userId, entityId, status: created.status },
      "recall index write failed — governed write kept, episodic recall degraded"
    );
  }

  // A queued proposal is an ACCEPTED write, not a failure (see `success` doc).
  const success = created.status === "created" || created.status === "proposed";

  return {
    success,
    status: created.status,
    entityId,
    ...(created.proposedEntityId
      ? { proposedEntityId: created.proposedEntityId }
      : {}),
    ...(created.proposalId ? { proposalId: created.proposalId } : {}),
    ...(created.proposalType ? { proposalType: created.proposalType } : {}),
    ...(created.reviewUrl ? { reviewUrl: created.reviewUrl } : {}),
    message:
      created.message ??
      (created.status === "proposed"
        ? "Fact queued for review"
        : success
          ? "Fact stored successfully"
          : "Fact was not stored"),
    validated,
    category,
    confidence,
    recallIndex: { factId, indexed: factId !== null },
  };
}
