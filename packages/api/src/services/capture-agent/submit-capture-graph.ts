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

import {
  db,
  resolveIdentity,
  extractIdentitySignals,
  eq,
  and,
  or,
  isNull,
  isNotNull,
  entities,
  projects,
  getWorkspaceMembership,
  ProfileResolutionService,
  PropertyValidationService,
  resolveGraphWorkspaceFromSlugs,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { createLogger } from "@synap-core/core";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
import {
  createEventBackedProposal,
  createAutoApprovedProposal,
} from "../../utils/event-backed-proposal.js";
import { materializeCompositeGraph } from "../../utils/materialize-composite.js";
import { makeExternalLinkIdempotency } from "../../utils/entity-link-idempotency.js";
import {
  computeCaptureGraphIdempotencyKey,
  findPriorCaptureGraphProposal,
  findPendingSignalMatches,
  type PendingSignalMatch,
} from "../../utils/pending-capture-dedup.js";
import { openLink } from "../../utils/deep-links.js";
import { captureGraphEventKeys } from "./capture-graph-policy.js";
import { resolveCaptureProjectRef } from "./resolve-capture-project.js";
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
  constructor(invalidEntities: CaptureGraphInvalidEntity[]) {
    const n = invalidEntities.length;
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
      `Capture rejected — ${n} entit${n === 1 ? "y" : "ies"} can't be created as described, so nothing was queued:\n${lines.join("\n")}\nFix or drop the flagged entit${n === 1 ? "y" : "ies"} and resubmit.`
    );
    this.name = "CaptureGraphValidationError";
    this.invalidEntities = invalidEntities;
  }
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
  source?:
    | "intelligence"
    | "agent"
    | "openwebui-pipeline"
    | "extension"
    | "cli"
    | "n8n"
    | "raycast";
  sourceMessageId?: string;
  sessionId?: string;
  /**
   * Bounded original input retained only in proposal data for review/retry.
   * This is not a materialized source entity/document or shared provenance
   * artifact after approval.
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
  writeReceipt: {
    state: "pending" | "applied";
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
          or(
            and(isNull(projects.workspaceId), eq(projects.userId, userId)),
            and(
              isNotNull(projects.workspaceId),
              userVisibleWhere(projects.workspaceId, userId)
            )
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
  const summary =
    input.summary ??
    `Proposed graph: ${graphEntities.length} entit${graphEntities.length === 1 ? "y" : "ies"}, ${relations.length} link${relations.length === 1 ? "" : "s"}${bindingNote}`;
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
      return {
        proposalId: prior.id,
        entityCount: priorEntityCount,
        relationCount: priorRelationCount,
        bindingCount: bindings.length,
        reviewUrl: priorReviewUrl,
        summary,
        applied: priorApplied,
        ...(projectCandidate ? { projectCandidate } : {}),
        ...(projectOutcome ? { project: projectOutcome } : {}),
        writeReceipt: {
          state: priorApplied ? "applied" : "pending",
          proposalId: prior.id,
          ...(priorReviewUrl ? { reviewUrl: priorReviewUrl } : {}),
          effectiveWorkspaceId: workspaceId,
          ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
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

  const operations: CompositeProposalOperation[] = [
    ...graphEntities.map((e) => ({
      op: "create_entity" as const,
      ref: e.ref,
      profileSlug: e.profileSlug,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
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
  ];

  // Scope-aware homes (shared with import): stamp process kinds into the graph
  // home; leave pod-scope identity unpinned. Replaces blanket workspaceScoped
  // on materialize — pin ≠ exclusive for person/company/knowledge.
  if (workspaceId) {
    const homeScope = new ProfileResolutionService(db);
    await stampScopeAwareHomesOnOps(operations, workspaceId, (slug) =>
      homeScope.getEntityScope(slug, workspaceId)
    );
  }
  const homes = computeImportHomes(operations);

  // ── PREFLIGHT: never queue what can't materialize ────────────────────────
  // Required-property validation runs only at MATERIALIZE (EntityRepository.
  // create). Without this, a graph missing a required prop (a `file` with no
  // `storageKey`, say) filed a PENDING proposal that then FAILED at approve.
  // Validate every create_entity op against its EFFECTIVE schema HERE — the
  // SAME `validateProperties` the materializer runs — so an un-materializable
  // graph is rejected at submit, before EITHER terminal (auto-apply OR pending).
  // Atomic graph ⇒ all-or-nothing: any invalid op rejects the WHOLE graph.
  const profileResolution = new ProfileResolutionService(db);
  const propertyValidation = new PropertyValidationService(profileResolution);
  const invalidEntities: CaptureGraphInvalidEntity[] = [];
  for (const op of operations) {
    if (op.op !== "create_entity") continue;
    // Linking an existing entity materializes nothing new — no props to check.
    if (op.existingEntityId) continue;
    const profile = await profileResolution.resolveProfile(
      op.profileSlug,
      userId,
      workspaceId
    );
    // Unknown profile ⇒ don't NEWLY reject here (a cold profile lens can
    // fail-open, and unknown-slug graphs are a separate guard). Required-prop
    // preflight is scoped to KNOWN profiles — exactly the materializer's check.
    if (!profile) continue;
    const propsToCheck: Record<string, unknown> = { ...(op.properties ?? {}) };
    // `content` is folded in the way the materializer does (a long body becomes
    // a linked document, a short one inlines to properties.content) so a profile
    // that required `content` isn't falsely flagged when a body was provided.
    if (op.content) propsToCheck.content = op.content;
    const { valid, errors } =
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
  }
  if (invalidEntities.length > 0) {
    // Rejected BEFORE any proposal is filed — pending-proposal-one-door untouched.
    throw new CaptureGraphValidationError(invalidEntities);
  }

  // NOTE: `summary`, `source`, `bindingNote` are computed ABOVE (before the
  // re-submit idempotency lookup, which needs them); not re-declared here.

  // Reusable proposal-provenance block (rawSource is bounded, proposal-data-only).
  const proposalProvenance = input.rawSource
    ? {
        proposalProvenance: {
          kind: "raw_capture_input" as const,
          storage: "proposal_data_only" as const,
          rawSource: input.rawSource,
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
  if (input.agentUserId && bindings.length === 0) {
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
        const compositeCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId,
          workspaceRole: membershipRole,
          sessionId: input.sessionId ?? null,
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

        const materialized = await materializeCompositeGraph(
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
        );
        const materializedEntityIds = materialized.entities
          .filter((e) => !e.linked)
          .map((e) => e.entityId);

        // Record the already-done write as a durable `auto_approved` proposal so
        // it is traceable, shows in the Proposals app, and can be REVERTED
        // (revert reads `data.materialized.entityIds`; proposalType
        // `capture.graph` is the recognized auto-approved-capture shape). NOT
        // `notifyProposalCreated` — an applied write is not a pending review
        // item. Best-effort: a recording hiccup must never fail the
        // already-committed capture.
        let recordId: string | undefined;
        try {
          const { proposal } = await createAutoApprovedProposal({
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
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            data: {
              operations,
              source,
              graphSource: "capture",
              homes,
              materialized: { entityIds: materializedEntityIds },
              // Stored so a re-submit of the same graph resolves to THIS record
              // via findPriorCaptureGraphProposal (queries data->>'idempotencyKey').
              idempotencyKey,
              ...proposalProvenance,
              ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
            },
          });
          recordId = (proposal as { id?: string })?.id;
        } catch (err) {
          logger.warn(
            { err, userId },
            "capture auto-apply: auto_approved record failed (capture preserved)"
          );
        }

        return {
          proposalId: recordId,
          entityCount: graphEntities.length,
          relationCount: relations.length,
          bindingCount: bindings.length,
          reviewUrl: undefined,
          summary,
          applied: true,
          ...(pendingDuplicateCandidates.length > 0
            ? { pendingDuplicateCandidates }
            : {}),
          ...(projectCandidate ? { projectCandidate } : {}),
          ...(projectOutcome ? { project: projectOutcome } : {}),
          writeReceipt: {
            state: "applied",
            ...(recordId ? { proposalId: recordId } : {}),
            effectiveWorkspaceId: workspaceId,
            ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
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
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
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
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
    },
  });

  const proposalId = (created as { id?: string })?.id;
  const reviewUrl = proposalId ? openLink(proposalId) : undefined;

  return {
    proposalId,
    entityCount: graphEntities.length,
    relationCount: relations.length,
    bindingCount: bindings.length,
    reviewUrl,
    summary,
    applied: false,
    ...(pendingDuplicateCandidates.length > 0
      ? { pendingDuplicateCandidates }
      : {}),
    ...(projectCandidate ? { projectCandidate } : {}),
    ...(projectOutcome ? { project: projectOutcome } : {}),
    writeReceipt: {
      state: "pending",
      ...(proposalId ? { proposalId } : {}),
      ...(reviewUrl ? { reviewUrl } : {}),
      effectiveWorkspaceId: workspaceId,
      ...(resolvedProjectId ? { projectId: resolvedProjectId } : {}),
      ...(projectOutcome ? { project: projectOutcome } : {}),
      source,
    },
  };
}
