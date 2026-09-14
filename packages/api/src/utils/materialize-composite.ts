/**
 * Materialize a composite (graph) proposal's operations: create N entities, then
 * the M relations among them, resolving each relation ref → real entity id.
 *
 * Single source of truth shared by:
 *   - proposals.approve (composite branch) — human-approved graph
 *   - /import/apply — user-initiated direct import (their own data, no proposal)
 *
 * Pass 1 creates every create_entity op (canonical entity-create path → full
 * side-effects incl. linked documents when op.content is set), building a
 * ref→realId map. Pass 2 creates relations, resolving sourceRef/targetRef
 * ($opN / op `ref` / $primary / real UUID). Relation failures are logged but
 * never discard the created entities.
 */

import {
  isPlanBatch,
  isPlanOperation,
  normalizeProposalSource,
  registerEntityRef,
  resolveCompositeRef,
  type CompositeProposalOperation,
} from "@synap-core/types/proposals";
import {
  planSessionEdges,
  sessionOpsRootFirst,
  type PlanSessionEdge,
} from "../services/capture-agent/capture-plan.js";
import { createLogger } from "@synap-core/core";
// RELATION_SLUGS is the single source of truth in @synap/database (owned by the
// governed entity materializer). Imported here so this composite path and the
// materializer's invariant-1 guard can never drift apart.
import { RELATION_SLUGS } from "@synap/database";
import type { EntityPropertyDiff } from "./entity-property-diff.js";

const logger = createLogger({ module: "materialize-composite" });

/**
 * Create relations from ref-based ops against a ref→realId map. The ONE
 * relation-creation loop, shared by the composite orchestrator and by
 * capture's executeWithSchema (which keeps its own upsert entity phase). Each
 * relation is resolved + created independently: a missing ref or a failed
 * create is reported via `onError` and skipped, never aborting the batch.
 */
export async function createRelationsFromRefs(
  relationOps: Array<{ sourceRef: string; targetRef: string; type: string }>,
  refToRealId: Record<string, string>,
  relationCaller: RelationCreateCaller,
  opts?: {
    /** Validate/normalize the relation type (e.g. slug fallback). */
    resolveRelationType?: (type: string) => string;
    /**
     * Called for every relation op that failed to resolve/create. Carries the
     * RAW requested sourceRef/targetRef (not the resolved entity ids — those
     * may not exist if resolution itself is what failed) so a caller can name
     * exactly which requested edge was dropped, not just count it.
     */
    onError?: (
      err: unknown,
      type: string,
      refs: { sourceRef: string; targetRef: string }
    ) => void;
    /**
     * Relation-retry idempotency (U1): true if this (source, target, type) edge
     * already exists for the tenant → skip re-creating it. Entities are keyed
     * via external-links; relations dedup by DB existence. Only passed when
     * idempotency is active.
     */
    relationExists?: (
      sourceEntityId: string,
      targetEntityId: string,
      type: string
    ) => Promise<boolean>;
    /**
     * An existing edge's id when the SAME proposal created it (a crash before
     * the record was stamped). Such an edge is recorded as this run's creation
     * instead of vanishing from the retry's result.
     */
    ownedRelationId?: (
      sourceEntityId: string,
      targetEntityId: string,
      type: string
    ) => Promise<string | null>;
  }
): Promise<MaterializeRelationResult[]> {
  const relations: MaterializeRelationResult[] = [];
  for (const op of relationOps) {
    try {
      const sourceEntityId = resolveCompositeRef(refToRealId, op.sourceRef);
      const targetEntityId = resolveCompositeRef(refToRealId, op.targetRef);
      if (sourceEntityId === targetEntityId) continue; // no self-relations
      const type = opts?.resolveRelationType
        ? opts.resolveRelationType(op.type)
        : op.type;
      // Retry-safe: an identical edge already in the graph (a retry, or a
      // duplicate op within this proposal) is skipped, not re-created.
      if (
        opts?.relationExists &&
        (await opts.relationExists(sourceEntityId, targetEntityId, type))
      ) {
        const ownRelationId = await opts.ownedRelationId?.(
          sourceEntityId,
          targetEntityId,
          type
        );
        if (ownRelationId) {
          relations.push({
            sourceEntityId,
            targetEntityId,
            type,
            requested: {
              sourceRef: op.sourceRef,
              targetRef: op.targetRef,
              type: op.type,
            },
            relationId: ownRelationId,
          });
        }
        continue;
      }
      // A door that can answer "proposed" must never be counted as "linked".
      // `relations.create` returns `{ status: "proposed" }` rather than
      // throwing when the governance ladder routes the write to a proposal —
      // so an ignored return value would report N edges linked while creating
      // ZERO and queueing N new proposals. The approval path suppresses that
      // re-gate at its source (see the `governanceProposalId` carve-out in
      // `relations.create`); this is the defence in depth for every other
      // caller of the shared materializer.
      const created = await relationCaller.create({
        sourceEntityId,
        targetEntityId,
        type,
      });
      if ((created as { status?: string } | undefined)?.status === "proposed") {
        throw new Error(
          `relation ${type} was routed to a proposal instead of being created; ` +
            `it was NOT linked. This path materializes an already-approved ` +
            `proposal and must not re-enter the governance membrane.`
        );
      }
      // The created row's id is what makes the edge undoable. `exists` means
      // the door found an edge that was already there — somebody else's, so
      // it is reported but never recorded as this run's creation.
      const relationId = (created as { id?: unknown } | undefined)?.id;
      const preExisting =
        (created as { status?: string } | undefined)?.status === "exists";
      relations.push({
        sourceEntityId,
        targetEntityId,
        type,
        requested: {
          sourceRef: op.sourceRef,
          targetRef: op.targetRef,
          type: op.type,
        },
        ...(typeof relationId === "string" ? { relationId } : {}),
        ...(preExisting ? { preExisting: true as const } : {}),
      });
    } catch (err) {
      opts?.onError?.(err, op.type, {
        sourceRef: op.sourceRef,
        targetRef: op.targetRef,
      });
    }
  }
  return relations;
}

/** One relation op that was submitted but never created — the honest detail
 * behind a `created < submitted` gap on a materialize receipt. */
export interface MaterializeRelationFailure {
  sourceRef: string;
  targetRef: string;
  type: string;
  reason: string;
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface MaterializeEntityResult {
  /** Op's stable ref (e.g. capture tempId), if it had one. */
  ref?: string;
  /** Index of the create_entity op in operations[]. */
  opIndex: number;
  /** Real entity id (created or linked-to). */
  entityId: string;
  profileSlug: string;
  /** True when this op linked an existing entity (existingEntityId) vs created. */
  linked: boolean;
  /**
   * Per-op target workspace from the create_entity op (multi-home import
   * graphs). Absent when the op did not pin a workspace.
   */
  workspaceId?: string | null;
  /**
   * Per-op project from the create_entity op (already filed via entities.create
   * → linkEntityToProject). stampProjectMembership skips entities that carry
   * this so it doesn't re-link; falls back to the orchestrator project lens
   * for entities without a per-op project.
   */
  projectId?: string | null;
  /**
   * Set by callers that DOWNGRADE a failed create to a note fallback — carries
   * the originally requested profileSlug. Additive; absent on the happy path.
   */
  degradedFrom?: string;
  /**
   * Set by callers that SALVAGE a validation failure by retrying the same
   * profile with properties dropped. Additive; absent on the happy path.
   */
  propertiesDropped?: true;
  /**
   * Set when this op carried long-form `content` (a note body) that was NOT
   * applied because the create resolved to an EXISTING entity via strong-signal
   * dedup (entities.create enriches properties on a merge, but never overwrites
   * the matched entity's document). Surfaced (mirrors the facets 'dropped'
   * pattern) so the caller can flag the discarded body instead of losing it
   * silently. Additive; absent on the happy path.
   */
  contentDropped?: true;
  /**
   * Body document created TOGETHER with this entity (op.content routed to a
   * linked document). Absent when the entity was linked, or had no body.
   */
  documentId?: string;
  /**
   * What a strong-identity merge wrote onto the PRE-EXISTING entity this op
   * resolved to, with the values it replaced — so revert can restore them
   * without deleting an entity the run never created. Only on a merge.
   */
  propertyDiff?: EntityPropertyDiff;
  /**
   * Linked ONLY because a retry's idempotency key found a row the SAME proposal
   * created (lineage checked) — a crash between create and stamp. The row is
   * this run's creation, not a pre-existing entity. Never set on a dedup or
   * `existingEntityId` link.
   */
  linkedByRetry?: true;
}

export interface MaterializeRelationResult {
  sourceEntityId: string;
  targetEntityId: string;
  /** Actual relation type used (post type-resolution/fallback). */
  type: string;
  /** The op as submitted (refs, pre-resolution type) — its identity in a record. */
  requested?: { sourceRef: string; targetRef: string; type: string };
  /** Id of the relation row, when the door returned one. */
  relationId?: string;
  /** The door found this edge already in the graph — not created by this run. */
  preExisting?: true;
}

/** One facet this run attached (a role on an entity). */
export interface MaterializeFacetResult {
  /** The create_entity op that declared the facet. */
  opIndex: number;
  ref?: string;
  entityId: string;
  facetId: string;
  profileSlug: string;
}

/** Per-op result for a `create_skill` op (the FACT half of a rule). */
export interface MaterializeSkillResult {
  ref: string;
  opIndex: number;
  skillId: string;
}

/** Per-op result for a `create_automation` op (the BEHAVIOUR half of a rule). */
export interface MaterializeAutomationResult {
  ref: string;
  opIndex: number;
  automationId: string;
  /** What the op ASKED for. */
  enabledRequested: boolean;
  /**
   * What was actually materialized. ALWAYS false: approve-first means an
   * automation never arrives already running, so the op's `enabled` is
   * overridden here and the override is REPORTED rather than swallowed.
   */
  enabled: false;
  /** True when the op said `enabled: true` and we forced it off. */
  enabledOverridden: boolean;
}

/** Per-op result for a `create_rule` op. */
export interface MaterializeRuleResult {
  ref: string;
  opIndex: number;
  ruleId: string;
  factSkillId?: string;
  automationIds: string[];
}

/** Per-op result for a `create_project` op (connected plan). */
export interface MaterializeProjectResult {
  ref: string;
  opIndex: number;
  projectId: string;
  /** The project door reused an existing project of the same name — not this run's row. */
  linked: boolean;
  /** Subject the run bound to the project, when the step named one. */
  subjectEntityId?: string;
}

/** Per-op result for a `create_session` op (connected plan). */
export interface MaterializeSessionResult {
  ref: string;
  opIndex: number;
  sessionId: string;
  /**
   * True when the create door REUSED an open session of the same goal and
   * scope (`status: "deduped"`) — not this run's row, never compensated.
   */
  linked?: boolean;
}

/** One session↔session edge a plan applied. */
export interface MaterializeLinkResult {
  opIndex: number;
  type: "blocked_by" | "spawned_from";
  fromSessionId: string;
  toSessionId: string;
  /** As declared (a ref or a real id per side) — the edge's identity in a record. */
  requested: { from: string; to: string };
  linkId?: string;
  /** The edge was already in the graph — not created by this run. */
  preExisting?: true;
}

/** Per-op result for a `create_document` op (connected plan). */
export interface MaterializeDocumentResult {
  ref: string;
  opIndex: number;
  documentId: string;
  attachedEntityId?: string;
  recordedOnSessionId?: string;
}

/** One plan step that did not apply — the per-step reason on `approval_failed`. */
export interface PlanStepFailure {
  opIndex: number;
  ref?: string;
  op: CompositeProposalOperation["op"];
  reason: string;
}

/** What compensation did with the steps that HAD applied before the failure. */
export interface PlanCompensationReport {
  /** Rows retired, by kind. */
  undone: Record<string, string[]>;
  /** Rows compensation left in place, and why — never silently kept. */
  notCompensated: Array<{ kind: string; id: string; reason: string }>;
}

/**
 * A plan did not apply as a whole. Everything it had applied was handed to
 * the compensator; `steps` names every failed step, `compensation` what was
 * undone and what could not be.
 */
export class CompositePlanApplyError extends Error {
  readonly steps: PlanStepFailure[];
  readonly compensation: PlanCompensationReport;
  constructor(steps: PlanStepFailure[], compensation: PlanCompensationReport) {
    const lines = steps.map(
      (s) =>
        `• ${s.op}${s.ref ? ` "${s.ref}"` : ""} (#${s.opIndex}): ${s.reason}`
    );
    const left = compensation.notCompensated.length;
    super(
      `The plan did not apply — ${steps.length} step${steps.length === 1 ? "" : "s"} failed, so every step that had applied was rolled back:\n${lines.join("\n")}` +
        (left > 0
          ? `\n${left} row${left === 1 ? "" : "s"} could not be rolled back: ${compensation.notCompensated
              .map((n) => `${n.kind} ${n.id} (${n.reason})`)
              .join("; ")}`
          : "")
    );
    this.name = "CompositePlanApplyError";
    this.steps = steps;
    this.compensation = compensation;
  }
}

export interface MaterializeResult {
  /** Count of entities CREATED (excludes linked existing entities). */
  created: number;
  /** Count of relations created. */
  linked: number;
  primaryId: string;
  refToRealId: Record<string, string>;
  /** Per-entity detail (order matches create_entity ops) for response building. */
  entities: MaterializeEntityResult[];
  /** Per-relation detail for response building. */
  relations: MaterializeRelationResult[];
  /**
   * Relation ops that were SUBMITTED but never created (bad ref, DB failure,
   * etc). `relations.length + relationsFailed.length` is the submitted count —
   * this is what makes the gap between "submitted" and "created" honest and
   * nameable instead of a swallowed `logger.warn`. Empty on the happy path.
   */
  relationsFailed: MaterializeRelationFailure[];
  /**
   * Facets the attach door reported `attached`. The door answers `attached`
   * for a re-attach of an existing live facet too, so this is "attached by the
   * call", not proof of creation — revert re-checks each row's lineage.
   */
  facets: MaterializeFacetResult[];
  /** Rule Loop (NS1): skills created by `create_skill` ops. Empty by default. */
  skills: MaterializeSkillResult[];
  /** Rule Loop (NS1): automations created by `create_automation` ops. */
  automations: MaterializeAutomationResult[];
  /** Rule Loop (NS1): rules created by `create_rule` ops. */
  rules: MaterializeRuleResult[];
  /** Connected plan: projects, sessions, session edges, documents. Empty otherwise. */
  projects: MaterializeProjectResult[];
  sessions: MaterializeSessionResult[];
  links: MaterializeLinkResult[];
  documents: MaterializeDocumentResult[];
}

/**
 * Caller shapes — structurally satisfied by the tRPC entitiesRouter /
 * relationsRouter createCaller(...) objects. Typed loosely (the tRPC caller's
 * `create` carries a much wider inferred input than we use) so this util can be
 * shared without re-deriving the router's exact procedure types.
 */

export type EntityCreateCaller = { create: (input: any) => Promise<any> };

export type RelationCreateCaller = { create: (input: any) => Promise<any> };

/**
 * Rule Loop callers (NS1). Each routes to its EXISTING canonical door — the
 * skills service, the automations create path (which runs the ONE flow
 * validator), and the rule service — wired by the approve/import orchestrator
 * with the APPROVER's identity. Absent ⇒ the corresponding ops are logged and
 * skipped, exactly like `facetCaller` (additive: every existing caller that
 * passes neither behaves byte-identically to today).
 */
export type SkillCreateCaller = {
  create: (input: {
    name: string;
    body: string;
    scope: "pod" | "user" | "workspace";
    agentTypes?: string[] | null;
  }) => Promise<{ id: string }>;
};

export type AutomationCreateCaller = {
  create: (input: {
    name: string;
    description?: string;
    triggerType: "event" | "cron" | "webhook" | "manual";
    flowDefinition: unknown;
    /** Always false — the materializer never asks for a running automation. */
    enabled: false;
  }) => Promise<{ id: string }>;
};

export type RuleCreateCaller = {
  create: (input: {
    intent: string;
    scope: { kind: "pod" | "workspace" | "user"; workspaceId?: string };
    factSkillId?: string;
    automationIds: string[];
  }) => Promise<{ id: string }>;
};

/**
 * Structurally satisfied by the tRPC entitiesRouter caller — reuses its
 * `attachFacet` procedure (same governance ctx as `entityCaller`, so a
 * human-approved proposal attaches directly rather than re-proposing).
 */
export type FacetAttachCaller = {
  attachFacet: (input: any) => Promise<any>;
};

/**
 * Connected-plan callers. Each routes to the EXISTING door for its object —
 * `createFocusSession`, the `projects.create` / `projects.update` router, the
 * session edge producers (`addSessionBlocker` / `recordSessionSpawn`), the
 * document door — built by ONE factory (`utils/plan-callers.ts`). Every call
 * THROWS on anything but a clean apply: inside a plan a skipped step is a
 * failed plan, never a warning.
 *
 * `compensate` is the undo half: it receives everything that DID apply and
 * retires it through the one undo engine (`revertProposalCreations`). A batch
 * with a plan op and no `planCallers` is refused before anything is written.
 */
export interface PlanCallers {
  projectCaller: {
    create: (input: {
      name: string;
      description?: string;
    }) => Promise<{ id: string; linked: boolean }>;
    setSubject: (input: {
      projectId: string;
      subjectEntityId: string;
    }) => Promise<void>;
  };
  sessionCaller: {
    create: (input: {
      title: string | null;
      goal: string;
      subjectEntityId: string | null;
      projectId: string | null;
      expectedOutputs: Array<Record<string, unknown>>;
      /** `linked` = the door reused an existing open session (never compensated). */
    }) => Promise<{ id: string; linked?: boolean }>;
  };
  linkCaller: {
    create: (input: {
      type: "blocked_by" | "spawned_from";
      fromSessionId: string;
      toSessionId: string;
    }) => Promise<{ linkId: string | null; preExisting: boolean }>;
  };
  documentCaller: {
    create: (input: {
      title: string;
      content: string;
      entityId: string | null;
      sessionId: string | null;
      expectedLabel: string | null;
    }) => Promise<{ id: string }>;
  };
  compensate: (applied: MaterializeResult) => Promise<PlanCompensationReport>;
}

export interface MaterializeOptions {
  /**
   * Pin every created entity to the caller's active workspace, OVERRIDING any
   * profile pod-default `entityScope`. Imports set this so their data is
   * isolated to the target workspace (and is later purgeable on workspace
   * deletion). Interactive proposal approval leaves it false so pod-default
   * profiles keep their global graph.
   */
  workspaceScoped?: boolean;
  /**
   * Resolve/validate a relation type before creating it (e.g. fall back to a
   * generic type when a slug isn't a valid workspace relation_def). Defaults to
   * pass-through. Capture injects a workspace-aware validator here so the one
   * relation loop serves both the governed (router) and direct-write paths.
   */
  resolveRelationType?: (type: string) => string;
  /**
   * Source tag stamped on each created entity (governance/audit provenance).
   * Defaults to "system" (proposal-approve / import). Capture may pass its own.
   */
  source?: string;
  /**
   * Pre-existing ref→realId mappings from EARLIER chunks of a chunked import.
   * Seeded into pass 1's map so pass 2 relations whose endpoints were created in
   * a previous chunk still resolve. Used by `applyLarge`; omitted for a single
   * call. Entities created in THIS call append to (and override) the seed.
   */
  seedRefToRealId?: Record<string, string>;
  /**
   * Operation-keyed idempotency (U1). When present, each created entity is keyed
   * in an external-link store by `${namespace}:${op.ref}` where `namespace` is a
   * CLIENT-STABLE id (import proposalId / capture idempotencyKey). Before
   * creating an op with a `ref`, we `lookup(provider, externalId)`: a hit LINKS
   * the existing entity (retry-safe — no duplicate); a miss creates then
   * `register`s the key. Distinct ops have distinct `op.ref` → distinct keys →
   * both create (two same-named notes stay separate). Absent → behavior is
   * byte-identical to today (no idempotency).
   */
  idempotency?: {
    namespace: string;
    provider: string;
    lookup: (provider: string, externalId: string) => Promise<string | null>;
    register: (
      entityId: string,
      provider: string,
      externalId: string,
      /** Source-app url + producing connection for an op's declared `externalLinks`. */
      link?: { url?: string | null; connectionId?: string | null }
    ) => Promise<void>;
    // Relation-retry idempotency: skip an edge that already exists for the tenant.
    relationExists?: (
      sourceEntityId: string,
      targetEntityId: string,
      type: string
    ) => Promise<boolean>;
    /** See `EntityLinkIdempotency.ownsRetry` — lineage-checked retry hit. */
    ownsRetry?: (entityId: string) => Promise<boolean>;
    /** See `EntityLinkIdempotency.ownedRelationId`. */
    ownedRelationId?: (
      sourceEntityId: string,
      targetEntityId: string,
      type: string
    ) => Promise<string | null>;
  };
  /**
   * Cross-CHUNK within-proposal dedup guard. `applyLarge` calls this materializer
   * once per chunk; the in-call "duplicate op.ref → create separate, don't merge"
   * guard is otherwise reset every chunk, so a producer that emits the same
   * `op.ref` in two different chunks would have the second chunk treat the first's
   * registered key as a prior-run retry hit and MERGE two distinct entities.
   * Passing one shared Set across every chunk of a single apply makes the guard
   * span the whole proposal. Omitted for a single call (the local Set suffices).
   */
  idemSeen?: Set<string>;
  /**
   * Facet attacher (Kind + Facets) — when provided, each create_entity op's
   * declared `facets` are attached right after that entity resolves (created
   * OR linked-existing). Omitted → ops carrying `facets` are silently
   * ignored, keeping every existing caller (which doesn't pass this) additive.
   */
  facetCaller?: FacetAttachCaller;
  /** Rule Loop (NS1) — see the caller types above. All three are optional. */
  skillCaller?: SkillCreateCaller;
  automationCaller?: AutomationCreateCaller;
  ruleCaller?: RuleCreateCaller;
  /**
   * Connected plan (sessions / documents / projects / session edges). Required
   * the moment a batch carries a plan op — absent ⇒ the batch is refused before
   * any write, like the Rule Loop callers.
   */
  planCallers?: PlanCallers;
}

/** Internal: stops a plan at its first failed step (never escapes the materializer). */
class PlanStepAbort extends Error {
  readonly failure: PlanStepFailure;
  constructor(failure: PlanStepFailure) {
    super(failure.reason);
    this.failure = failure;
  }
}

/** The ids a partial result names — what compensation must account for. */
function appliedRowsOf(
  result: MaterializeResult
): Array<{ kind: string; id: string }> {
  return [
    ...result.entities
      .filter((e) => !e.linked)
      .map((e) => ({ kind: "entity", id: e.entityId })),
    ...result.relations
      .filter((r) => r.relationId && !r.preExisting)
      .map((r) => ({ kind: "relation", id: r.relationId as string })),
    ...result.facets.map((f) => ({ kind: "facet", id: f.facetId })),
    ...result.skills.map((s) => ({ kind: "skill", id: s.skillId })),
    ...result.automations.map((a) => ({
      kind: "automation",
      id: a.automationId,
    })),
    ...result.rules.map((r) => ({ kind: "rule", id: r.ruleId })),
    ...result.projects
      .filter((p) => !p.linked)
      .map((p) => ({ kind: "project", id: p.projectId })),
    ...result.sessions.map((s) => ({ kind: "session", id: s.sessionId })),
    ...result.links
      .filter((l) => l.linkId && !l.preExisting)
      .map((l) => ({ kind: "link", id: l.linkId as string })),
    ...result.documents.map((d) => ({ kind: "document", id: d.documentId })),
  ];
}

export async function materializeCompositeGraph(
  operations: CompositeProposalOperation[],
  entityCaller: EntityCreateCaller,
  relationCaller: RelationCreateCaller,
  onRelationError?: (err: unknown, type: string) => void,
  options?: MaterializeOptions
): Promise<MaterializeResult> {
  // ── PREFLIGHT — FAIL CLOSED on an unwired config caller ────────────────
  // The three Rule Loop arms below used to respond to a missing caller with
  // `logger.warn` + `continue`: a SILENT SKIP that reported success. Only ONE
  // of this function's five call sites wired the callers, so the SAME batch
  // would materialize its config ops on the GOVERNED (approval) path and
  // silently drop them on the AUTO-APPROVED (direct-write) path — behaviour
  // forking on governance state, which is exactly what a governance system
  // must never do.
  //
  // Checked UP FRONT, before pass 0 writes anything, so the refusal is atomic:
  // an unwirable batch materializes NOTHING rather than half of itself. Throwing
  // is the whole point — a future call site that forgets to wire cannot re-open
  // the fork quietly. (`facetCaller` is deliberately NOT checked here: a facet
  // is an additive soft attach whose omission is a documented, additive contract,
  // and capture attaches its facets out of band in a separate governed pass.)
  const missingConfigCaller = operations.find(
    (op) =>
      (op.op === "create_skill" && !options?.skillCaller) ||
      (op.op === "create_automation" && !options?.automationCaller) ||
      (op.op === "create_rule" && !options?.ruleCaller)
  );
  if (missingConfigCaller) {
    throw new Error(
      `materializeCompositeGraph: batch contains a "${missingConfigCaller.op}" op but this caller wired no matching caller. ` +
        "Wire the Rule Loop callers (utils/rule-loop-callers.ts `buildRuleLoopCallers`) at this call site. " +
        "Refusing rather than skipping: a dropped config op reported as success is how materialization forks on governance state."
    );
  }

  // ── PREFLIGHT — FAIL CLOSED on an unwired PLAN ─────────────────────────
  // Same rule, same place: a connected plan (sessions / documents / projects /
  // session edges) reaching a call site that wired no `planCallers` is refused
  // before anything is written. The peer call sites (text-lane capture, both
  // import paths) never produce plan ops; if one ever does, it fails loud here
  // instead of materializing the entities and dropping the plan around them.
  // The provenance every door write is stamped with. Normalized HERE, once, so
  // no call site can hand an import FORMAT (`markdown`, `connector_sync`) to a
  // door whose `source` is the actor vocabulary (`PROPOSAL_SOURCES`) — that
  // failed approval with a zod `invalid_value`. Absent ⇒ "system".
  const materializeSource = normalizeProposalSource(
    options?.source ?? "system"
  );
  const planMode = isPlanBatch(operations);
  const planCallers = options?.planCallers;
  if (planMode && !planCallers) {
    const planOp = operations.find(isPlanOperation);
    throw new Error(
      `materializeCompositeGraph: batch contains a "${planOp?.op}" plan op but this caller wired no planCallers. ` +
        "Wire `buildPlanCallers` (utils/plan-callers.ts) at this call site. " +
        "Refusing before any write: a plan applies whole or not at all."
    );
  }

  // ── PLAN MODE: all-or-none ─────────────────────────────────────────────
  // Outside a plan every pass below keeps its per-op resilience (a failed
  // relation or facet is reported and skipped). INSIDE a plan a skipped step
  // breaks the structure the reviewer approved — a session whose blocker never
  // landed is not "mostly" the plan — so the first failed step stops the run
  // (`failPlanStep` throws), and everything that had applied is handed to
  // `planCallers.compensate`. There is no DB transaction across these doors
  // (each opens its own), so compensation IS the atomicity.
  let currentOpIndex = -1;
  const failPlanStep = (opIndex: number, err: unknown): void => {
    if (!planMode) return;
    const op = operations[opIndex];
    const ref = (op as { ref?: unknown } | undefined)?.ref;
    throw new PlanStepAbort({
      opIndex,
      ...(typeof ref === "string" && ref ? { ref } : {}),
      op: op?.op ?? "create_entity",
      reason: errorReason(err),
    });
  };

  // Pass 1 — entities → ref→realId map. An op may LINK an existing entity
  // (existingEntityId) instead of creating one; in that case we register its
  // refs and skip creation. Seeded with earlier-chunk refs (chunked imports) so
  // pass-2 relations across chunk boundaries resolve.
  const refToRealId: Record<string, string> = {
    ...(options?.seedRefToRealId ?? {}),
  };
  const entities: MaterializeEntityResult[] = [];
  let primaryId = "";
  let created = 0;
  // Idempotency keys already handled in THIS materialize call. Guards against a
  // duplicate `op.ref` within ONE proposal silently merging two distinct
  // entities (a producer bug): a second op with the same key creates a separate
  // entity instead of linking to the first. Cross-CALL retries (key registered
  // in a prior call, absent here) still link correctly. `applyLarge` passes a
  // shared Set so the guard spans every chunk of one apply (see `idemSeen`).
  const idemSeenThisCall = options?.idemSeen ?? new Set<string>();
  // Facet-attach ops deferred to pass 1.5 (see below) — collected here so a
  // facet's `contextRef` can resolve against the FULL refToRealId map, not
  // just the entities created before it in operations[].
  const pendingFacetAttaches: Array<{
    opIndex: number;
    ref?: string;
    realId: string;
    facets: NonNullable<
      Extract<CompositeProposalOperation, { op: "create_entity" }>["facets"]
    >;
  }> = [];
  // ── Pass 0 — Rule Loop CONFIG ops (NS1) ────────────────────────────────
  // Skills and automations are created BEFORE entities so that (a) a
  // `create_rule` op in pass 3 can resolve `factRef` / `behaviourRefs` through
  // the SAME ref→realId map pass 2 uses, and (b) no second ref-resolution
  // scheme exists. Refs are registered with `registerEntityRef(..., false)` —
  // identical key shape ($opN + the op's own ref), minus the `$primary` claim,
  // which stays reserved for the first create_entity op.
  //
  // Per-op resilience matches the rest of this file: a failed op is logged and
  // skipped, never discarding what already succeeded.
  const skillResults: MaterializeSkillResult[] = [];
  const automationResults: MaterializeAutomationResult[] = [];
  const ruleResults: MaterializeRuleResult[] = [];
  const facetResults: MaterializeFacetResult[] = [];
  let relations: MaterializeRelationResult[] = [];
  const relationsFailed: MaterializeRelationFailure[] = [];
  const projectResults: MaterializeProjectResult[] = [];
  const sessionResults: MaterializeSessionResult[] = [];
  const linkResults: MaterializeLinkResult[] = [];
  const documentResults: MaterializeDocumentResult[] = [];

  const buildResult = (): MaterializeResult => ({
    created,
    linked: relations.length,
    primaryId,
    refToRealId,
    entities,
    relations,
    relationsFailed,
    facets: facetResults,
    skills: skillResults,
    automations: automationResults,
    rules: ruleResults,
    projects: projectResults,
    sessions: sessionResults,
    links: linkResults,
    documents: documentResults,
  });

  try {
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.op !== "create_skill") continue;
      currentOpIndex = i;
      if (!options?.skillCaller) {
        // Unreachable — the fail-closed preflight above already refused this
        // batch. Kept as a narrowing guard that THROWS (never skips), so the
        // silent-skip shape cannot come back by way of a refactor.
        throw new Error(
          "materializeCompositeGraph: create_skill op reached pass execution with no skillCaller (preflight bypassed)"
        );
      }
      try {
        const created = await options.skillCaller.create({
          name: op.name,
          body: op.body,
          scope: op.scope,
          agentTypes: op.agentTypes ?? null,
        });
        registerEntityRef(refToRealId, i, op.ref, created.id, false);
        skillResults.push({ ref: op.ref, opIndex: i, skillId: created.id });
      } catch (err) {
        logger.warn(
          { err, ref: op.ref, name: op.name },
          "Skipping create_skill op (batch continues)"
        );
        failPlanStep(i, err);
      }
    }

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.op !== "create_automation") continue;
      currentOpIndex = i;
      if (!options?.automationCaller) {
        // Unreachable — the fail-closed preflight above already refused this
        // batch. Kept as a narrowing guard that THROWS (never skips), so the
        // silent-skip shape cannot come back by way of a refactor.
        throw new Error(
          "materializeCompositeGraph: create_automation op reached pass execution with no automationCaller (preflight bypassed)"
        );
      }
      const enabledRequested = op.enabled === true;
      try {
        // FORCED DISABLED. Approve-first: an automation never arrives already
        // running, even when the op says `enabled: true`. The override is
        // reported on the result rather than swallowed.
        const created = await options.automationCaller.create({
          name: op.name,
          ...(op.description ? { description: op.description } : {}),
          triggerType: op.triggerType,
          flowDefinition: op.flowDefinition,
          enabled: false,
        });
        if (enabledRequested) {
          logger.info(
            { ref: op.ref, name: op.name, automationId: created.id },
            "create_automation asked for enabled:true — materialized DISABLED (approve-first)"
          );
        }
        registerEntityRef(refToRealId, i, op.ref, created.id, false);
        automationResults.push({
          ref: op.ref,
          opIndex: i,
          automationId: created.id,
          enabledRequested,
          enabled: false,
          enabledOverridden: enabledRequested,
        });
      } catch (err) {
        logger.warn(
          { err, ref: op.ref, name: op.name },
          "Skipping create_automation op (batch continues)"
        );
        failPlanStep(i, err);
      }
    }

    // ── Plan pass P0 — PROJECTS ─────────────────────────────────────────
    // First, so an entity (`projectRef`) or a session (`projectRef`) can be
    // filed into a project this same plan creates. The subject binding waits
    // for the entities (pass P0b below) — a subject may be an entity the plan
    // creates.
    if (planCallers) {
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (op.op !== "create_project") continue;
        currentOpIndex = i;
        const project = await planCallers.projectCaller.create({
          name: op.name,
          ...(op.description ? { description: op.description } : {}),
        });
        registerEntityRef(refToRealId, i, op.ref, project.id, false);
        projectResults.push({
          ref: op.ref,
          opIndex: i,
          projectId: project.id,
          linked: project.linked,
        });
      }
    }

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.op !== "create_entity") continue;
      currentOpIndex = i;

      // Guard (narrow, exact-match): drop a materialized entity whose title OR
      // profileSlug EXACTLY equals a known relation slug (trimmed, case-insensitive)
      // — a misclassified edge-type from IS structure/import output. Skip + warn;
      // NEVER throw, so the rest of a multi-entity batch still materializes.
      // (Inside a PLAN the skip is a failed step — see PLAN MODE above.)
      const titleKey = op.title?.trim().toLowerCase();
      const slugKey = op.profileSlug?.trim().toLowerCase();
      if (
        (titleKey && RELATION_SLUGS.has(titleKey)) ||
        (slugKey && RELATION_SLUGS.has(slugKey))
      ) {
        logger.warn(
          {
            title: op.title,
            profileSlug: op.profileSlug,
            source: materializeSource,
          },
          "Skipping materialized entity: title/type collides with a known relation slug (likely misclassified edge-type from IS structure/import output)"
        );
        failPlanStep(
          i,
          `"${op.title ?? op.profileSlug}" collides with a relation type name and cannot be created as an entity`
        );
        continue;
      }

      // A plan entity filed into a project the SAME plan creates.
      const opProjectId =
        op.projectId ??
        (op.projectRef
          ? resolveCompositeRef(refToRealId, op.projectRef)
          : undefined);

      let realId: string;
      let linkedExisting = false;
      let resultProfileSlug = op.profileSlug;
      let degradedFrom: string | undefined;
      let propertiesDropped: true | undefined;
      let contentDropped: true | undefined;
      let documentId: string | undefined;
      let propertyDiff: EntityPropertyDiff | undefined;
      let linkedByRetry: true | undefined;
      // Operation-keyed idempotency (U1): if this op already materialized under
      // the caller's stable namespace (a retry), link the prior entity instead of
      // re-creating. Keyed by `${namespace}:${op.ref}` — distinct ops have
      // distinct refs, so two same-named entities never collide.
      const idemExternalId =
        options?.idempotency && op.ref
          ? `${options.idempotency.namespace}:${op.ref}`
          : undefined;
      let idemHitId: string | null = null;
      if (
        options?.idempotency &&
        idemExternalId &&
        !op.existingEntityId &&
        // Only honor a hit from a PRIOR call (a real retry). A hit on a key already
        // created in THIS call is a within-proposal duplicate ref → do NOT merge.
        !idemSeenThisCall.has(idemExternalId)
      ) {
        idemHitId = await options.idempotency.lookup(
          options.idempotency.provider,
          idemExternalId
        );
      }

      if (op.existingEntityId) {
        // `existingEntityId` is normally a real entity UUID, but a chunked import
        // may link to an entity CREATED in an earlier chunk — in that case it is a
        // synthetic ref present in the seeded map. Resolve through the seed (no-op
        // for a real UUID, which is absent from the map).
        realId = refToRealId[op.existingEntityId] ?? op.existingEntityId;
        linkedExisting = true;
      } else if (idemHitId) {
        // Same namespace + ref seen before → link the prior entity (retry-safe,
        // no duplicate). Treated exactly like the existingEntityId link branch.
        realId = idemHitId;
        linkedExisting = true;
        if (await options?.idempotency?.ownsRetry?.(idemHitId)) {
          linkedByRetry = true;
        }
        if (idemExternalId) idemSeenThisCall.add(idemExternalId);
      } else {
        // Per-op workspace pin (multi-home import graphs): when the op carries
        // `targetWorkspaceId`, pass it through to entities.create (membership
        // validated there) and force workspaceScoped so the entity lands in that
        // workspace even for pod-default profiles. Ops without a pin keep the
        // caller's ambient flag (proposal.approve path unchanged).
        const opTargetWorkspaceId = op.targetWorkspaceId;
        const result = await entityCaller.create({
          profileSlug: op.profileSlug,
          title: op.title || "Untitled",
          description: op.description,
          properties: op.properties,
          content: op.content, // long-form body → linked document
          ...(opProjectId ? { projectId: opProjectId } : {}),
          ...(opTargetWorkspaceId
            ? { targetWorkspaceId: opTargetWorkspaceId }
            : {}),
          source: materializeSource,
          // Explicit workspace-scope request: pin to the target (or ambient)
          // workspace even for pod-default profiles. Per-op pin forces true;
          // otherwise imports may set options.workspaceScoped, while proposal
          // approve leaves it false so pod-default profiles stay global.
          workspaceScoped: opTargetWorkspaceId
            ? true
            : (options?.workspaceScoped ?? false),
        });
        // A door that answers "proposed" did not create anything. Outside a
        // plan the historic behaviour stands; inside one it is a failed step.
        if (
          planMode &&
          (result as { status?: string } | undefined)?.status === "proposed"
        ) {
          failPlanStep(
            i,
            "the entity create was routed to a proposal instead of being created"
          );
        }
        realId = (result as { id: string }).id;
        // A caller may report the ACTUAL profile it created (e.g. capture's
        // retry-as-note downgrades the slug); prefer it for the response.
        resultProfileSlug =
          (result as { profileSlug?: string }).profileSlug ?? op.profileSlug;
        // Carry caller-reported salvage/downgrade provenance through (additive).
        degradedFrom = (result as { degradedFrom?: string }).degradedFrom;
        propertiesDropped = (result as { propertiesDropped?: true })
          .propertiesDropped;
        // entities.create resolve-then-merge: a strong-signal dedup returns the
        // PRE-EXISTING entity with `deduplicated: true` (it enriched properties +
        // attached roles, but did NOT create a row). Treat it exactly like an
        // existingEntityId link so revert never DELETES the pre-existing entity and
        // the created-count stays honest. If this op carried a long-form `content`
        // body, the merge silently discards it (create only overwrites properties on
        // a dedup) — flag it so the body isn't lost without a trace.
        if ((result as { deduplicated?: boolean }).deduplicated === true) {
          linkedExisting = true;
          // What the merge overwrote on the matched entity (entities.create
          // reports it) — the only undoable trace of a merge.
          const reportedDiff = (result as { propertyDiff?: EntityPropertyDiff })
            .propertyDiff;
          if (reportedDiff) propertyDiff = reportedDiff;
          // B3: entities.create now RECOVERS a dropped body onto the deduped entity
          // when it safely can (no existing body to clobber) and reports the
          // residual via `contentDropped`. Prefer that signal; fall back to the old
          // "any content on a dedup is dropped" heuristic only if an older door
          // omits it.
          const reportedDropped = (result as { contentDropped?: boolean })
            .contentDropped;
          if (reportedDropped !== undefined) {
            if (reportedDropped) contentDropped = true;
          } else if (op.content && op.content.trim().length > 0) {
            contentDropped = true;
          }
        } else {
          created++;
          // The body document minted with the entity. Direct-write callers
          // report it top-level; the entities.create door carries it on the
          // returned entity row.
          const reportedDocumentId =
            (result as { documentId?: unknown }).documentId ??
            (result as { entity?: { documentId?: unknown } | null }).entity
              ?.documentId;
          if (typeof reportedDocumentId === "string") {
            documentId = reportedDocumentId;
          }
        }
        // Register the op's stable key so a retry under the same namespace links
        // this entity instead of re-creating it.
        if (options?.idempotency && idemExternalId) {
          await options.idempotency.register(
            realId,
            options.idempotency.provider,
            idemExternalId
          );
          idemSeenThisCall.add(idemExternalId);
        }
      }

      // External records this entity mirrors (a connection sync's Google event,
      // contact, …) — registered through the same link door on EVERY resolution
      // path (created, retry-linked, deduped, pinned existing), so an approved
      // import carries its provider links + url + connection immediately instead
      // of waiting for a later sync to adopt the entity.
      if (op.externalLinks && op.externalLinks.length > 0) {
        if (options?.idempotency) {
          for (const link of op.externalLinks) {
            await options.idempotency.register(
              realId,
              link.provider,
              link.externalId,
              { url: link.url ?? null, connectionId: link.connectionId ?? null }
            );
          }
        } else {
          logger.warn(
            { ref: op.ref, count: op.externalLinks.length },
            "materialize-composite: op declares externalLinks but the caller passed no link door (idempotency) — links NOT registered"
          );
        }
      }

      registerEntityRef(refToRealId, i, op.ref, realId, !primaryId);
      if (!primaryId) primaryId = realId;
      entities.push({
        ref: op.ref,
        opIndex: i,
        entityId: realId,
        profileSlug: resultProfileSlug,
        linked: linkedExisting,
        ...(op.targetWorkspaceId ? { workspaceId: op.targetWorkspaceId } : {}),
        ...(opProjectId ? { projectId: opProjectId } : {}),
        ...(degradedFrom ? { degradedFrom } : {}),
        ...(propertiesDropped ? { propertiesDropped: true as const } : {}),
        ...(contentDropped ? { contentDropped: true as const } : {}),
        ...(documentId ? { documentId } : {}),
        ...(propertyDiff ? { propertyDiff } : {}),
        ...(linkedByRetry ? { linkedByRetry } : {}),
      });

      // Declared facets are attached in pass 1.5 below (once every create_entity
      // op has resolved), not here — a facet's `contextRef` may point at an
      // entity created LATER in this same batch, which pass 1 can't resolve yet.
      if (op.facets && op.facets.length > 0) {
        pendingFacetAttaches.push({
          opIndex: i,
          ...(op.ref ? { ref: op.ref } : {}),
          realId,
          facets: op.facets,
        });
      }
    }

    // Pass 1.5 — declared facets (Kind + Facets), after every create_entity op
    // has resolved so refToRealId is fully populated: a facet's `contextRef` can
    // now point at ANY entity in the batch, including one created after it.
    // Additive — only ops carrying `facets` AND a caller that opted in via
    // options.facetCaller attach anything. A failed attach is logged and
    // skipped, never discarding the entity.
    //
    // Re-approval idempotency verdict: `FacetRepository.attach` (@synap/database)
    // catches the unique-index violation on (entityId, profileId, contextEntityId,
    // workspaceId) and returns the existing live row instead of throwing —
    // packages/database/src/repositories/facet-repository.ts:194-205. The
    // `entities.attachFacet` tRPC door (facetCaller here) surfaces that returned
    // row as its normal `{ status: "attached" }` success response — it never
    // inspects "was this a fresh insert or a conflict" —
    // packages/api/src/routers/entities.ts:1993-2046. So a same-(entity, profile,
    // context, workspace) facet attach replayed twice is already a no-op success,
    // not an error. In practice a full proposal re-approval can't reach this path
    // at all: `proposals.approve` rejects any non-PENDING proposal up front
    // (packages/api/src/routers/proposals.ts:2231-2235, "Already ${status}"), so
    // this idempotency only matters for a retry WITHIN one approve/import call
    // (e.g. materialize resumed after a partial failure) — no extra guard needed.
    if (options?.facetCaller) {
      for (const { opIndex, ref, realId, facets } of pendingFacetAttaches) {
        currentOpIndex = opIndex;
        for (const facetOp of facets) {
          try {
            const contextEntityId = facetOp.contextRef
              ? resolveCompositeRef(refToRealId, facetOp.contextRef)
              : undefined;
            const attached = await options.facetCaller.attachFacet({
              entityId: realId,
              profileSlug: facetOp.profileSlug,
              status: facetOp.status,
              properties: facetOp.properties,
              ...(contextEntityId ? { contextEntityId } : {}),
              source: materializeSource,
            });
            const facetId = (attached as { facetId?: unknown } | undefined)
              ?.facetId;
            if (
              (attached as { status?: string } | undefined)?.status ===
                "attached" &&
              typeof facetId === "string"
            ) {
              facetResults.push({
                opIndex,
                ...(ref ? { ref } : {}),
                entityId: realId,
                facetId,
                profileSlug: facetOp.profileSlug,
              });
            } else if (planMode) {
              throw new Error(
                `facet ${facetOp.profileSlug} did not attach (${String((attached as { status?: unknown } | undefined)?.status ?? "no status")})`
              );
            }
          } catch (err) {
            logger.warn(
              { err, entityId: realId, profileSlug: facetOp.profileSlug },
              "Skipping composite facet attach (entity kept)"
            );
            failPlanStep(opIndex, err);
          }
        }
      }
    }

    // ── Plan pass P0b — PROJECT SUBJECTS ───────────────────────────────────
    // After the entities, so a subject may be an entity this plan creates.
    if (planCallers) {
      for (const project of projectResults) {
        const op = operations[project.opIndex];
        if (op.op !== "create_project") continue;
        const subjectEntityId =
          op.subjectEntityId ??
          (op.subjectRef
            ? resolveCompositeRef(refToRealId, op.subjectRef)
            : undefined);
        if (!subjectEntityId) continue;
        currentOpIndex = project.opIndex;
        // A REUSED project (the door matched an existing one by name) is
        // somebody's live project: rebinding its subject from this plan would
        // silently retitle it — the same reason `projects.create` skips the
        // bind on a dedup. The step fails instead of doing half of itself.
        if (project.linked) {
          failPlanStep(
            project.opIndex,
            `an active project named "${op.name}" already exists (${project.projectId}); the plan would rebind its subject — rename the project step or drop its subject`
          );
        }
        await planCallers.projectCaller.setSubject({
          projectId: project.projectId,
          subjectEntityId,
        });
        project.subjectEntityId = subjectEntityId;
      }
    }

    // Pass 2 — relations via the shared loop (resolution + create guarded
    // per-relation; a malformed/failed relation is reported and skipped, never
    // discarding the entities already created).
    const relationOpIndexes: number[] = [];
    const relationOps = operations
      .map((op, index) => ({ op, index }))
      .filter(({ op }) => op.op === "create_relation")
      .map(({ op, index }) => {
        relationOpIndexes.push(index);
        const r = op as Extract<
          CompositeProposalOperation,
          { op: "create_relation" }
        >;
        return { sourceRef: r.sourceRef, targetRef: r.targetRef, type: r.type };
      });
    relations = await createRelationsFromRefs(
      relationOps,
      refToRealId,
      relationCaller,
      {
        resolveRelationType: options?.resolveRelationType,
        onError: (err, type, refs) => {
          relationsFailed.push({ ...refs, type, reason: errorReason(err) });
          onRelationError?.(err, type);
        },
        relationExists: options?.idempotency?.relationExists,
        ownedRelationId: options?.idempotency?.ownedRelationId,
      }
    );
    if (planMode && relationsFailed.length > 0) {
      const failed = relationsFailed[0];
      const at = relationOps.findIndex(
        (r) =>
          r.sourceRef === failed.sourceRef &&
          r.targetRef === failed.targetRef &&
          r.type === failed.type
      );
      failPlanStep(
        relationOpIndexes[at] ?? relationOpIndexes[0],
        failed.reason
      );
    }

    if (planCallers) {
      // ── Plan pass P1 — SESSIONS, parents before children ───────────────
      for (const i of sessionOpsRootFirst(operations)) {
        const op = operations[i];
        if (op.op !== "create_session") continue;
        currentOpIndex = i;
        const session = await planCallers.sessionCaller.create({
          title: op.title ?? null,
          goal: op.goal,
          subjectEntityId:
            op.subjectEntityId ??
            (op.subjectRef
              ? resolveCompositeRef(refToRealId, op.subjectRef)
              : null),
          projectId:
            op.projectId ??
            (op.projectRef
              ? resolveCompositeRef(refToRealId, op.projectRef)
              : null),
          expectedOutputs: op.expectedOutputs ?? [],
        });
        registerEntityRef(refToRealId, i, op.ref, session.id, false);
        sessionResults.push({
          ref: op.ref,
          opIndex: i,
          sessionId: session.id,
          ...(session.linked ? { linked: true } : {}),
        });
      }

      // ── Plan pass P2 — SESSION EDGES (parent + blockers + link ops) ────
      // After EVERY session exists, so an edge may point either way in the
      // plan. One list, derived by the same function the preflight checked.
      for (const edge of planSessionEdges(operations)) {
        currentOpIndex = edge.opIndex;
        const endpoint = (end: PlanSessionEdge["from"]) =>
          "ref" in end
            ? resolveCompositeRef(refToRealId, end.ref)
            : end.sessionId;
        const fromSessionId = endpoint(edge.from);
        const toSessionId = endpoint(edge.to);
        const link = await planCallers.linkCaller.create({
          type: edge.type,
          fromSessionId,
          toSessionId,
        });
        linkResults.push({
          opIndex: edge.opIndex,
          type: edge.type,
          fromSessionId,
          toSessionId,
          requested: {
            from: "ref" in edge.from ? edge.from.ref : edge.from.sessionId,
            to: "ref" in edge.to ? edge.to.ref : edge.to.sessionId,
          },
          ...(link.linkId ? { linkId: link.linkId } : {}),
          ...(link.preExisting ? { preExisting: true as const } : {}),
        });
      }

      // ── Plan pass P3 — DOCUMENTS ────────────────────────────────────────
      // Last of the plan's objects: a document may attach to an entity or be
      // recorded as a session's output, and nothing in the plan points AT a
      // document — so a failure here leaves the least to compensate.
      for (let i = 0; i < operations.length; i++) {
        const op = operations[i];
        if (op.op !== "create_document") continue;
        currentOpIndex = i;
        const entityId =
          op.entityId ??
          (op.entityRef
            ? resolveCompositeRef(refToRealId, op.entityRef)
            : null);
        const sessionId =
          op.sessionId ??
          (op.sessionRef
            ? resolveCompositeRef(refToRealId, op.sessionRef)
            : null);
        const document = await planCallers.documentCaller.create({
          title: op.title,
          content: op.content,
          entityId,
          sessionId,
          expectedLabel: op.expectedLabel ?? null,
        });
        registerEntityRef(refToRealId, i, op.ref, document.id, false);
        documentResults.push({
          ref: op.ref,
          opIndex: i,
          documentId: document.id,
          ...(entityId ? { attachedEntityId: entityId } : {}),
          ...(sessionId ? { recordedOnSessionId: sessionId } : {}),
        });
      }
    }

    // ── Pass 3 — Rule Loop RULE ops (NS1) ──────────────────────────────────
    // Runs LAST so `factRef` / `behaviourRefs` resolve against the fully
    // populated map (skills + automations from pass 0, entities from pass 1).
    // Resolution is `resolveCompositeRef` — the same helper relations use — so a
    // ref may be an in-batch op ref OR a real UUID for a pre-existing object.
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.op !== "create_rule") continue;
      currentOpIndex = i;
      if (!options?.ruleCaller) {
        // Unreachable — the fail-closed preflight above already refused this
        // batch. Kept as a narrowing guard that THROWS (never skips), so the
        // silent-skip shape cannot come back by way of a refactor.
        throw new Error(
          "materializeCompositeGraph: create_rule op reached pass execution with no ruleCaller (preflight bypassed)"
        );
      }
      try {
        const factSkillId = op.factRef
          ? resolveCompositeRef(refToRealId, op.factRef)
          : undefined;
        const automationIds = (op.behaviourRefs ?? []).map((behaviourRef) =>
          resolveCompositeRef(refToRealId, behaviourRef)
        );
        const created = await options.ruleCaller.create({
          intent: op.intent,
          scope: op.scope,
          ...(factSkillId ? { factSkillId } : {}),
          automationIds,
        });
        registerEntityRef(refToRealId, i, op.ref, created.id, false);
        ruleResults.push({
          ref: op.ref,
          opIndex: i,
          ruleId: created.id,
          ...(factSkillId ? { factSkillId } : {}),
          automationIds,
        });
      } catch (err) {
        logger.warn(
          { err, ref: op.ref },
          "Skipping create_rule op (batch continues)"
        );
        failPlanStep(i, err);
      }
    }
  } catch (err) {
    // Outside a plan a throw keeps its historic meaning: it propagates, and
    // whatever landed before it stays (the per-op resilience above is what
    // limits that). Inside a plan, nothing is allowed to half-land.
    if (!planMode || !planCallers) throw err;
    const failedOp = operations[currentOpIndex];
    const failedRef = (failedOp as { ref?: unknown } | undefined)?.ref;
    const failure: PlanStepFailure =
      err instanceof PlanStepAbort
        ? err.failure
        : {
            opIndex: currentOpIndex,
            ...(typeof failedRef === "string" && failedRef
              ? { ref: failedRef }
              : {}),
            op: failedOp?.op ?? "create_entity",
            reason: errorReason(err),
          };
    const applied = buildResult();
    let compensation: PlanCompensationReport;
    try {
      compensation = await planCallers.compensate(applied);
    } catch (compensateErr) {
      // The undo itself failed: name EVERY applied row as not compensated
      // rather than reporting a clean rollback that did not happen.
      logger.error(
        { err: compensateErr, failure },
        "materializeCompositeGraph: plan compensation failed — applied rows remain"
      );
      compensation = {
        undone: {},
        notCompensated: appliedRowsOf(applied).map((row) => ({
          ...row,
          reason: `compensation failed: ${errorReason(compensateErr)}`,
        })),
      };
    }
    throw new CompositePlanApplyError([failure], compensation);
  }

  return buildResult();
}
