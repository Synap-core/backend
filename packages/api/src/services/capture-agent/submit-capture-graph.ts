/**
 * submitCaptureGraph — the shared core of the `POST /api/hub/capture/graph` door.
 *
 * Extracted from the Hono route handler (routers/hub-protocol/rest/capture.ts) so
 * BOTH the HTTP door AND in-process producers (the Cal.com booking webhook, the
 * Cal.com backfill poller) create the SAME one-reviewable-composite proposal
 * through the SAME code path — within-batch dedup → persisted-entity dedup → the
 * governed composite proposal. No hand-rolled entity writer.
 *
 * The route keeps its own request parsing + ref validation and calls this with
 * already-validated arrays. In-process callers build the arrays via a mapper
 * (which guarantees valid refs) and call this directly.
 *
 * TWO TERMINALS, ONE CORE (mode DERIVED from identity, never a caller flag):
 *   - agent mode (`agentUserId` present): the graph is scored against the ONE
 *     agent policy evaluator (`resolveAgentGovernanceDecision`). All-or-nothing:
 *     when EVERY op auto-approves (and there are no channel bindings) it is
 *     MATERIALIZED now as a direct operator write + recorded `auto_approved`
 *     (revertible). Any non-approvable op → the whole graph proposes.
 *   - pending (webhooks/cron, agent-propose, and the human confirm door): the
 *     durable `import.graph` pending proposal — the plan the human confirms via
 *     `proposals.approve`. This is what makes an abandoned plan a VISIBLE
 *     uncommitted proposal instead of a silent false-success.
 */

import { randomUUID } from "crypto";
import { boundRawSourceText } from "./capture-narrative.js";
import {
  materializedReceiptState,
  type CaptureReceiptState,
} from "./capture-receipt-state.js";

import {
  db,
  resolveIdentity,
  extractIdentitySignals,
  eq,
  and,
  or,
  isNull,
  entities,
  projects,
  getWorkspaceMembership,
  ProfileResolutionService,
  PropertyValidationService,
  resolveGraphWorkspaceFromSlugs,
  reservedEntityKindReason,
  deriveProposalProjectId,
} from "@synap/database";
import { getAgentFocusProjectId } from "../agent-identity-service.js";
import { ownerPrivateVisibleWhere } from "../../utils/user-visible-where.js";
import { createLogger } from "@synap-core/core";
import {
  type HubWriteSource,
  isPlanBatch,
  type CompositeProposalOperation,
  type CompositeCreateDocumentOp,
  type CompositeCreateLinkOp,
  type CompositeCreateProjectOp,
  type CompositeCreateSessionOp,
  type PlanProjectEvidence,
} from "@synap-core/types/proposals";
import { buildPlanCallers } from "../../utils/plan-callers.js";
import { preflightPlanOperations } from "./capture-plan-preflight.js";
import {
  planStepSummaries,
  type CapturePlanProblem,
  type PlanStepSummary,
} from "./capture-plan.js";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
import {
  createEventBackedProposal,
  createAutoApprovedProposal,
} from "../../utils/event-backed-proposal.js";
import {
  materializeCompositeGraph,
  type MaterializeRelationFailure,
} from "../../utils/materialize-composite.js";
import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";
import {
  computeCaptureGraphIdempotencyKey,
  findPriorCaptureGraphProposal,
  findPendingSignalMatches,
  type PendingSignalMatch,
} from "../../utils/pending-capture-dedup.js";
import { openLink } from "../../utils/deep-links.js";
import { captureGraphEventKeys } from "./capture-graph-policy.js";
import { buildRuleLoopCallers } from "../../utils/rule-loop-callers.js";
import {
  buildMaterializedRecord,
  runMaterializationUnderReceipt,
  stampMaterialized,
} from "../proposals/stamp-materialized.js";
import { loadRelationTypeValidator } from "../../utils/relation-types.js";
import { resolveCaptureProjectRef } from "./resolve-capture-project.js";
import {
  storedScopeOfProposal,
  type StoredCaptureScope,
} from "./stored-capture-scope.js";
import {
  collapseDuplicateEntities,
  type CaptureGraphEntity,
  type CaptureGraphRelation,
  type CaptureGraphBinding,
} from "../../routers/hub-protocol/rest/_capture-graph-dedup.js";
import {
  computeImportHomes,
  stampScopeAwareHomesOnOps,
} from "../import/structuring.js";

const logger = createLogger({ module: "submit-capture-graph" });

/** One flagged create_entity op that fails its EFFECTIVE schema at propose time. */
export interface CaptureGraphInvalidEntity {
  /** Human label for the reviewer/agent (op title, falling back to its ref). */
  label: string;
  profileSlug: string;
  /** Validator messages, each already naming a missing-required/type violation. */
  errors: string[];
}

/**
 * A create_entity op carrying property keys its profile does not model. They
 * are still STORED verbatim (the validator's flexible-schema tolerance), so
 * this is advisory, never a rejection. A capture used to accept them in
 * silence — that is how `knowledgeform` (for `knowledgeForm`) reached a pod as
 * a key nothing reads. Same entries the entity doors put on their receipt.
 */
export interface CaptureGraphUnmodeledEntity {
  label: string;
  profileSlug: string;
  unmodeled: Array<{ key: string; didYouMean?: string }>;
}

/**
 * A capture graph carried a `create_entity` op that CANNOT materialize — a
 * required property is missing (or a value fails its type/constraint). A graph
 * is atomic, so the WHOLE graph is rejected and NOTHING is queued: the failure
 * is raised HERE, at submit, instead of surfacing when the human approves.
 *
 * The message is model-facing (MCP renders `.message` via `toSafeToolError`;
 * the REST door returns it as a 400) — it names each flagged entity + its
 * missing required property, with a soft hint for the artifact-backed case.
 */
export class CaptureGraphValidationError extends Error {
  readonly invalidEntities: CaptureGraphInvalidEntity[];
  /** Plan structure / ownership problems (connected plans only). */
  readonly planProblems: CapturePlanProblem[];
  constructor(
    invalidEntities: CaptureGraphInvalidEntity[],
    planProblems: CapturePlanProblem[] = []
  ) {
    const n = invalidEntities.length;
    const planLines = planProblems.map(
      (p) =>
        `• plan step ${p.op}${p.ref ? ` "${p.ref}"` : ""} (#${p.opIndex}): ${p.message}`
    );
    const lines = invalidEntities.map((e) => {
      const needsArtifact = e.errors.some((m) =>
        /'storageKey' is required/.test(m)
      );
      const hint = needsArtifact
        ? " — this profile needs an uploaded artifact; it can't be created by reference (capture it as a note, or upload the file first)"
        : "";
      return `• "${e.label}" (${e.profileSlug}): ${e.errors.join("; ")}${hint}`;
    });
    super(
      n > 0
        ? `Capture rejected — ${n} entit${n === 1 ? "y" : "ies"} can't be created as described, so nothing was queued:\n${[...lines, ...planLines].join("\n")}\nFix or drop the flagged entit${n === 1 ? "y" : "ies"} and resubmit.`
        : `Plan rejected — ${planProblems.length} problem${planProblems.length === 1 ? "" : "s"}, so nothing was queued:\n${planLines.join("\n")}\nFix every step above and resubmit.`
    );
    this.name = "CaptureGraphValidationError";
    this.invalidEntities = invalidEntities;
    this.planProblems = planProblems;
  }
}

/**
 * A connected PLAN riding a capture graph: the non-entity steps, each with a
 * `ref` in the SAME namespace as `entities[].ref`. Shapes are the composite
 * ops minus their discriminant (see `CompositeCreateSessionOp` et al.).
 */
export interface CapturePlanInput {
  sessions?: Array<Omit<CompositeCreateSessionOp, "op">>;
  documents?: Array<Omit<CompositeCreateDocumentOp, "op">>;
  /** `evidence` is server-stamped; a caller-supplied one is ignored. */
  projects?: Array<Omit<CompositeCreateProjectOp, "op" | "evidence">>;
  links?: Array<Omit<CompositeCreateLinkOp, "op">>;
}

/** One plan step on a submit receipt — self-describing for the reviewer/agent. */
export interface CapturePlanStepReceipt extends PlanStepSummary {
  /**
   * `pending`: nothing exists yet, `id` is null — ids are assigned when the
   * plan applies, and are then read off the proposal's
   * `data.materialized.byOp[ref]`. `applied`: `id` is the live row.
   */
  state: "pending" | "applied";
  id: string | null;
  /** `create_project` only: the pod's evidence verdict. */
  evidence?: PlanProjectEvidence;
}

/** True when a plan input carries any step. */
export function hasPlanSteps(plan: CapturePlanInput | undefined): boolean {
  return (
    (plan?.sessions?.length ?? 0) +
      (plan?.documents?.length ?? 0) +
      (plan?.projects?.length ?? 0) +
      (plan?.links?.length ?? 0) >
    0
  );
}

/**
 * Rewire plan refs that pointed at an entity the within-batch collapse dropped
 * onto its survivor — the same rewrite relations get, so no ref dangles.
 */
function rewritePlanEntityRefs(
  plan: CapturePlanInput | undefined,
  rewrites: Record<string, string>
): CapturePlanInput | undefined {
  if (!plan || Object.keys(rewrites).length === 0) return plan;
  const r = (ref: string | undefined) =>
    ref === undefined ? undefined : (rewrites[ref] ?? ref);
  return {
    ...plan,
    sessions: plan.sessions?.map((s) => ({
      ...s,
      ...(s.subjectRef ? { subjectRef: r(s.subjectRef) } : {}),
    })),
    documents: plan.documents?.map((d) => ({
      ...d,
      ...(d.entityRef ? { entityRef: r(d.entityRef) } : {}),
    })),
    projects: plan.projects?.map((p) => ({
      ...p,
      ...(p.subjectRef ? { subjectRef: r(p.subjectRef) } : {}),
      ...(p.evidenceRefs
        ? {
            evidenceRefs: [
              ...new Set(p.evidenceRefs.map((x) => r(x) as string)),
            ],
          }
        : {}),
    })),
  };
}

/** Receipt steps for a set of ops — pending (ids null) unless `ids` names them. */
function planStepReceipts(
  operations: CompositeProposalOperation[],
  idsByOpIndex?: Map<number, string>
): CapturePlanStepReceipt[] {
  return planStepSummaries(operations).map((step) => {
    const op = operations[step.opIndex];
    const id = idsByOpIndex?.get(step.opIndex) ?? null;
    return {
      ...step,
      state: idsByOpIndex ? "applied" : "pending",
      id,
      ...(op.op === "create_project" && op.evidence
        ? { evidence: op.evidence }
        : {}),
    };
  });
}

export interface SubmitCaptureGraphInput {
  /** The proposing/acting user (operator or the Capture agent actor). */
  userId: string;
  /**
   * The acting AGENT user id, when an agent key drove this call (MCP). Its
   * PRESENCE is what enables agent-mode auto-apply (derived mode — never a
   * caller-chosen flag): the graph is scored against the ONE agent policy
   * evaluator and, when EVERY op auto-approves (and there are no channel
   * bindings), it is materialized immediately as a direct operator write +
   * recorded `auto_approved`. Absent (webhooks/cron/human confirm door) → always
   * a pending proposal, exactly as before.
   */
  agentUserId?: string | null;
  /** Workspace to scope the proposal to (null = pod-wide). */
  workspaceId?: string | null;
  /** Existing project to file each newly-created graph entity into on approval. */
  projectId?: string | null;
  /**
   * A project NAME-ref (piece D). Resolved to `projectId` via an EXACT slug
   * match on the caller's OWN projects (a rung-1 pin). No match → NOT linked
   * (the widening-access law forbids auto-linking a guess); surfaced on the
   * result as `projectCandidate`. Ignored when `projectId` is already set.
   */
  projectName?: string | null;
  /** Origin signal carried through the proposal into entity materialization. */
  source?: HubWriteSource;
  sourceMessageId?: string;
  /**
   * Channel/thread that originated this graph — the SAME field name +
   * `proposals.thread_id` (FK → `channels.id`) column the REST `POST
   * /proposals` door already maps `channelId` onto (see
   * `routers/hub-protocol/rest/proposals.ts`: `threadId: body.channelId`).
   * Threaded through here so a channel-sourced producer (e.g. `message.
   * interpret`) that has a channel but no `sourceMessageId` still leaves a
   * back-reference a UI can deep-link from.
   */
  channelId?: string | null;
  sessionId?: string;
  /** How `sessionId` was arrived at — see `SessionSource` (@synap/database). */
  sessionSource?: "explicit" | "derived";
  /**
   * The originating input (the user's instruction, the webhook body, the
   * captured text) retained ONLY in proposal data for review/retry. Not a
   * materialized source entity/document or shared provenance artifact after
   * approval.
   *
   * `rawText` is bounded HERE, by this function, to `RAW_SOURCE_MAX_CHARS`
   * (capture-narrative.ts) — callers do NOT need to slice, and must not invent
   * their own cap. This doc used to assert a bound the function never applied,
   * which is exactly how three different caller-side caps (100_000 / 8_000 /
   * none) came to exist.
   */
  rawSource?: {
    rawText?: string;
    sourceUrl?: string;
    label?: string;
    mimeType?: string;
    hash?: string;
    idempotencyKey?: string;
  };
  entities: CaptureGraphEntity[];
  relations?: CaptureGraphRelation[];
  bindings?: CaptureGraphBinding[];
  /**
   * A connected plan (sessions / documents / projects / session edges) filed
   * in the SAME proposal as the entities — one reviewable unit that applies
   * all-or-none. Refs share the entity ref namespace.
   */
  plan?: CapturePlanInput;
  summary?: string;
}

export interface SubmitCaptureGraphResult {
  proposalId: string | undefined;
  entityCount: number;
  relationCount: number;
  bindingCount: number;
  reviewUrl: string | undefined;
  summary: string;
  /** True when the graph was materialized immediately (agent-mode auto-apply). */
  applied: boolean;
  /**
   * Connected plan only: every step (entities and relations included), with
   * its ref, kind and label. Pending steps carry `id: null` — ids exist only
   * once the plan applies. Omitted for a graph with no plan step.
   */
  plan?: { steps: CapturePlanStepReceipt[] };
  /** The session this proposal was filed in (its room is where it is discussed). */
  sessionId?: string | null;
  /**
   * Where the write was STORED — read off the proposal row the insert returned
   * (or, on a re-submit, the PRIOR row), never the call's inputs: the insert
   * runs the project ladder (incl. declared focus) and may mint an agent
   * receipt session. Only when an auto-apply's receipt row failed to insert
   * (no row exists) does it fall back to the values the entities were
   * materialized with.
   */
  scope: StoredCaptureScope;
  /** True when this call returned a PRIOR proposal instead of filing one. */
  deduped?: true;
  /**
   * ADVISORY: entities whose properties carry keys their profile does not
   * model (stored verbatim, not queryable), with a `didYouMean` when a real
   * property is close. Omitted when every key is modelled.
   */
  unmodeledProperties?: CaptureGraphUnmodeledEntity[];
  /**
   * ADVISORY in-flight-duplicate warnings: incoming graph entities whose STRONG
   * signal (email/phone/url/handle) collides with a create_entity op in the
   * caller's OWN pending capture/import proposal. NEVER auto-linked — a pending
   * proposal can still be rejected, so linking to it would stale-suppress a real
   * write. Surfaced so the caller/agent can wait for review instead of filing a
   * second copy. Omitted when nothing collides.
   */
  pendingDuplicateCandidates?: Array<{
    /** The incoming graph entity ref that collided. */
    ref: string;
    title: string;
    matches: PendingSignalMatch[];
  }>;
  /**
   * A `projectName` that matched no project of the caller (piece D). Advisory
   * only — surfaced so the caller can confirm/create it; NEVER auto-linked.
   */
  projectCandidate?: { name: string };
  /**
   * Per-coordinate PROJECT outcome — `linked` when a real pin stamped
   * membership, `not_linked` (+reason: `project-not-found` for a dead UUID pin,
   * `project-name-unmatched` for a name-ref that matched nothing) so a requested
   * project that did NOT link is NAMED, never a silent success. Omitted when no
   * project was requested.
   */
  project?:
    | { status: "linked"; projectId: string }
    | { status: "not_linked"; reason: string };
  /**
   * Relation ops that were SUBMITTED (via `relations`/`operations`) but never
   * created (bad ref, DB failure). Only ever populated on the `applied: true`
   * path — a `pending` proposal hasn't materialized anything yet, so nothing
   * can have failed. Omitted when nothing failed.
   */
  relationsFailed?: MaterializeRelationFailure[];
  writeReceipt: {
    /**
     * `partial` is the Hub Protocol receipt word for exactly this shape (see
     * `CreateWriteReceipt` in routers/hub-protocol/write-receipt.ts): "storage
     * changed for SOME sub-writes and failed for others — the primary write
     * landed and a non-atomic follow-up errored. Never a claim of rollback."
     *
     * A capture graph's relations ARE that non-atomic follow-up: pass 1 creates
     * the entities, pass 2 creates each edge independently, and a relation whose
     * TYPE does not resolve fails alone. Before this, such a graph returned
     * `applied` with `relationCount: 0` and the failures buried in
     * `relationsFailed[]` — a caller that did not read that array believed the
     * whole graph landed. Same class as `status ?? "installed"`: a partial
     * success reported as a clean success, and the reader has to opt IN to the
     * bad news. The word is reused, not invented — no new enum, no label map.
     */
    state: CaptureReceiptState;
    proposalId?: string;
    reviewUrl?: string;
    effectiveWorkspaceId: string | null;
    projectId?: string;
    project?:
      | { status: "linked"; projectId: string }
      | { status: "not_linked"; reason: string };
    source: string;
    /** applied path only: fresh-created vs linked-existing counts + ids. */
    created?: number;
    linked?: number;
    entityIds?: string[];
  };
}

/**
 * Build + file the composite graph proposal. Callers MUST have validated that
 * every relation/binding ref exists among `entities` (the HTTP door does this;
 * mappers construct refs by hand so they're always valid).
 */
/** Bounds on the persisted duplicate advisory — a risk signal, not an entity dump. */
const DUPLICATE_ADVISORY_MAX_CANDIDATES = 25;
const DUPLICATE_ADVISORY_MAX_MATCHES_PER_CANDIDATE = 5;

type CaptureGraphDb = typeof db;

/**
 * THE composite ops a capture graph files, with scope-aware homes stamped.
 * Extracted from `submitCaptureGraph` (which calls it) so the `validate: true`
 * dry run validates the SAME ops a real submit would — never a second mapping.
 */
export async function buildCaptureGraphOperations(
  database: CaptureGraphDb,
  input: {
    entities: CaptureGraphEntity[];
    relations: CaptureGraphRelation[];
    projectId: string | null;
    workspaceId: string | null;
    plan?: CapturePlanInput;
  }
): Promise<CompositeProposalOperation[]> {
  const { entities: graphEntities, relations, workspaceId } = input;
  const resolvedProjectId = input.projectId;
  const plan = input.plan;
  const operations: CompositeProposalOperation[] = [
    ...graphEntities.map((e) => ({
      op: "create_entity" as const,
      ref: e.ref,
      profileSlug: e.profileSlug,
      // A plan's own project wins over the call-level project pin.
      ...(e.projectRef
        ? { projectRef: e.projectRef }
        : resolvedProjectId
          ? { projectId: resolvedProjectId }
          : {}),
      title: e.title ?? e.ref,
      ...(e.description ? { description: e.description } : {}),
      ...(e.content ? { content: e.content } : {}),
      properties: e.properties ?? {},
      ...(e.existingEntityId ? { existingEntityId: e.existingEntityId } : {}),
      ...(e.facets ? { facets: e.facets } : {}),
      // Per-op pin when the producer already multi-homed (parity with import).
      ...(e.targetWorkspaceId
        ? { targetWorkspaceId: e.targetWorkspaceId }
        : {}),
    })),
    ...relations.map((r) => ({
      op: "create_relation" as const,
      sourceRef: r.sourceRef,
      targetRef: r.targetRef,
      type: r.type,
    })),
    // ── Connected plan steps ─────────────────────────────────────────────
    // `evidence` is dropped here and stamped by the preflight — never trusted.
    ...(plan?.projects ?? []).map(
      ({
        evidence: _ignored,
        ...p
      }: Omit<CompositeCreateProjectOp, "op"> & {
        evidence?: unknown;
      }) => ({ op: "create_project" as const, ...p })
    ),
    ...(plan?.sessions ?? []).map((sess) => ({
      op: "create_session" as const,
      ...sess,
      // The call-level project pin files a session that names none.
      ...(!sess.projectRef && !sess.projectId && resolvedProjectId
        ? { projectId: resolvedProjectId }
        : {}),
    })),
    ...(plan?.documents ?? []).map((d) => ({
      op: "create_document" as const,
      ...d,
    })),
    ...(plan?.links ?? []).map((l) => ({ op: "create_link" as const, ...l })),
  ];

  // Scope-aware homes (shared with import): stamp process kinds into the graph
  // home; leave pod-scope identity unpinned. Replaces blanket workspaceScoped
  // on materialize — pin ≠ exclusive for person/company/knowledge.
  if (workspaceId) {
    const homeScope = new ProfileResolutionService(database);
    await stampScopeAwareHomesOnOps(operations, workspaceId, (slug) =>
      homeScope.getEntityScope(slug, workspaceId)
    );
  }
  return operations;
}

/**
 * PREFLIGHT: never queue what can't materialize. Validates every NEW
 * `create_entity` op against its EFFECTIVE schema with the SAME
 * `validateProperties` path the materializer runs. The ONE implementation —
 * `submitCaptureGraph` throws `CaptureGraphValidationError` on
 * `invalidEntities`; the dry run reports them.
 *
 * `unmodeledProperties` lists ops carrying keys their profile does not model —
 * advisory, reported by both the dry run and the submit result.
 *
 * `unresolvedProfiles` lists ops whose profile did not resolve for the lens.
 * Submit does NOT reject on it (a cold profile lens can fail open, and
 * unknown-slug graphs are a separate guard); the dry run reports it.
 */
export async function preflightCaptureGraphOperations(
  database: CaptureGraphDb,
  operations: CompositeProposalOperation[],
  userId: string,
  workspaceId: string | null
): Promise<{
  invalidEntities: CaptureGraphInvalidEntity[];
  unmodeledProperties: CaptureGraphUnmodeledEntity[];
  unresolvedProfiles: Array<{ label: string; profileSlug: string }>;
  /** Connected plan: every structure / ownership problem (empty otherwise). */
  planProblems: CapturePlanProblem[];
  /** The ops to file — plan `create_project` steps carry the stamped evidence. */
  operations: CompositeProposalOperation[];
}> {
  const unresolvedProfiles: Array<{ label: string; profileSlug: string }> = [];
  const profileResolution = new ProfileResolutionService(database);
  const propertyValidation = new PropertyValidationService(profileResolution);
  const invalidEntities: CaptureGraphInvalidEntity[] = [];
  const unmodeledProperties: CaptureGraphUnmodeledEntity[] = [];
  for (const op of operations) {
    if (op.op !== "create_entity") continue;
    // Linking an existing entity materializes nothing new — no props to check.
    if (op.existingEntityId) continue;
    // RESERVED KINDS (e.g. `project`) are refused HERE, with the floor's own
    // wording — not filed as a proposal that `entities.create` refuses at
    // approve. A project is a plan step, never an entity.
    const reservedReason = reservedEntityKindReason(op.profileSlug);
    if (reservedReason) {
      invalidEntities.push({
        label: op.title || op.ref || op.profileSlug,
        profileSlug: op.profileSlug,
        errors: [
          `${reservedReason} In a capture, send it as a \`projects[]\` step instead (a plan step, filed in the same proposal).`,
        ],
      });
      continue;
    }
    const profile = await profileResolution.resolveProfile(
      op.profileSlug,
      userId,
      workspaceId
    );
    // Unknown profile ⇒ don't NEWLY reject here (a cold profile lens can
    // fail-open, and unknown-slug graphs are a separate guard). Required-prop
    // preflight is scoped to KNOWN profiles — exactly the materializer's check.
    if (!profile) {
      unresolvedProfiles.push({
        label: op.title || op.ref || op.profileSlug,
        profileSlug: op.profileSlug,
      });
      continue;
    }
    const propsToCheck: Record<string, unknown> = { ...(op.properties ?? {}) };
    // `content` is folded in the way the materializer does (a long body becomes
    // a linked document, a short one inlines to properties.content) so a profile
    // that required `content` isn't falsely flagged when a body was provided.
    if (op.content) propsToCheck.content = op.content;
    const { valid, errors, unmodeled } =
      await propertyValidation.validateEntityCreateForProposal(
        propsToCheck,
        profile.id,
        workspaceId,
        {
          ...(op.title !== undefined ? { title: op.title } : {}),
          profileDefaults:
            (profile.defaultValues as Record<string, unknown>) ?? {},
        }
      );
    if (!valid) {
      invalidEntities.push({
        label: op.title || op.ref || op.profileSlug,
        profileSlug: op.profileSlug,
        errors,
      });
    }
    if (unmodeled.length > 0) {
      unmodeledProperties.push({
        label: op.title || op.ref || op.profileSlug,
        profileSlug: op.profileSlug,
        unmodeled,
      });
    }
  }
  // CONNECTED PLAN: ref integrity, cycles, limits, ownership of every named
  // session/entity/project, and the project evidence verdict — the SAME check
  // on submit, on the dry run, and on every revision of a pending plan.
  if (isPlanBatch(operations)) {
    const plan = await preflightPlanOperations(database, operations, userId);
    return {
      invalidEntities,
      unmodeledProperties,
      unresolvedProfiles,
      planProblems: plan.problems,
      operations: plan.operations,
    };
  }
  return {
    invalidEntities,
    unmodeledProperties,
    unresolvedProfiles,
    planProblems: [],
    operations,
  };
}

/**
 * Validate a composite's STORED operations — the check a revision of a pending
 * graph or plan must pass (`mergeProposalRevision`). The SAME preflight a
 * submit runs (property validation, reserved kinds, plan refs / cycles /
 * limits / ownership / evidence) plus relation types through the one relation
 * vocabulary validator. Every problem at once, as sentences; `operations` is
 * the version to store (plan project steps carry the pod's evidence verdict).
 */
export async function validateCompositeOperations(
  database: CaptureGraphDb,
  input: {
    operations: CompositeProposalOperation[];
    userId: string;
    workspaceId: string | null;
  }
): Promise<{ problems: string[]; operations: CompositeProposalOperation[] }> {
  const { invalidEntities, planProblems, operations } =
    await preflightCaptureGraphOperations(
      database,
      input.operations,
      input.userId,
      input.workspaceId
    );
  const problems = [
    ...invalidEntities.map(
      (e) => `"${e.label}" (${e.profileSlug}): ${e.errors.join("; ")}`
    ),
    ...planProblems.map(
      (p) =>
        `${p.op}${p.ref ? ` "${p.ref}"` : ""} (#${p.opIndex}): ${p.message}`
    ),
  ];
  const validateRelationType = await loadRelationTypeValidator(
    database,
    input.workspaceId
  );
  operations.forEach((op, index) => {
    if (op.op !== "create_relation") return;
    try {
      validateRelationType(op.type);
    } catch (err) {
      problems.push(
        `create_relation (#${index}) ${op.sourceRef} -> ${op.targetRef}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  });
  return { problems, operations };
}

/**
 * The `validate: true` dry run of a capture graph: within-batch collapse →
 * the SAME ops builder → the SAME preflight → relation slugs through the ONE
 * relation vocabulary validator. Writes nothing.
 *
 * NOT seen (decided only at write time): identity dedup against EXISTING
 * entities (a match links instead of creating, which would skip the property
 * check for that entity), workspace re-routing of a lens-less graph, project
 * name-ref resolution, and governance.
 */
export async function dryRunCaptureGraph(
  database: CaptureGraphDb,
  input: {
    userId: string;
    workspaceId: string | null;
    entities: CaptureGraphEntity[];
    relations: CaptureGraphRelation[];
    plan?: CapturePlanInput;
  }
): Promise<{
  invalidEntities: CaptureGraphInvalidEntity[];
  unmodeledProperties: CaptureGraphUnmodeledEntity[];
  unresolvedProfiles: Array<{ label: string; profileSlug: string }>;
  relationsFailed: MaterializeRelationFailure[];
  entityCount: number;
  relationCount: number;
  /** Connected plan only (empty otherwise). */
  planProblems: CapturePlanProblem[];
  /** Connected plan only: the steps as they would be filed (pending). */
  planSteps?: CapturePlanStepReceipt[];
}> {
  const collapsed = collapseDuplicateEntities(
    input.entities,
    input.relations,
    []
  );
  const builtOperations = await buildCaptureGraphOperations(database, {
    entities: collapsed.entities,
    relations: collapsed.relations,
    projectId: null,
    workspaceId: input.workspaceId,
    plan: rewritePlanEntityRefs(input.plan, collapsed.refRewrites),
  });
  const {
    invalidEntities,
    unmodeledProperties,
    unresolvedProfiles,
    planProblems,
    operations,
  } = await preflightCaptureGraphOperations(
    database,
    builtOperations,
    input.userId,
    input.workspaceId
  );
  const validateRelationType = await loadRelationTypeValidator(
    database,
    input.workspaceId
  );
  const relationsFailed: MaterializeRelationFailure[] = [];
  for (const r of collapsed.relations) {
    try {
      validateRelationType(r.type);
    } catch (err) {
      relationsFailed.push({
        sourceRef: r.sourceRef,
        targetRef: r.targetRef,
        type: r.type,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    invalidEntities,
    unmodeledProperties,
    unresolvedProfiles,
    relationsFailed,
    entityCount: collapsed.entities.length,
    relationCount: collapsed.relations.length,
    planProblems,
    ...(isPlanBatch(operations)
      ? { planSteps: planStepReceipts(operations) }
      : {}),
  };
}

export async function submitCaptureGraph(
  input: SubmitCaptureGraphInput
): Promise<SubmitCaptureGraphResult> {
  const { userId } = input;
  let workspaceId = input.workspaceId ?? null;

  // PROJECT NAME-REF (piece D). A plan may name a project instead of passing a
  // UUID. Resolve it here, at the submit boundary, with the SAME precedence as a
  // rung-1 explicit pin — but ONLY on an exact slug match on the caller's own
  // projects. No match ⇒ NOT linked (the widening-access law forbids auto-linking
  // an AI-guessed project) ⇒ surfaced as an advisory candidate. An explicit
  // `projectId` always wins over a name.
  let resolvedProjectId = input.projectId ?? null;
  let projectCandidate: { name: string } | undefined;
  if (!resolvedProjectId && input.projectName) {
    const projectRef = await resolveCaptureProjectRef({
      userId,
      projectName: input.projectName,
    });
    if (projectRef.projectId) resolvedProjectId = projectRef.projectId;
    else if (projectRef.candidateName)
      projectCandidate = { name: projectRef.candidateName };
  }
  // An EXPLICIT UUID pin (`input.projectId`) is trusted by no one: verify it
  // references a real, visible project BEFORE it rides every create_entity op
  // as `projectId` (which stamps `belongs_to_project` at materialization).
  // `relations.target_entity_id` has NO FK to `projects`, so a pin to a
  // non-existent / invisible project would write a GHOST membership edge and the
  // receipt would falsely claim `linked` — the exact silent-drop bug. A missing
  // pin links nothing and is reported `not_linked`. (A name-ref that matched
  // nothing is already surfaced as `projectCandidate`, above.)
  let explicitPinMissing = false;
  if (resolvedProjectId && input.projectId) {
    const [pinned] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(
          eq(projects.id, resolvedProjectId),
          ownerPrivateVisibleWhere(
            projects.workspaceId,
            projects.userId,
            userId
          )
        )
      )
      .limit(1);
    if (!pinned) {
      explicitPinMissing = true;
      resolvedProjectId = null;
    }
  }
  // Per-coordinate project outcome, surfaced on the result + writeReceipt so a
  // caller (the CLI) can state what actually happened on the project axis.
  const projectOutcome:
    | { status: "linked"; projectId: string }
    | { status: "not_linked"; reason: string }
    | undefined = resolvedProjectId
    ? { status: "linked", projectId: resolvedProjectId }
    : explicitPinMissing
      ? { status: "not_linked", reason: "project-not-found" }
      : projectCandidate
        ? { status: "not_linked", reason: "project-name-unmatched" }
        : undefined;

  // WITHIN-BATCH DEDUP: the producer may list the same person/company under two
  // different `ref`s (neither persisted yet). Collapse those before resolving
  // against the DB — same key + rewrite semantics as the HTTP door.
  const collapsed = collapseDuplicateEntities(
    input.entities,
    input.relations ?? [],
    input.bindings ?? []
  );
  const graphEntities = collapsed.entities;
  const relations = collapsed.relations;
  const bindings = collapsed.bindings;
  // A plan's refs to a collapsed duplicate follow it onto the survivor.
  const planInput = hasPlanSteps(input.plan)
    ? rewritePlanEntityRefs(input.plan, collapsed.refRewrites)
    : undefined;

  // WORKSPACE PLACEMENT (routing fix): `workspaceId` null here means the caller
  // supplied no explicit lens/focus (see `input.workspaceId ?? ctx.workspaceId ??
  // null` upstream) — collect every entity + facet profileSlug in the graph and
  // run the shared graph-placement helper (ONE door + deterministic accept
  // policy). A deterministic ontology hit (rung ≤4, single candidate) re-lenses
  // the WHOLE graph into that workspace; ambiguous / no-signal ABSTAINS —
  // staying pod-wide (null) is the honest default over an arbitrary guess.
  if (workspaceId === null) {
    const routingSlugs = Array.from(
      new Set(
        graphEntities
          .flatMap((e) => [
            e.profileSlug,
            ...(e.facets?.map((f) => f.profileSlug) ?? []),
          ])
          .filter((s): s is string => typeof s === "string" && s.length > 0)
      )
    );
    try {
      workspaceId = await resolveGraphWorkspaceFromSlugs(db, {
        userId,
        routingSlugs,
        sessionId: input.sessionId,
      });
    } catch (err) {
      logger.warn(
        { err, userId },
        "capture/graph: workspace placement resolve failed — staying pod-wide"
      );
    }
  }

  const bindingNote = bindings.length
    ? `, ${bindings.length} channel bind${bindings.length === 1 ? "" : "s"}`
    : "";
  const planNote = planInput
    ? [
        [planInput.projects?.length ?? 0, "project"],
        [planInput.sessions?.length ?? 0, "session"],
        [planInput.documents?.length ?? 0, "document"],
      ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, noun]) => `, ${n} ${noun}${n === 1 ? "" : "s"}`)
        .join("")
    : "";
  const summary =
    input.summary ??
    `Proposed ${planInput ? "plan" : "graph"}: ${graphEntities.length} entit${graphEntities.length === 1 ? "y" : "ies"}, ${relations.length} link${relations.length === 1 ? "" : "s"}${planNote}${bindingNote}`;
  const source = input.source ?? "intelligence";

  // ── RE-SUBMIT IDEMPOTENCY (piece 1a) ──────────────────────────────────────
  // A masked failure (MCP timeout, an agent misreading a governed "proposed" as
  // "no approval") drives a RETRY of the exact same graph. Without a stable key,
  // entities lacking a strong signal aren't deduped → a DUPLICATE proposal. The
  // key is an explicit caller-supplied id when present (the declared rawSource.
  // idempotencyKey hook), else a CONTENT hash — so NO caller has to change and
  // two genuinely-different captures can't collide (every content field folds
  // in). A prior proposal under the same key (still pending, or already
  // auto-applied) is RETURNED as-is instead of filing a second row. Best-effort:
  // a lookup hiccup must never block a real capture (it falls through to file).
  //
  // SCOPE (honest limit): this catches SEQUENTIAL retries — the actual failure
  // mode (an agent re-emitting after a masked "no approval") is sequential, so
  // it's covered. It does NOT catch two TRULY-CONCURRENT submits racing between
  // this lookup and the insert; closing that needs a partial unique index on
  // (created_by, data->>'idempotencyKey'), a later hardening. Advisory v1.
  const idempotencyKey =
    input.rawSource?.idempotencyKey ??
    computeCaptureGraphIdempotencyKey({
      workspaceId,
      projectId: resolvedProjectId,
      entities: graphEntities,
      relations,
      bindings,
      ...(planInput ? { plan: planInput } : {}),
    });
  try {
    const prior = await findPriorCaptureGraphProposal(db, {
      userId,
      idempotencyKey,
    });
    if (prior) {
      const priorData = prior.data as {
        operations?: CompositeProposalOperation[];
      };
      const priorOps = Array.isArray(priorData?.operations)
        ? priorData.operations
        : [];
      const priorEntityCount = priorOps.filter(
        (o) => o.op === "create_entity"
      ).length;
      const priorRelationCount = priorOps.filter(
        (o) => o.op === "create_relation"
      ).length;
      const priorApplied = prior.status === "auto_approved";
      const priorReviewUrl = priorApplied ? undefined : openLink(prior.id);
      // What the PRIOR row stored — not this call's session/project/workspace.
      // A re-send from another session returns the first send's proposal, and
      // that proposal stays where the first send filed it.
      const priorScope = storedScopeOfProposal(prior);
      return {
        proposalId: prior.id,
        entityCount: priorEntityCount,
        relationCount: priorRelationCount,
        bindingCount: bindings.length,
        reviewUrl: priorReviewUrl,
        summary,
        applied: priorApplied,
        ...(isPlanBatch(priorOps)
          ? { plan: { steps: planStepReceipts(priorOps) } }
          : {}),
        sessionId: priorScope.sessionId,
        scope: priorScope,
        // Reuses the flag the MCP `ok()` shaper already reads: a deduped
        // PENDING proposal surfaces as `status: "duplicate"` with a
        // stop-re-proposing hint.
        deduped: true,
        ...(projectCandidate ? { projectCandidate } : {}),
        ...(projectOutcome ? { project: projectOutcome } : {}),
        writeReceipt: {
          state: priorApplied ? "applied" : "pending",
          proposalId: prior.id,
          ...(priorReviewUrl ? { reviewUrl: priorReviewUrl } : {}),
          effectiveWorkspaceId: priorScope.workspaceId,
          ...(priorScope.projectId ? { projectId: priorScope.projectId } : {}),
          ...(projectOutcome ? { project: projectOutcome } : {}),
          source,
        },
      };
    }
  } catch (err) {
    logger.warn(
      { err, userId },
      "capture/graph: prior-proposal idempotency lookup failed (filing fresh)"
    );
  }

  // ADVISORY pending-duplicate candidates: incoming entities whose strong signal
  // collides with a create_entity op in the caller's OWN pending queue (below).
  const pendingDuplicateCandidates: Array<{
    ref: string;
    title: string;
    matches: PendingSignalMatch[];
  }> = [];

  // IDEMPOTENCY: dedup against existing entities via the ONE identity resolver.
  // Strong signals (email/phone/url) auto-resolve globally; weak name/handle
  // matches are scoped to this workspace's visible rows + pod-wide globals.
  const toResolve = graphEntities.filter((e) => !e.existingEntityId);
  if (toResolve.length > 0) {
    const weakScope = workspaceId
      ? or(eq(entities.workspaceId, workspaceId), isNull(entities.workspaceId))
      : isNull(entities.workspaceId);
    for (const e of toResolve) {
      try {
        const signals = extractIdentitySignals(e.properties);
        const res = await resolveIdentity(db, {
          userId,
          kindSlug: e.profileSlug,
          name: e.title ?? e.ref,
          signals,
          userScope: weakScope,
        });
        if (res.match && res.entity) {
          e.existingEntityId = res.entity.id; // link, don't create
        } else if (signals.length > 0) {
          // No COMMITTED match — consult the caller's OWN pending queue. A
          // pending capture materializes NOTHING yet, so resolveIdentity can't
          // see it; a strong-signal collision means a duplicate is already
          // in-flight. ADVISORY ONLY: we NEVER set `existingEntityId` from this
          // (the pending proposal can be rejected, which would then stale-
          // suppress this real write) — we flag it and still file the write.
          const pending = await findPendingSignalMatches(db, {
            userId,
            signals,
          });
          if (pending.length > 0) {
            pendingDuplicateCandidates.push({
              ref: e.ref,
              title: e.title ?? e.ref,
              matches: pending,
            });
          }
        }
      } catch (err) {
        // Dedup is best-effort — never block the proposal on a lookup failure.
        logger.warn({ err }, "capture/graph: entity dedup lookup failed");
      }
    }
  }

  // Ops + scope-aware homes: the ONE builder, shared with the dry run.
  const builtOperations = await buildCaptureGraphOperations(db, {
    entities: graphEntities,
    relations,
    projectId: resolvedProjectId,
    workspaceId,
    ...(planInput ? { plan: planInput } : {}),
  });

  // ── PREFLIGHT: never queue what can't materialize ────────────────────────
  // Required-property validation runs only at MATERIALIZE (EntityRepository.
  // create). Without this, a graph missing a required prop (a `file` with no
  // `storageKey`, say) filed a PENDING proposal that then FAILED at approve.
  // Validate every create_entity op against its EFFECTIVE schema HERE — the
  // SAME `validateProperties` the materializer runs — so an un-materializable
  // graph is rejected at submit, before EITHER terminal (auto-apply OR pending).
  // Atomic graph ⇒ all-or-nothing: any invalid op rejects the WHOLE graph.
  const { invalidEntities, unmodeledProperties, planProblems, operations } =
    await preflightCaptureGraphOperations(
      db,
      builtOperations,
      userId,
      workspaceId
    );
  if (invalidEntities.length > 0 || planProblems.length > 0) {
    // Rejected BEFORE any proposal is filed — pending-proposal-one-door untouched.
    throw new CaptureGraphValidationError(invalidEntities, planProblems);
  }
  const homes = computeImportHomes(operations);
  const isPlan = isPlanBatch(operations);
  // A project step below the agent evidence floor is shown to a human with
  // its marker — it can never be auto-applied past that human.
  const planNeedsReview = operations.some(
    (op) => op.op === "create_project" && op.evidence?.belowAgentFloor === true
  );

  // NOTE: `summary`, `source`, `bindingNote` are computed ABOVE (before the
  // re-submit idempotency lookup, which needs them); not re-declared here.

  // ── DUPLICATE ADVISORY, PERSISTED ────────────────────────────────────────
  // `pendingDuplicateCandidates` was computed above and spread ONLY into the
  // RETURN value, so the submitting caller saw it once and the proposal row
  // kept nothing: a reviewer opening this proposal a month later could not see
  // that the write had already been suspected of duplicating an in-flight one.
  //
  // Duplication IS this proposal type's blast radius — all 166 live composite
  // proposals contain only `create_entity` (780) and `create_relation` (678),
  // zero destructive and zero behaviour ops — so the advisory is the only real
  // risk signal a capture review has. Persisted the SAME way
  // `proposalProvenance` is: a spread-if-present block folded into both `data`
  // terminals (auto-applied and pending) so the two can't drift.
  //
  // ABSENT means "not computed"; it must NEVER be an empty array, because an
  // empty array reads as "we checked and found none" — a claim this field
  // cannot make (the scan is best-effort and swallows lookup failures above).
  //
  // PROJECTED, not dumped: enough for a reviewer to judge — which proposed item
  // (ref/title), which in-flight proposal (id/title/kind), and WHY (the matched
  // signals) — never whole rows. Bounded so a pathological fan-out cannot bloat
  // the proposal payload, and honest about clipping via `matchCount`.
  const duplicateAdvisory =
    pendingDuplicateCandidates.length > 0
      ? {
          pendingDuplicateCandidates: pendingDuplicateCandidates
            .slice(0, DUPLICATE_ADVISORY_MAX_CANDIDATES)
            .map((c) => ({
              ref: c.ref,
              title: c.title,
              /** Total matches found, so a clipped `matches` still reads honestly. */
              matchCount: c.matches.length,
              matches: c.matches
                .slice(0, DUPLICATE_ADVISORY_MAX_MATCHES_PER_CANDIDATE)
                .map((m) => ({
                  proposalId: m.proposalId,
                  ...(m.entityTitle ? { entityTitle: m.entityTitle } : {}),
                  ...(m.profileSlug ? { profileSlug: m.profileSlug } : {}),
                  // WHY it matched. Values are already present in this same
                  // proposal's own `operations` payload (they are the incoming
                  // entity's own properties), so this exposes nothing new.
                  matchedSignals: m.matchedSignals,
                })),
            })),
          ...(pendingDuplicateCandidates.length >
          DUPLICATE_ADVISORY_MAX_CANDIDATES
            ? { candidateCount: pendingDuplicateCandidates.length }
            : {}),
        }
      : {};

  // Reusable proposal-provenance block (rawSource is bounded, proposal-data-only).
  const proposalProvenance = input.rawSource
    ? {
        proposalProvenance: {
          kind: "raw_capture_input" as const,
          storage: "proposal_data_only" as const,
          rawSource: {
            ...input.rawSource,
            // ENFORCE the bound this field's doc promises. Previously the doc
            // said "bounded" and nothing enforced it, so the cap lived in each
            // caller — three call sites, three different numbers, one of which
            // (message.interpret) had none at all.
            ...(input.rawSource.rawText !== undefined
              ? { rawText: boundRawSourceText(input.rawSource.rawText) }
              : {}),
          },
        },
      }
    : {};

  // ── AGENT-MODE AUTO-APPLY (piece A) ──────────────────────────────────────
  // A composite graph is ATOMIC → all-or-nothing: it may auto-apply ONLY when
  // EVERY op is auto-approvable under the ONE agent policy evaluator
  // (`decideAgentPolicy`, via `resolveAgentGovernanceDecision`). This aligns
  // capture with how `create_entity` already behaves (whitelisted → executes).
  //
  // Gated on `agentUserId` (so this only fires on agent doors; webhooks/cron/
  // human confirm door pass none → the pending path below, unchanged). Channel
  // bindings force the pending path: they are applied by the approve flow AFTER
  // materialization, so an auto-apply that skipped them would silently drop the
  // binds.
  if (input.agentUserId && bindings.length === 0 && !planNeedsReview) {
    const keys = captureGraphEventKeys(operations);
    let allAutoApprove = keys.length > 0;
    for (const {
      subjectType,
      action,
      subjectProfileSlug,
      subjectUoValidated,
    } of keys) {
      const gov = await resolveAgentGovernanceDecision({
        db,
        agentUserId: input.agentUserId,
        workspaceId,
        subjectType,
        action,
        // GOVERNANCE BY KIND: forward the op's profile slug + uo_validated so an
        // unvalidated `user_observation` (an INFERENCE) forces `propose` here —
        // and because the graph is atomic, the WHOLE graph then proposes. Absent
        // for facet/relation ops (the rule no-ops). This mirrors the per-write
        // signals `checkPermissionOrPropose`/`create_entity` already forward.
        ...(subjectProfileSlug ? { subjectProfileSlug } : {}),
        ...(subjectUoValidated !== undefined ? { subjectUoValidated } : {}),
        // MCP is an agent WRITE door — prefer the agent's own metadata
        // autoApproveFor, falling back to the workspace override (chat-door rule).
        preferAgentMetadataAutoApproveFor: true,
      });
      // Any non-execute (propose / deny / not-agent) → the WHOLE graph proposes.
      if (gov.decision !== "execute") {
        allAutoApprove = false;
        break;
      }
    }

    if (allAutoApprove) {
      // Materialize NOW as a DIRECT OPERATOR write, through the EXACT composite
      // caller shape `proposals.approve` builds: `{ db, authenticated, userId,
      // workspaceId, workspaceRole, sessionId }` with NO `source` field — so
      // `entities.create`'s gate falls through to a granted first-party write
      // (never the legacy AI-source whitelist, whose per-workspace autoApproveFor
      // could disagree with the agent-metadata decision above and silently turn a
      // create back into a proposal). The governance decision already happened
      // (policy said execute); this is the authorized EXECUTION.
      const membershipRole = workspaceId
        ? (await getWorkspaceMembership(db, workspaceId, userId))?.role
        : "owner";
      // No membership for a workspace-pinned graph ⇒ can't materialize as this
      // user ⇒ fall through to the pending path (reviewable) instead of failing.
      if (!membershipRole) {
        logger.warn(
          { userId, workspaceId },
          "capture auto-apply: no workspace membership — filing pending instead"
        );
      } else {
        // Pre-allocate the auto_approved receipt id BEFORE materializing, so the
        // `entity.create.completed` events the create door writes below can name
        // the proposal that authorized them (`events.proposal_id`), AND so the
        // created rows can carry `entities.source_proposal_id = this id`. Until
        // this linkage existed the receipt was created with a fresh id
        // afterwards and nothing joined it to the entities: every
        // capture-created entity read as an authorizer-less write, and the object
        // graph's `via: "governed"` fold returned no proposal neighbour for it.
        //
        // ⚠️ ORDERING IS LOAD-BEARING — the id is a FOREIGN KEY, not a label.
        // `entities.source_proposal_id → proposals(id)` has existed since
        // migration 0107, and `entities.create` stamps it from
        // `ctx.governanceProposalId`. Inserting the receipt AFTER materialization
        // (as this did between 233112b3 and this fix) made the FIRST entity
        // insert die with `entities_source_proposal_id_fkey` and roll the whole
        // capture back — every structured MCP `synap_capture` write failed, and
        // the MCP layer reported it as a "storage layer" fault.
        //
        // So: insert the receipt FIRST (with an empty materialized set), then
        // materialize, then UPDATE the SAME row with the real ids. NO outer
        // transaction wraps any of this — deliberately. `EntityRepository.create`
        // opens its OWN `this.db.transaction` on the shared handle, so a receipt
        // insert held open in an uncommitted outer tx would be invisible to the
        // FK check inside it and fail exactly the same way. The receipt row must
        // be COMMITTED before the first entity insert runs, which plain
        // autocommit gives us.
        const captureProposalId = randomUUID();

        // PROJECT LENS parity with the PENDING path (A3). The pending row runs
        // `insertPendingProposal`'s ladder (explicit → session → channel →
        // declared focus); this receipt used to stamp only the caller's pin, so
        // the SAME graph landed in a project when proposed and in none when
        // auto-applied. Same shared derivation, same inputs — including
        // `sessionSource`, so a DERIVED session places neither terminal (A1).
        const receiptProjectId = await deriveProposalProjectId({
          projectId: resolvedProjectId,
          sessionId: input.sessionId ?? null,
          sessionSource: input.sessionSource,
          threadId: input.channelId ?? null,
          // Rung 3.5, read exactly as `createPendingProposal` reads it.
          focusProjectId:
            !resolvedProjectId && input.agentUserId
              ? await getAgentFocusProjectId(input.agentUserId)
              : null,
        });

        // Receipt first. If this insert fails we must NOT stamp the id onto the
        // writes — an id naming no row is the FK failure above. The graph then
        // materializes unstamped (the capture still lands, just without the
        // governance join), which is strictly better than losing the capture.
        let captureReceipt:
          | {
              id?: string;
              data?: Record<string, unknown>;
              workspaceId?: string | null;
              projectId?: string | null;
              sessionId?: string | null;
            }
          | undefined;
        try {
          const { proposal } = await createAutoApprovedProposal({
            id: captureProposalId,
            userId,
            reviewedBy: userId,
            workspaceId,
            targetType: "entity",
            targetId: randomUUID(),
            proposalType: "capture.graph",
            action: "graph",
            // `source` must be a valid EventSource — the capture-origin
            // discriminator lives in `data.source` + the proposalType.
            source: "api",
            summary,
            ...(input.channelId ? { threadId: input.channelId } : {}),
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            // The LADDER's verdict (above), not only the caller's pin — the
            // same project the pending row would have stored.
            ...(receiptProjectId ? { projectId: receiptProjectId } : {}),
            data: {
              operations,
              source,
              graphSource: "capture",
              homes,
              // Filled in by the UPDATE below, once materialization has told us
              // what actually landed. Empty here is the HONEST value: nothing
              // has been created yet. `revert` treats an empty set as "no
              // materialized record" and refuses rather than deleting the wrong
              // rows, so the sub-second window before the update is safe.
              materialized: { entityIds: [] as string[] },
              // Stored so a re-submit of the same graph resolves to THIS record
              // via findPriorCaptureGraphProposal (queries data->>'idempotencyKey').
              idempotencyKey,
              ...proposalProvenance,
              ...duplicateAdvisory,
              ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            },
          });
          captureReceipt = proposal as NonNullable<typeof captureReceipt>;
        } catch (err) {
          logger.warn(
            { err, userId },
            "capture auto-apply: auto_approved receipt insert failed (materializing unstamped)"
          );
        }

        const compositeCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId,
          workspaceRole: membershipRole,
          sessionId: input.sessionId ?? null,
          // Internal composite-caller channel read by `entities.create` — never
          // set from HTTP. See the note at its recordDomainMutation call.
          // Only set when the receipt row EXISTS (FK, see above).
          ...(captureReceipt?.id
            ? { governanceProposalId: captureProposalId }
            : {}),
        };
        const { entitiesRouter } = await import("../../routers/entities.js");
        const { relationsRouter } = await import("../../routers/relations.js");
        const entityCaller = entitiesRouter.createCaller(
          compositeCtx as unknown as Parameters<
            typeof entitiesRouter.createCaller
          >[0]
        );
        const relationCaller = relationsRouter.createCaller(
          compositeCtx as unknown as Parameters<
            typeof relationsRouter.createCaller
          >[0]
        );

        const materialized = await runMaterializationUnderReceipt(
          captureReceipt,
          () =>
            materializeCompositeGraph(
              operations,
              entityCaller,
              relationCaller,
              (err, type) =>
                logger.warn(
                  { err, type },
                  "capture auto-apply: relation create failed (entities kept)"
                ),
              {
                source,
                // Homes are per-op via stampScopeAwareHomesOnOps (targetWorkspaceId
                // on workspace-scoped kinds only). Do NOT blanket workspaceScoped —
                // that re-pinned pod identity into the graph home (folder prison).
                // materializeCompositeGraph forces pin only when op.targetWorkspaceId
                // is set; pod kinds stay null via entities.create entityScope.
                // The composite ctx's `attachFacet` door — same governance context,
                // so a policy-approved graph attaches facets directly.
                facetCaller: entityCaller,
                // Connected-plan callers — the SAME doors approval wires, with
                // the capturing human as the sessions' owner (auto-apply has no
                // separate approver).
                planCallers: buildPlanCallers({
                  database: db,
                  userId,
                  sessionOwnerUserId: userId,
                  workspaceId,
                  workspaceRole: membershipRole,
                  entityCaller,
                  proposal: {
                    id: captureReceipt?.id ?? null,
                    sessionId: input.sessionId ?? null,
                  },
                }),
                // Rule Loop callers — the SAME three canonical doors proposal
                // approval wires. Without them a config op in an auto-applied
                // graph would be silently dropped here while the identical graph
                // materialized it on the approval path.
                ...buildRuleLoopCallers({
                  database: db,
                  userId,
                  workspaceId: workspaceId ?? null,
                  auditSource: "rule_loop_capture_auto_apply",
                }),
                // RE-SUBMIT IDEMPOTENCY (piece 1a): key every created entity in the
                // external-link store by `${userId}:${idempotencyKey}:${op.ref}`. If
                // the SAME graph is auto-applied twice (a retry that races the
                // auto_approved record write, so the early proposal lookup missed
                // it), the second materialize LINKS the already-created entities
                // instead of duplicating them. userId-prefixed so a client-supplied
                // key can't collide with another tenant on the global links index —
                // exactly the pattern the tRPC capture door uses.
                idempotency: makeExternalLinkIdempotency(db, {
                  namespace: `${userId}:${idempotencyKey}`,
                  provider: "capture",
                  userId,
                }),
              }
            )
        );

        // Complete the receipt inserted BEFORE materialization: fill in what
        // actually landed, so the row is traceable, shows in the Proposals app,
        // and can be REVERTED (revert reads `data.materialized.entityIds`;
        // proposalType `capture.graph` is the recognized auto-approved-capture
        // shape). An UPDATE, not a second insert — the row already exists and
        // the created entities' `source_proposal_id` points at it. Merged over
        // the row's OWN stored `data` so the fields the recorder folded in
        // (correlationId, requestedEventId, summary) survive. Best-effort: a
        // recording hiccup must never fail the already-committed capture.
        let recordId: string | undefined = captureReceipt?.id;
        // Stored scope: the receipt row as the insert returned it. When that
        // insert FAILED there is no row — the entities were materialized under
        // exactly these values, so they are what was stored.
        const appliedScope: StoredCaptureScope = captureReceipt?.id
          ? storedScopeOfProposal(captureReceipt)
          : {
              workspaceId,
              projectId: receiptProjectId,
              sessionId: input.sessionId ?? null,
            };
        if (captureReceipt?.id) {
          try {
            // The COMPLETE record (relations, facets, config rows, merge
            // overwrites — not only entity ids), merged into the row's own data
            // by the one writer every materializer uses.
            await stampMaterialized({
              proposalId: captureReceipt.id,
              record: buildMaterializedRecord(materialized),
              baseData: captureReceipt.data,
            });
          } catch (err) {
            logger.warn(
              { err, userId, proposalId: captureReceipt.id },
              "capture auto-apply: receipt materialized-ids update failed (capture preserved)"
            );
          }
        }

        return {
          proposalId: recordId,
          entityCount: graphEntities.length,
          // The ACTUALLY CREATED relation count, not the submitted one — this
          // graph was just materialized above, so `materialized.relations` is
          // the honest number. `relations.length` (submitted) diverges the
          // moment any relation op fails to resolve/create.
          relationCount: materialized.relations.length,
          bindingCount: bindings.length,
          reviewUrl: undefined,
          summary,
          applied: true,
          ...(isPlan
            ? {
                plan: {
                  steps: planStepReceipts(
                    operations,
                    new Map<number, string>([
                      ...materialized.entities.map(
                        (e) => [e.opIndex, e.entityId] as [number, string]
                      ),
                      ...materialized.projects.map(
                        (p) => [p.opIndex, p.projectId] as [number, string]
                      ),
                      ...materialized.sessions.map(
                        (x) => [x.opIndex, x.sessionId] as [number, string]
                      ),
                      ...materialized.documents.map(
                        (d) => [d.opIndex, d.documentId] as [number, string]
                      ),
                    ])
                  ),
                },
              }
            : {}),
          sessionId: appliedScope.sessionId,
          scope: appliedScope,
          ...(unmodeledProperties.length > 0 ? { unmodeledProperties } : {}),
          ...(pendingDuplicateCandidates.length > 0
            ? { pendingDuplicateCandidates }
            : {}),
          ...(projectCandidate ? { projectCandidate } : {}),
          ...(projectOutcome ? { project: projectOutcome } : {}),
          // Relation ops submitted but never created (bad ref / DB failure) —
          // named, not just a shortfall between relationCount and the
          // requested count. Empty on the happy path.
          ...(materialized.relationsFailed.length
            ? { relationsFailed: materialized.relationsFailed }
            : {}),
          writeReceipt: {
            // The entities landed; if any submitted edge did NOT, this graph is
            // `partial`, not `applied`. Derived from the SAME array the response
            // carries (`materialized.relationsFailed`), so the state and the
            // detail can never disagree — the state is not a second opinion.
            state: materializedReceiptState(
              materialized.relationsFailed.length
            ),
            ...(recordId ? { proposalId: recordId } : {}),
            effectiveWorkspaceId: appliedScope.workspaceId,
            ...(appliedScope.projectId
              ? { projectId: appliedScope.projectId }
              : {}),
            ...(projectOutcome ? { project: projectOutcome } : {}),
            source,
            created: materialized.created,
            linked: materialized.entities.filter((e) => e.linked).length,
            entityIds: materialized.entities.map((e) => e.entityId),
          },
        };
      }
    }
  }

  // ── PENDING PATH (confirm mode + agent-propose + machine callers) ─────────
  const { proposal: created } = await createEventBackedProposal({
    userId,
    workspaceId,
    targetType: "entity",
    targetId: randomUUID(),
    proposalType: "import.graph",
    action: "create",
    source,
    summary,
    // D3: input.agentUserId is the genuine agent-key signal (see the field's
    // doc comment above) — already used to derive agent-mode auto-apply, but
    // never threaded into THIS proposal. Without it, an agent-driven capture
    // that falls through to the pending path (a non-auto-approving op, or
    // channel bindings present) filed an unattributed proposal that bypassed
    // dedup. A webhook/cron/human-confirm caller still has no agentUserId, so
    // it stays correctly unattributed.
    ...(input.agentUserId ? { agentUserId: input.agentUserId } : {}),
    ...(input.sourceMessageId
      ? { sourceMessageId: input.sourceMessageId }
      : {}),
    ...(input.channelId ? { threadId: input.channelId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    // A1: the pending insert runs the SAME ladder the receipt above does.
    ...(input.sessionSource ? { sessionSource: input.sessionSource } : {}),
    ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    // `bindings` rides alongside operations; the approve flow applies them after
    // materialization (resolving entityRef → real id).
    data: {
      operations,
      // This is the actual origin stamped at materialization; graph is a
      // transport shape, not an origin the entity router understands.
      source,
      graphSource: "capture",
      bindings,
      // Same homes summary import proposals carry — multi-home review UI reuses.
      homes,
      // Stored so a re-submit of the same graph resolves to THIS proposal via
      // findPriorCaptureGraphProposal (queries data->>'idempotencyKey') instead
      // of filing a second row — the core of the anti-duplicate fix.
      idempotencyKey,
      ...proposalProvenance,
      ...duplicateAdvisory,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    },
  });

  const proposalId = (created as { id?: string })?.id;
  const reviewUrl = proposalId ? openLink(proposalId) : undefined;
  // Stored scope, off the row the insert returned: `insertPendingProposal`
  // runs the project ladder (session → channel → declared focus), and an agent
  // write with no session is packaged into a receipt session it MINTS — neither
  // is visible in `input`.
  const pendingScope = storedScopeOfProposal(
    (created ?? {}) as Parameters<typeof storedScopeOfProposal>[0]
  );

  return {
    proposalId,
    entityCount: graphEntities.length,
    relationCount: relations.length,
    bindingCount: bindings.length,
    reviewUrl,
    summary,
    applied: false,
    ...(isPlan ? { plan: { steps: planStepReceipts(operations) } } : {}),
    sessionId: pendingScope.sessionId,
    scope: pendingScope,
    ...(unmodeledProperties.length > 0 ? { unmodeledProperties } : {}),
    ...(pendingDuplicateCandidates.length > 0
      ? { pendingDuplicateCandidates }
      : {}),
    ...(projectCandidate ? { projectCandidate } : {}),
    ...(projectOutcome ? { project: projectOutcome } : {}),
    writeReceipt: {
      state: "pending",
      ...(proposalId ? { proposalId } : {}),
      ...(reviewUrl ? { reviewUrl } : {}),
      effectiveWorkspaceId: pendingScope.workspaceId,
      ...(pendingScope.projectId ? { projectId: pendingScope.projectId } : {}),
      ...(projectOutcome ? { project: projectOutcome } : {}),
      source,
    },
  };
}
