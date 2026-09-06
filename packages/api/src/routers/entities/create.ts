/**
 * Entities Router — create (Wave 3 router-decomposition).
 *
 * `create` (identity-resolve/dedup + placement + facet-attach) and
 * `batchCreate` (bulk provisioning). `create` self-references the exported
 * `entitiesRouter` (via `createCaller`) for its internal facet-attach and
 * dedup-enrich round-trips — imported from the barrel, used only inside
 * async handler bodies (never at module-eval time), so the ESM circular
 * import with `entities.ts` resolves fine.
 */

import { z } from "zod";
import { podProcedure } from "../../trpc.js";
import {
  eq,
  desc,
  and,
  or,
  isNull,
  inArray,
  getDb,
  ProfileResolutionService,
  eventRepository,
  EntityRepository,
  EntityBodyService,
  FacetRepository,
  drizzleSql,
  type LinkEndpointType,
  type LinkType,
  linkEntityToProject,
  stampProvenance,
  extractIdentitySignals,
  registerIdentitySignals,
  resolveIdentity,
  resolveWorkspacePlacement,
  acceptDeterministicGraphWorkspace,
  resolveProjectPlacement,
  isDomainHomeWorkspace,
  normalizeEntityScope,
  DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
  shouldRejectJunkTitle,
  buildJunkTitleMessage,
  classifyWeakEntityDedup,
  buildWeakEntityDedupMessage,
  buildWeakDedupCause,
  ENTITY_JUNK_TITLE_CODE,
} from "@synap/database";
import { entities, workspaces, links } from "@synap/database/schema";
import { shouldMaterializeAsDocument } from "@synap-core/types/documents";
import { TRPCError } from "@trpc/server";
import {
  checkPermissionOrPropose,
  isJoinGate,
  proposedMessageFor,
} from "../../utils/permission-check.js";
import { resolveViewTrust } from "../../services/view-trust-service.js";
import { getAgentFocusProjectId } from "../../services/agent-identity-service.js";
import { auditLog } from "../../utils/audit-log.js";
import { recordDomainMutation } from "../../utils/domain-mutation.js";
import { emitSideEffects, getBoss } from "@synap/events";
import { randomUUID } from "crypto";
import { syncPropertyToRelations } from "../../utils/property-relation-sync.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { idempotencyWindowSeconds } from "../../utils/write-door-idempotency.js";
import { createLogger } from "@synap-core/core";
import { entityWriteVisibleWhere, toApiEntity } from "./helpers.js";
import { entitiesRouter } from "../entities.js";
import { entityBodyDocumentIdFrom } from "../../utils/store-entity-source-blob.js";

const logger = createLogger({ module: "entities-router" });

export const createProcs = {
  create: podProcedure
    .input(
      z.object({
        profileSlug: z.string().optional(),
        profileId: z.string().uuid().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
        documentId: z.string().uuid().optional(),
        content: z.string().optional(),
        /** When true, entity has no workspace — visible everywhere */
        global: z.boolean().optional().default(false),
        /** Override the target workspace for this entity (defaults to current workspace). */
        targetWorkspaceId: z.string().uuid().optional(),
        /**
         * Explicit workspace-scope request: pin this entity to the active
         * workspace, OVERRIDING a profile's pod-default `entityScope`. Set by
         * imports (and any caller that must isolate data to one workspace).
         * Normal interactive creation leaves this false so pod-default profiles
         * keep their global person/company graph un-fragmented.
         */
        workspaceScoped: z.boolean().optional().default(false),
        /**
         * Source of action for AI governance + downstream audit/event tagging.
         * Hub Protocol callers may pass connector-specific values (e.g.
         * "openwebui-pipeline", "extension") so the proposal layer
         * carries accurate provenance. Permission gating is unchanged: the
         * legacy AI gate only branches on "ai"/"intelligence"; everything else
         * falls through to the agentUserId / role-based path.
         */
        source: z
          .enum([
            "user",
            "ai",
            "intelligence",
            "system",
            "agent",
            "openwebui-pipeline",
            "extension",
            "cli",
            "n8n",
            "raycast",
          ])
          .optional(),
        /** AI reasoning for proposals */
        reasoning: z.string().optional(),
        /** Agent user ID when action is performed by an AI agent */
        agentUserId: z.string().uuid().optional(),
        /**
         * Host-stamped identity of a framed view originating this write.
         *
         * SECURITY: this is the view's IDENTITY, not a trust assertion. Trust is
         * re-resolved server-side from `views.userId` / `widget_definitions.trust_level`
         * via `resolveViewTrust()`. A view that cannot be positively proven trusted
         * is routed to a proposal. Never accept a `trusted` boolean from the client.
         * Set by the React host (BrowserViewFrameCell), NOT by the sandboxed iframe.
         */
        viewContext: z
          .object({
            viewId: z.string().uuid().optional(),
            typeKey: z.string().optional(),
          })
          .optional(),
        /**
         * Stable entity ID assigned at propose-time so AI agents can reference
         * this entity in cross-write proposal graphs before its proposal is
         * approved. When set, the approval handler reuses this ID instead of
         * generating a fresh one. Ignored on the non-proposed (direct write)
         * path since a UUID is already generated inline — this input param is
         * for the proposal approval round-trip only.
         */
        proposedEntityId: z.string().uuid().optional(),
        /**
         * Active project lens (or surface override). When set, the created entity
         * is filed into this project (`belongs_to_project`) — the project mirror
         * of `workspaceId`. On the proposal path it rides `proposals.project_id`;
         * on the granted inline path it is stamped directly below.
         */
        projectId: z.string().uuid().nullish(),
        /**
         * Kind + Facets: role-profiles to attach to this entity in the SAME
         * call (mirrors the hub `createEntity` contract), so a caller can create
         * an entity WITH its roles (a person who is a client + investor) in one
         * round-trip. Each is attached AFTER the entity materializes via the
         * governed `attachFacet` door (fast-fail kind validation, proposal-gated
         * for agents). Dropped when the create itself is proposal-gated (no id to
         * attach to yet) — surfaced explicitly in the response, never silently.
         */
        facets: z
          .array(
            z.object({
              profileSlug: z.string(),
              status: z.string().optional(),
              properties: z.record(z.string(), z.unknown()).optional(),
              /** Disambiguator when the same role attaches in multiple contexts. */
              contextEntityId: z.string().uuid().nullish(),
            })
          )
          .optional(),
        /**
         * Bypass the WEAK same-name create gate (Phase 1). When true, a
         * same-profile title match still creates a new entity instead of
         * rejecting with candidates. Strong-signal auto-merge is NOT bypassed
         * — email/phone/url still collapse onto the existing subject. Prefer
         * reusing an existing id / enriching / attaching a facet; only set this
         * when the subject is genuinely distinct (e.g. two people who share a
         * name). Logged as `identity_resolve_merge` outcome `force_create`.
         */
        forceCreate: z.boolean().optional().default(false),
        /**
         * Strong cross-source identity anchor for this subject, as `provider:id`
         * (e.g. `discord:123…`). Registered as an `external_id` identity signal
         * on the resolved entity so a later create with the SAME value dedups
         * onto it — the strong atom the property auto-extractor cannot derive for
         * an opaque connector id. Also fed into identity resolution below, so a
         * repeat create with the same anchor auto-resolves (link, don't create).
         */
        externalId: z.string().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Strong `external_id` identity anchor (opaque connector id, `provider:id`).
      // Not derived from any property, so `extractIdentitySignals` can't produce
      // it — build it once here and fold it into both the dedup lookup and the
      // post-create signal registration below (the ONE signal door).
      const externalIdSignal = input.externalId?.trim()
        ? [{ type: "external_id", value: input.externalId.trim() }]
        : [];
      const entityId = input.proposedEntityId ?? randomUUID();
      const correlationId = randomUUID();
      const governanceWorkspaceId =
        input.targetWorkspaceId ?? ctx.workspaceId ?? null;

      if (input.targetWorkspaceId) {
        const { validateWorkspaceAccess } =
          await import("../../utils/workspace-membership.js");
        const allowedWorkspaceIds = await validateWorkspaceAccess(ctx.userId, [
          input.targetWorkspaceId,
        ]);
        if (!allowedWorkspaceIds.includes(input.targetWorkspaceId)) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "Access denied to target workspace",
          });
        }
      }

      // Resolve framed-view trust SERVER-SIDE (never from the request body).
      // Absent viewContext → no issuer → legacy behavior (unchanged for all
      // existing non-view callers).
      const issuer = input.viewContext
        ? await resolveViewTrust(
            input.viewContext,
            ctx.userId,
            governanceWorkspaceId
          )
        : undefined;

      // Resolve profile — capture full profile object so defaultValues are available at step 3
      let profileSlug: string | undefined;
      let earlyResolvedProfile: any = null;
      if (input.profileSlug) {
        profileSlug = input.profileSlug;
      } else if (input.profileId) {
        const database = await getDb();
        const resolutionService = new ProfileResolutionService(database);
        const profile = await resolutionService.resolveProfile(
          input.profileId,
          ctx.userId,
          governanceWorkspaceId
        );
        if (!profile) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Profile not found: ${input.profileId}`,
          });
        }
        profileSlug = profile.slug;
        earlyResolvedProfile = profile; // carry forward — avoids second DB call below
      } else {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Either profileSlug or profileId must be provided",
        });
      }

      // File-is-uploaded-bytes guard (API entry). The `file` kind is ONLY for
      // real uploaded bytes reached via an upload-derived `documentId`. Reject
      // BEFORE EntityBodyService.setBody below synthesizes a documentId from
      // `content` — otherwise authored text would silently mint a ghost document
      // and slip through as a "file". A genuine upload arrives with a real
      // `documentId` and NO `content`. Backstopped in EntityRepository.create.
      if (
        profileSlug === "file" &&
        (input.content != null || input.documentId == null)
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "A `file` entity must be backed by an uploaded document (use the upload door — synap upload / POST /api/hub/entities/files). Authored text should be a content kind (note/article/…); its body becomes a document automatically.",
        });
      }

      // Kind + Facets: attach requested roles to a materialized entity through
      // the governed `attachFacet` door — the ONE facet write door (validation +
      // proposal gating inherited). Advisory: a single role failure is reported,
      // never rolls back the created entity.
      const attachRequestedFacets = async (
        targetEntityId: string
      ): Promise<
        Array<{
          slug: string;
          /**
           * @deprecated Carries the OPERATION OUTCOME (attached/proposed/dropped/
           * error), NOT the facet's domain status — a naming collision with the
           * REQUEST's `facets[].status` (domain). Read `outcome` instead; `status`
           * is kept only for back-compat and will be removed.
           */
          status: string;
          /** Operation outcome: attached | proposed | dropped | error. */
          outcome: string;
          facetId?: string;
          proposalId?: string;
          error?: string;
        }>
      > => {
        const out: Array<{
          slug: string;
          status: string;
          outcome: string;
          facetId?: string;
          proposalId?: string;
          error?: string;
        }> = [];
        if (!input.facets?.length) return out;
        const facetCaller = entitiesRouter.createCaller(
          ctx as unknown as Parameters<typeof entitiesRouter.createCaller>[0]
        );
        for (const f of input.facets) {
          try {
            const r = await facetCaller.attachFacet({
              entityId: targetEntityId,
              profileSlug: f.profileSlug,
              properties: f.properties,
              status: f.status,
              contextEntityId: f.contextEntityId ?? undefined,
              source: input.source,
              agentUserId: input.agentUserId,
              reasoning: input.reasoning,
            });
            out.push({
              slug: f.profileSlug,
              status: r.status,
              outcome: r.status,
              facetId: (r as { facetId?: string }).facetId,
              proposalId: (r as { proposalId?: string }).proposalId,
            });
          } catch (err) {
            out.push({
              slug: f.profileSlug,
              status: "error",
              outcome: "error",
              error: err instanceof Error ? err.message : "attachFacet failed",
            });
          }
        }
        return out;
      };

      // Junk-title gate (Phase 1) — person/company/contact never mint with a
      // placeholder name agents invent when a subject is not disclosed. Runs
      // before identity resolve so we don't waste a lookup on garbage.
      if (shouldRejectJunkTitle(profileSlug, input.title)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: buildJunkTitleMessage(profileSlug ?? "entity"),
          cause: {
            code: ENTITY_JUNK_TITLE_CODE,
            profileSlug,
            title: input.title ?? null,
          },
        });
      }

      // Resolve-then-merge (identity-first dedup — the single-entity door). A
      // STRONG identity signal (email/phone/url/handle) means this subject
      // already exists: enrich the matched entity + attach any requested roles
      // instead of creating a duplicate, and return it with `deduplicated: true`.
      // WEAK same-name (same profile) REJECTS create with candidates unless
      // `forceCreate: true` — never auto-merges (Phase 1). The enrich + facet
      // attach ride their own governed doors (update/attachFacet), so agent
      // writes stay proposal-gated. Resolver hiccup falls through to a normal
      // create (never blocks on a failed lookup).
      //
      // NOTE — capture-graph within-batch collapse still has its own weak
      // auto-link path (`_capture-graph-dedup.ts`); that asymmetry is intentional
      // for this PR (within-batch collapse ≠ persisted create gate).
      //
      // Runs on the `proposedEntityId` (proposal-approval replay) path TOO. It
      // used to be skipped there — "the approval must reuse its assigned id" —
      // which meant approving a proposed contact whose email already existed
      // CREATED A DUPLICATE, the one create door that silently skipped dedup.
      // The pre-minted id is a *preference*, not an invariant: it is honored
      // when nothing matches (below, `entityId`), and a strong match wins over
      // it. No consumer requires the returned id to equal the pre-minted one —
      // the composite materializer keys its `$opN` ref map on the id create
      // RETURNS (utils/materialize-composite.ts), and the single-op approve
      // executor reads `createdEntity.id` for every downstream write. Approving
      // a proposal that merges is reported with `deduplicated: true` so the
      // executor records it as LINKED, not created (see approve-executors.ts).
      const dedupSignals = [
        ...extractIdentitySignals(input.properties ?? {}),
        ...externalIdSignal,
      ];
      // Resolve when we have strong signals OR a title for the weak same-name
      // gate. Title-only creates used to skip resolve entirely (zero-friction);
      // Phase 1 runs the weak path for every profile so agents stop minting
      // "Alice" person #47.
      const needsIdentityResolve =
        dedupSignals.length > 0 || (!!profileSlug && !!input.title?.trim());
      if (needsIdentityResolve) {
        try {
          const resolveDb = await getDb();
          const identity = await resolveIdentity(resolveDb, {
            userId: ctx.userId,
            kindSlug: profileSlug,
            name: input.title ?? null,
            signals: dedupSignals,
            userScope: userVisibleWhere(entities.workspaceId, ctx.userId),
            limit: 5,
          });
          // SECURITY GATE — the strong identity index is deliberately GLOBAL
          // (frozen policy: one subject per email/phone pod-wide), so the
          // matched id may belong to an entity the CALLER cannot see
          // (another user's private workspace). Never dedupe onto something
          // the caller can't see: an invisible match falls through to a
          // normal create. Without this gate the response below would leak
          // the matched row's title/properties to an unauthorized caller
          // (the enrich/attach doors deny the writes, but the read leaked).
          // Invisible strong matches also must NOT be surfaced as weak
          // candidates below — candidates come only from the scoped weak path.
          const visibleMatch =
            identity.match === "strong" && identity.entity
              ? await resolveDb.query.entities.findFirst({
                  where: and(
                    eq(entities.id, identity.entity.id),
                    isNull(entities.deletedAt),
                    entityWriteVisibleWhere(ctx.userId)
                  ),
                })
              : undefined;
          if (identity.match === "strong" && identity.entity && !visibleMatch) {
            logger.info(
              {
                // Stable observability event (T3a) — the backend metrics
                // registry lives in @synap-core/core (no built dist, not a
                // tsconfig reference of @synap/api), so a new prom Counter there
                // would couple this router to a cross-package rebuild. This
                // structured log with a stable `event`+`outcome` is the honest
                // minimal surfacing of the resolve-then-merge decision.
                event: "identity_resolve_merge",
                outcome: "blocked_invisible",
                userId: ctx.userId,
                profileSlug,
              },
              "[entities.create] strong identity match not visible to caller — creating instead of merging"
            );
          }
          if (identity.match === "strong" && identity.entity && visibleMatch) {
            const matchedId = identity.entity.id;
            // Register the external_id anchor onto the matched subject so the
            // NEXT create with this provider id resolves here directly — not only
            // via whatever signal matched THIS time (e.g. a create that dedups on
            // email must still stamp the connector's discord id). Idempotent
            // (onConflictDoNothing); the caller-scoped visibleMatch gate above
            // ensures we only write onto an entity the caller can see.
            if (externalIdSignal.length > 0) {
              try {
                await registerIdentitySignals(
                  resolveDb,
                  matchedId,
                  externalIdSignal,
                  input.source ?? "entities.create"
                );
              } catch (sigErr) {
                logger.warn(
                  { sigErr, entityId: matchedId },
                  "[entities.create] external_id signal registration failed on dedup match (entity preserved)"
                );
              }
            }
            const enrichCaller = entitiesRouter.createCaller(
              ctx as unknown as Parameters<
                typeof entitiesRouter.createCaller
              >[0]
            );
            // update's source enum is narrower than create's — connector
            // sources (openwebui/cli/n8n/raycast) aren't in it.
            // Governance only branches on ai/intelligence anyway, so map the
            // non-AI connector sources to "user" (first-party write).
            const enrichSource =
              input.source === "ai" ||
              input.source === "intelligence" ||
              input.source === "agent" ||
              input.source === "system" ||
              input.source === "extension" ||
              input.source === "user"
                ? input.source
                : "user";
            const nonEmptyProperties = Object.fromEntries(
              Object.entries(input.properties ?? {}).filter(
                ([, v]) => v !== undefined && v !== null && v !== ""
              )
            );
            if (Object.keys(nonEmptyProperties).length > 0) {
              try {
                await enrichCaller.update({
                  id: matchedId,
                  properties: nonEmptyProperties,
                  source: enrichSource,
                  agentUserId: input.agentUserId,
                  reasoning: input.reasoning,
                });
              } catch (enrichErr) {
                logger.warn(
                  { enrichErr, entityId: matchedId },
                  "[entities.create] dedup enrich failed — returning matched entity unenriched"
                );
              }
            }

            // B3 FIX: a dedup used to SILENTLY DROP a long-form body carried by
            // this create. Recover it — materialize the body via the canonical
            // door (EntityBodyService) and link it onto the deduped entity — but
            // ONLY when the match has no existing body (no documentId, no inline
            // content). Appending onto an entity that ALREADY has a body needs a
            // version-onto-existing primitive the body service does not expose;
            // clobbering would lose the prior body, so that case still reports
            // the body as dropped rather than overwrite it.
            let dedupContentDropped = false;
            if (input.content && input.content.trim().length > 0) {
              // `documentId` alone is NOT "has a body": `attachSourceBlob`
              // also sets it for a source blob (a PDF, a WAV) attached as
              // provenance, so an entity with a file and no body read as
              // having one — and the long-form body this create carried was
              // dropped, which is the very regression the B3 fix removed.
              // `entityBodyDocumentIdFrom` subtracts the source-blob meaning.
              const matchHasBody =
                !!entityBodyDocumentIdFrom(
                  visibleMatch as {
                    documentId?: string | null;
                    properties?: unknown;
                  }
                ) ||
                !!(
                  (visibleMatch as { properties?: Record<string, unknown> })
                    .properties as { content?: unknown } | undefined
                )?.content;
              if (matchHasBody) {
                dedupContentDropped = true;
              } else {
                try {
                  const matchWorkspaceId =
                    (visibleMatch as { workspaceId?: string | null })
                      .workspaceId ?? null;
                  const body = await new EntityBodyService(
                    resolveDb,
                    eventRepository
                  ).setBody({
                    entityId: matchedId,
                    userId: ctx.userId,
                    workspaceId: matchWorkspaceId,
                    title: input.title || undefined,
                    provenance: {
                      createdByKind: "human",
                      createdByUserId: ctx.userId,
                    },
                    text: input.content,
                  });
                  if (body.documentId) {
                    const bodyDocId = body.documentId;
                    await enrichCaller.update({
                      id: matchedId,
                      documentId: bodyDocId,
                      source: enrichSource,
                      agentUserId: input.agentUserId,
                      reasoning: input.reasoning,
                    });
                    emitSideEffects({
                      subjectType: "document",
                      action: "create",
                      subjectId: bodyDocId,
                      userId: ctx.userId,
                      workspaceId: matchWorkspaceId ?? undefined,
                    }).catch((err) =>
                      logger.warn(
                        { err, documentId: bodyDocId },
                        "Document Typesense indexing failed (document still persisted)"
                      )
                    );
                  } else if (body.inlineContent !== undefined) {
                    await enrichCaller.update({
                      id: matchedId,
                      properties: { content: body.inlineContent },
                      source: enrichSource,
                      agentUserId: input.agentUserId,
                      reasoning: input.reasoning,
                    });
                  }
                } catch (bodyErr) {
                  dedupContentDropped = true;
                  logger.warn(
                    { bodyErr, entityId: matchedId },
                    "[entities.create] dedup body recovery failed — body not merged"
                  );
                }
              }
            }
            const dedupFacets = await attachRequestedFacets(matchedId);
            // Refetch SCOPED (same visibility gate as above) so the response
            // reflects the enrich, and an unauthorized row can never surface.
            const matched = await resolveDb.query.entities.findFirst({
              where: and(
                eq(entities.id, matchedId),
                isNull(entities.deletedAt),
                entityWriteVisibleWhere(ctx.userId)
              ),
            });
            logger.info(
              {
                // Stable observability event (T3a) — see the blocked_invisible
                // sibling above for why this is a structured log, not a counter.
                event: "identity_resolve_merge",
                outcome: "merged",
                userId: ctx.userId,
                entityId: matchedId,
                profileSlug,
              },
              "[entities.create] deduplicated onto existing entity (strong identity match)"
            );
            return {
              status: "created",
              message:
                "Entity deduplicated onto existing (strong identity match)",
              id: matchedId,
              entity: matched ? toApiEntity(matched) : null,
              // Additive: signals this create merged onto an existing entity.
              deduplicated: true,
              // B3: whether a long-form body carried by this create could NOT
              // be recovered onto the deduped entity (true only when the match
              // already had a body we won't clobber). Consumed by the composite
              // materializer's `contentDropped` diagnostic.
              contentDropped: dedupContentDropped,
              facets: dedupFacets,
            };
          }

          // ── WEAK same-name gate (Phase 1) ────────────────────────────────
          // Same profile + same title → reject with candidates. Never auto-
          // merge. forceCreate opts in to create anyway (logged). Cross-kind
          // same-title stays advisory only (not blocked). Strong invisible
          // fall-through above still proceeds; weak candidates are already
          // caller-scoped by resolveIdentity's userScope so no leak.
          if (profileSlug && identity.match !== "strong") {
            const weakGate = classifyWeakEntityDedup({
              forceCreate: input.forceCreate,
              profileSlug,
              match: identity.match,
              candidates: identity.candidates.map((c) => ({
                id: c.id,
                title: c.title,
                type: c.type,
              })),
            });
            if (weakGate.block) {
              logger.info(
                {
                  event: "identity_resolve_merge",
                  outcome: "blocked_weak",
                  userId: ctx.userId,
                  profileSlug,
                  candidateCount: weakGate.sameKindCandidates.length,
                },
                "[entities.create] weak same-name match — rejecting create with candidates"
              );
              throw new TRPCError({
                code: "CONFLICT",
                message: buildWeakEntityDedupMessage(
                  weakGate.sameKindCandidates,
                  profileSlug
                ),
                cause: buildWeakDedupCause(weakGate.sameKindCandidates),
              });
            }
            if (input.forceCreate && identity.match === "weak") {
              logger.info(
                {
                  event: "identity_resolve_merge",
                  outcome: "force_create",
                  userId: ctx.userId,
                  profileSlug,
                },
                "[entities.create] forceCreate=true — bypassing weak same-name gate"
              );
            }
          }
        } catch (resolveErr) {
          // Re-throw intentional gate rejects (junk already threw above; weak
          // CONFLICT is thrown inside the try). Only swallow resolver failures.
          if (resolveErr instanceof TRPCError) throw resolveErr;
          logger.warn(
            { resolveErr },
            "[entities.create] identity resolve failed — proceeding to create"
          );
        }
      }

      // Resolve the profile's entityScope ONCE, up-front, so workspace placement
      // is computed identically for the proposal-gated and auto-approved paths
      // (invariant I3). Reuses earlyResolvedProfile (profileId path); resolves by
      // slug otherwise. Carried forward to the materialize path below (no second
      // lookup). Fail-fast on an invalid profile — a proposal for a non-existent
      // profile can never materialize, so surfacing it here beats deferring to
      // the worker.
      if (!earlyResolvedProfile && profileSlug) {
        const database = await getDb();
        const resolutionService = new ProfileResolutionService(database);
        earlyResolvedProfile = await resolutionService.resolveProfile(
          profileSlug,
          ctx.userId,
          governanceWorkspaceId
        );
      }
      if (!earlyResolvedProfile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Profile not found: ${profileSlug}`,
        });
      }

      // Resolve placement ONCE through the one door (I1/I3). Persisted as
      // `resolvedWorkspaceId` for the materializer (four-door bug fix).
      //
      // Kind + facet slugs feed rungs 2–4 (ontology / context / relational) so
      // agents can create a lead/client WITHOUT inventing a workspaceId —
      // placement is derived from installed profile metadata on this pod
      // (dynamic; never hard-coded CRM/Ops). Same abstain rules as graph
      // capture: multi-candidate or no signal falls through to rung 6 (pod
      // entityScope → null; workspace-scope → ambient only when present).
      const placementDb = await getDb();
      const facetSlugsForPlacement = (input.facets ?? [])
        .map((f) => f.profileSlug)
        .filter((s): s is string => typeof s === "string" && s.length > 0);
      const entityPlacement = await resolveWorkspacePlacement(placementDb, {
        userId: ctx.userId,
        // Only an EXPLICIT target is rung-1. Omitting is undefined (not null)
        // so ontology can place; deliberate pod-wide uses global:true.
        explicitWorkspaceId: input.targetWorkspaceId
          ? input.targetWorkspaceId
          : undefined,
        globalFlag: input.global,
        workspaceScopedFlag: input.workspaceScoped === true,
        entityScope: earlyResolvedProfile.entityScope as
          "pod" | "workspace" | null | undefined,
        kindSlug:
          profileSlug ?? (earlyResolvedProfile as { slug?: string }).slug,
        ...(facetSlugsForPlacement.length
          ? { facetSlugs: facetSlugsForPlacement }
          : {}),
        // Ambient is advisory (MCP URL pin / session ctx) — never invent a
        // membership[0] ambient here. Ontology (rung 2) wins when definitive.
        ambientWorkspaceId: governanceWorkspaceId,
        ...(ctx.sessionId ? { context: { sessionId: ctx.sessionId } } : {}),
      });
      // Placement accept policy (shared pure helper with graph capture/import):
      // - Explicit pin / global / workspaceScoped → trust door result as-is
      // - Else deterministic ontology (rung ≤4, single candidate) → place
      // - Else K1: pod-scope kinds → null; workspace-scope → ambient only
      let resolvedEntityWorkspaceId: string | null;
      if (input.global || input.targetWorkspaceId || input.workspaceScoped) {
        resolvedEntityWorkspaceId = entityPlacement.workspaceId;
      } else {
        const deterministic =
          acceptDeterministicGraphWorkspace(entityPlacement);
        if (deterministic) {
          resolvedEntityWorkspaceId = deterministic;
        } else if (
          normalizeEntityScope(earlyResolvedProfile.entityScope) === "pod"
        ) {
          resolvedEntityWorkspaceId = null;
        } else {
          resolvedEntityWorkspaceId = entityPlacement.workspaceId;
        }
      }

      // Refuse domain dumps into admin/settings/agent/operational homes.
      // global:true → null (allowed). Pod-wide placement is fine; pinning or
      // ambient-resolving into a non-domain home is not — pick a domain app
      // or omit workspaceId for server placement. Hub create funnels here.
      if (resolvedEntityWorkspaceId) {
        const filingTarget = await placementDb.query.workspaces.findFirst({
          where: eq(workspaces.id, resolvedEntityWorkspaceId),
          columns: {
            workspaceType: true,
            systemSlug: true,
            settings: true,
          },
        });
        if (
          filingTarget &&
          !isDomainHomeWorkspace({
            workspaceType: filingTarget.workspaceType,
            systemSlug: filingTarget.systemSlug,
            settings: filingTarget.settings as {
              surfaceClass?: string | null;
              systemSlug?: string | null;
            } | null,
          })
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: DOMAIN_INTO_NON_DOMAIN_HOME_MESSAGE,
          });
        }
      }

      // Project placement — the deterministic sibling door (explicit input.projectId
      // → producing session's project). Rung 1 (explicit) preserves the historical
      // inline behavior exactly; rung 2 (session) is the additive gain. An
      // AI-guessed project never routes through here — that stays a propose/advisory
      // chip, never an auto-link (belongs_to_project WIDENS cross-workspace access).
      //
      // Rung 3.5 (declared focus) is threaded here because this door already
      // carries the acting agent identity. Read ONLY when nothing more specific
      // could pin a project, so the extra lookup costs nothing on the common
      // path — and it is a DECLARATION the agent made via
      // `synap_set_project_focus` (verified to exist and be visible at set
      // time), never anything derived from this entity's content.
      const declaredFocusProjectId =
        !input.projectId && input.agentUserId
          ? await getAgentFocusProjectId(input.agentUserId)
          : null;
      const projectPlacement = await resolveProjectPlacement(placementDb, {
        userId: ctx.userId,
        explicitProjectId: input.projectId,
        sessionId: ctx.sessionId,
        focusProjectId: declaredFocusProjectId,
      });
      const resolvedProjectId = projectPlacement.projectId;

      // Governance home MUST follow resolved placement when ontology pins a
      // workspace (agent omit workspaceId → rung 2 place). Otherwise proposals
      // land pod-null while data materializes in CRM, and workspace AI policy
      // never runs. Ambient remains fallback when placement is pod-wide null.
      const permWorkspaceId =
        resolvedEntityWorkspaceId ?? governanceWorkspaceId;

      // 1. Emit .requested event — records intent regardless of outcome
      const requestedEvent = await auditLog({
        subjectType: "entity",
        action: "create",
        phase: "requested",
        subjectId: entityId,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: permWorkspaceId,
        correlationId,
        data: {
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content ? "[content]" : undefined,
          global: input.global,
        },
      });

      // 2. Permission check (may create proposal with correlationId)
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: permWorkspaceId,
        subjectType: "entity",
        action: "create",
        source: input.source,
        issuer,
        reasoning: input.reasoning,
        correlationId,
        requestedEventId: requestedEvent?.id,
        sourceMessageId: ctx.sourceMessageId ?? undefined,
        sessionId: ctx.sessionId ?? undefined,
        projectId: resolvedProjectId ?? undefined,
        data: {
          id: entityId,
          profileSlug,
          title: input.title,
          description: input.description,
          properties: input.properties,
          documentId: input.documentId,
          content: input.content,
          global: input.global,
          // I3 (resolve-early-and-persist): the RESOLVED placement (may be an
          // explicit null for pod-scope kinds). The materializer reads this back
          // verbatim; a present key — including null — beats its legacy
          // `data.global ? null : workspaceId` derivation.
          resolvedWorkspaceId: resolvedEntityWorkspaceId,
          // R2: carry facets on the proposal so approve attaches them (same
          // shape as create input / composite op.facets). No longer dropped.
          ...(input.facets?.length
            ? {
                facets: input.facets.map((f) => ({
                  profileSlug: f.profileSlug,
                  ...(f.status ? { status: f.status } : {}),
                  ...(f.properties ? { properties: f.properties } : {}),
                  ...(f.contextEntityId
                    ? { contextEntityId: f.contextEntityId }
                    : {}),
                })),
              }
            : {}),
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // PHANTOM ENVELOPE ID FIX: a "proposed" response must NOT carry a
        // top-level `id` that looks like a materialized entity id — nothing was
        // created yet, and downstream callers were treating that phantom id as a
        // real entity. Carry only `proposalId` (the reviewable handle). `entity`
        // stays null to signal "no materialized row". However, we DO expose the
        // stable `proposedEntityId` (pre-generated at the top of this handler) so
        // AI agents can reference this entity in cross-write proposal graphs.
        // A "proposed" outcome is NOT always the entity. When the author lacks
        // membership on the governing workspace, `checkPermissionOrPropose`
        // deliberately files a WORKSPACE-JOIN gate instead of the content write
        // (permission-check.ts, join-gate branch). `perm.proposalType` is the
        // discriminator that says which happened — so derive the prose and the
        // pre-allocated id FROM it rather than asserting the entity case.
        //
        // This is the same defect the PHANTOM ENVELOPE ID comment above fixed
        // for `id`, one field over: a receipt that narrates a write that never
        // happened, plus an id that can never resolve. An external agent read
        // `proposedEntityId` off a join gate, found it unresolvable, and
        // published a wrong root cause built on it. Hub REST already branches
        // on this (`hub-protocol/entities.ts`, "JOIN gate" comment); this is
        // the same rule applied at the shared source instead of one door.
        const joinGate = isJoinGate(perm.proposalType);
        return {
          status: "proposed",
          message: proposedMessageFor(
            perm.proposalType,
            "Entity creation proposed for review"
          ),
          entity: null as Record<string, unknown> | null,
          proposalId: perm.proposalId,
          proposalType: perm.proposalType,
          reviewUrl: perm.reviewUrl,
          // Only real on the entity path: on a join gate no entity id was ever
          // allocated, and an unresolvable id is worse than an absent field.
          ...(joinGate ? {} : { proposedEntityId: entityId }),
          // Homed proposal: same as materialize target (may be null = pod-wide).
          workspaceId: resolvedEntityWorkspaceId,
          effectiveWorkspaceId: resolvedEntityWorkspaceId,
          // Facets ride the proposal payload and attach on approve (R2).
          // outcome "pending" = will attach after approval (not dropped).
          facets: (input.facets ?? []).map((f) => ({
            slug: f.profileSlug,
            // `status` deprecated (operation-outcome overload) — read `outcome`.
            status: "pending",
            outcome: "pending",
            message: joinGate
              ? "Not attached — no entity was proposed; approve the workspace-join request first."
              : "Role will attach when this create proposal is approved",
          })),
        };
      }

      // 3. Materialize — inline DB write (auto-approved)
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);

      // Profile + placement were already resolved up-front (before the perm
      // check) so the proposal-gated and auto-approved paths land identically
      // (I3). Reuse both here — `resolvedEntityWorkspaceId` is the value the
      // proposal persisted as `data.resolvedWorkspaceId`.
      const resolvedProfile: any = earlyResolvedProfile;
      const entityWorkspaceId = resolvedEntityWorkspaceId;

      // Merge profile.defaultValues into caller-supplied properties.
      const profileDefaults =
        (resolvedProfile?.defaultValues as Record<string, unknown>) ?? {};
      const effectiveProperties: Record<string, unknown> = {
        ...profileDefaults,
        ...(input.properties ?? {}),
      };

      // RETRY-SAFE DEDUP (W3, direct/auto-approved writes — the "No approval
      // received" damage): the client's confirmation window can give up on a
      // write that already landed, the model retries, and — unlike an
      // agent-authored PROPOSAL (hash-deduped by `insertPendingProposal`) — a
      // granted/auto-approved create had NOTHING catching an identical retry,
      // so it duplicated. Scoped to agent-driven writes ONLY (`agentUserId`
      // set) — mirrors `insertPendingProposal`'s human-exemption: a person may
      // deliberately file the same note/task twice, so a human direct write is
      // NEVER deduped here. Runs BEFORE `entityBodyService.setBody` below
      // (which would otherwise mint a fresh document on every retry).
      // `shouldMaterializeAsDocument` predicts the SAME inline/document branch
      // `setBody` will take from `input.content` — long-form content that
      // routes to a document is OUT OF SCOPE here (its text lives in object
      // storage via `documents.storageKey`, not a column this lookup can
      // compare); this covers the common case (short/no content), which is
      // the bulk of agent-driven note/task creates.
      if (input.agentUserId) {
        const contentGoesToDocument =
          !!input.content && shouldMaterializeAsDocument(input.content);
        if (!contentGoesToDocument) {
          try {
            const candidates = await database
              .select({
                id: entities.id,
                properties: entities.properties,
              })
              .from(entities)
              .where(
                and(
                  eq(entities.agentUserId, input.agentUserId),
                  eq(entities.profileId, earlyResolvedProfile.id),
                  entityWorkspaceId
                    ? eq(entities.workspaceId, entityWorkspaceId)
                    : isNull(entities.workspaceId),
                  input.title
                    ? eq(entities.title, input.title)
                    : isNull(entities.title),
                  isNull(entities.deletedAt),
                  drizzleSql`${entities.createdAt} >= now() - (${idempotencyWindowSeconds()}::int * interval '1 second')`
                )
              )
              .orderBy(desc(entities.createdAt))
              .limit(5);

            const dup = candidates.find((c) => {
              const props = (c.properties ?? {}) as Record<string, unknown>;
              const sameContent = input.content
                ? props.content === input.content
                : props.content == null;
              if (!sameContent) return false;
              return Object.entries(effectiveProperties).every(
                ([k, v]) => JSON.stringify(props[k]) === JSON.stringify(v)
              );
            });

            if (dup) {
              const matched = await database.query.entities.findFirst({
                where: eq(entities.id, dup.id),
              });
              const dedupFacets = await attachRequestedFacets(dup.id);
              logger.info(
                {
                  event: "entity_create_dedup",
                  entityId: dup.id,
                  profileSlug,
                  agentUserId: input.agentUserId,
                },
                "[entities.create] retry-safe dedup: returning previously created entity, no second row written"
              );
              return {
                status: "created",
                message:
                  "Duplicate retry ignored — returning the previously created entity",
                id: dup.id,
                entity: matched ? toApiEntity(matched) : null,
                ackState: "duplicate-ignored" as const,
                facets: dedupFacets,
              };
            }
          } catch (err) {
            logger.warn(
              { err },
              "[entities.create] retry-dedup lookup failed — creating normally"
            );
          }
        }
      }

      let createdEntity: any;

      // Resolve where content lives ONCE (heuristic-gated, shared with the
      // capture paths) via the canonical body door (EntityBodyService): long-form
      // → a versioned document linked via documentId, short → inline
      // properties.content. The document is scoped to the SAME workspace as the
      // entity so a workspace purge reclaims both. The service owns Document +
      // Storage ONLY — documentId linking, properties.content, and the Typesense
      // side-effect stay caller concerns here.
      const entityBodyService = new EntityBodyService(database, eventRepo);
      let contentDocumentId: string | undefined;
      let inlineContent: string | undefined;
      if (input.content) {
        const body = await entityBodyService.setBody({
          entityId,
          userId: ctx.userId,
          workspaceId: entityWorkspaceId ?? null,
          title: input.title || undefined,
          // Behavior-preserving: the prior materializeContentDocument path stamped
          // the document with default `human` provenance (no agent/correlation).
          provenance: {
            createdByKind: "human",
            createdByUserId: ctx.userId,
          },
          text: input.content,
        });
        contentDocumentId = body.documentId;
        inlineContent = body.inlineContent;
        // Typesense index the new document (caller concern — the service is
        // side-effect-free). Fire-and-forget; indexing failure never blocks.
        if (contentDocumentId) {
          const indexedDocumentId = contentDocumentId;
          emitSideEffects({
            subjectType: "document",
            action: "create",
            subjectId: indexedDocumentId,
            userId: ctx.userId,
            workspaceId: entityWorkspaceId ?? undefined,
          }).catch((err) =>
            logger.warn(
              { err, documentId: indexedDocumentId },
              "Document Typesense indexing failed (document still persisted)"
            )
          );
        }
      }
      const documentId = contentDocumentId ?? input.documentId ?? undefined;
      const propertiesWithContent: Record<string, unknown> =
        inlineContent !== undefined
          ? { ...effectiveProperties, content: inlineContent }
          : effectiveProperties;

      try {
        createdEntity = await entityRepo.create(
          {
            workspaceId: entityWorkspaceId ?? undefined,
            userId: ctx.userId,
            title: input.title || undefined,
            preview: input.description || undefined,
            documentId,
            properties: propertiesWithContent,
            profileSlug,
            // Provenance (Wave B3): inline (granted) write. source_proposal_id
            // stays null on the inline path per decision.
            ...stampProvenance({
              userId: ctx.userId,
              agentUserId: input.agentUserId,
              correlationId,
            }),
          },
          ctx.userId
        );
      } catch (createErr) {
        // Compensate: if we materialized a document for this entity but the
        // entity create then failed, delete the now-orphaned document (nothing
        // points to it) so we don't leak storage + a stranded row. deleteBody is
        // the service's reverse-cascade — it also cleans the storage objects the
        // bare DocumentRepository.delete used to leave behind.
        if (contentDocumentId) {
          try {
            await entityBodyService.deleteBody({
              documentId: contentDocumentId,
            });
          } catch (cleanupErr) {
            logger.warn(
              { cleanupErr, documentId: contentDocumentId },
              "Failed to clean up orphaned document after entity create failure"
            );
          }
        }
        const msg =
          createErr instanceof Error ? createErr.message : String(createErr);
        logger.error(
          {
            err: createErr,
            profileSlug,
            title: input.title,
            workspaceId: entityWorkspaceId,
          },
          "Entity creation failed"
        );
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Entity creation failed: ${msg}`,
          // Preserve the original error (e.g. PropertyValidationError) so
          // callers that reuse this door (capture's retry-as-note ladder)
          // can branch on the real failure type instead of the wrapped message.
          cause: createErr,
        });
      }

      // Register the external_id identity anchor on the freshly created row.
      // Unlike email/phone/url (auto-extracted inside EntityRepository.create),
      // external_id is not derived from any property, so it must be registered
      // explicitly — via the SAME signal door — so a repeat create with this
      // provider id dedups onto this entity. Advisory: never fails the create.
      if (externalIdSignal.length > 0 && createdEntity?.id) {
        try {
          await registerIdentitySignals(
            database,
            createdEntity.id,
            externalIdSignal,
            input.source ?? "entities.create"
          );
        } catch (sigErr) {
          logger.warn(
            { sigErr, entityId: createdEntity.id },
            "[entities.create] external_id signal registration failed (entity created)"
          );
        }
      }

      // Provenance: when this entity is created inside a focus session, record
      // `session --produced--> entity`. This is the AUTO-APPROVED (granted) inline
      // path — the default live BYOA case (`entity.create` ∈ DEFAULT_AUTO_APPROVE),
      // which never enqueues the materializer worker nor a proposal. Without this
      // emit the session room's Deliverable surface stays empty even on success.
      // The proposal-gated paths (worker + composite + single-entity approve) emit
      // the same link; together all four paths populate by construction.
      // Idempotent via the links unique-edge index.
      if (ctx.sessionId && createdEntity?.id) {
        await database
          .insert(links)
          .values({
            workspaceId: entityWorkspaceId ?? null,
            fromType: "session" as LinkEndpointType,
            fromId: ctx.sessionId,
            toType: "entity" as LinkEndpointType,
            toId: createdEntity.id,
            linkType: "produced" as LinkType,
            metadata: {},
          })
          .onConflictDoNothing();
      }

      // Membership: file the entity into the DETERMINISTICALLY resolved project
      // lens (the project mirror of workspaceId) on the granted inline path. The
      // proposal path is covered by checkPermissionOrPropose threading the same
      // resolvedProjectId → the materializer. Idempotent via
      // relations_belongs_to_project_unique.
      if (resolvedProjectId && createdEntity?.id) {
        await linkEntityToProject(database, {
          entityId: createdEntity.id,
          projectId: resolvedProjectId,
          userId: ctx.userId,
          workspaceId: entityWorkspaceId ?? null,
        });
      }

      // 3b. Auto-sync entity_id properties → relations (non-blocking)
      //
      // Use earlyResolvedProfile.id (the profile `effectiveProperties` were
      // actually validated/submitted against), NOT createdEntity.profileId —
      // when profileSlug resolved to a ROLE, EntityRepository.create's
      // adapter repoints the row onto the role's applicable KIND, so
      // createdEntity.profileId is the kind's id. Relation-typed property
      // defs (valueType=ENTITY_ID) that live on the ROLE profile would then
      // never be found by profileId lookup and silently stop syncing.
      // earlyResolvedProfile is identical to createdEntity.profileId in the
      // non-role case, so this is a no-op behavior change there.
      if (
        earlyResolvedProfile &&
        effectiveProperties &&
        Object.keys(effectiveProperties).length > 0
      ) {
        syncPropertyToRelations(
          createdEntity.id,
          earlyResolvedProfile.id,
          governanceWorkspaceId,
          ctx.userId,
          {}, // old properties = empty (new entity)
          effectiveProperties as Record<string, unknown>
        ).catch((err) => {
          logger.warn(
            { err },
            "[entities.create] Property→relation sync failed"
          );
        });
      }

      // 3c. Identity signals (email/phone/url/handle) are now registered inside
      // EntityRepository.create — the ONE create door — so every producer that
      // reaches it (imports, provisioning, automation/feed workers) feeds
      // resolveIdentity's strong path, not just this router. See
      // entity-repository.ts create() step 6.

      // 4. Emit .completed event + side-effects — ONE door (recordDomainMutation)
      // so the timeline append and the automation fan-out can never drift apart.
      // Session-stamped so the matcher resolves it → playbook → `member_of`
      // automations for entities produced in this session (e.g. import under a
      // contact-leads playbook). Null on non-session paths → workspace-wide only.
      // `logData` keeps `global` on the audit row (the fan-out never carried it).
      await recordDomainMutation({
        subjectType: "entity",
        action: "create",
        subjectId: createdEntity.id,
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        // Governance linkage (0231): stamp the auto-approve receipt so this agent
        // write reads as GOVERNED, not an "ungoverned AI write". `perm` is the
        // granted result here (denied + proposed already returned above).
        // Composite/graph callers (capture auto-apply, proposal approval) run
        // this door through `createCaller` with an already-decided governance
        // receipt in hand: the write is authorized by THAT proposal, and the
        // per-call `perm` here is a first-party grant carrying no receipt of its
        // own. Without this, every entity a capture graph creates landed with
        // `events.proposal_id = NULL` and the object graph's `via: "governed"`
        // fold found no proposal neighbour — the capture door's created entities
        // were the only ones with no visible authorizer. Narrow typed read: the
        // field is an INTERNAL composite-caller channel, never set from HTTP
        // (createContext builds no such field), so it is not on the public ctx.
        proposalId:
          ("granted" in perm ? perm.autoApprovedProposalId : undefined) ??
          (ctx as { governanceProposalId?: string }).governanceProposalId,
        workspaceId: governanceWorkspaceId,
        correlationId,
        sessionId: ctx.sessionId ?? null,
        data: { profileSlug, title: input.title },
        logData: { profileSlug, title: input.title, global: input.global },
      });

      // Dispatch entity embedding job (non-blocking — failure never blocks creation)
      try {
        await getBoss().send("entity-embedding", {
          entityId: createdEntity.id,
          title: createdEntity.title || input.title,
          preview: createdEntity.preview || input.description,
          userId: ctx.userId,
          action: "create",
        });
      } catch (err) {
        logger.warn({ err }, "[entities.create] Failed to queue embedding job");
      }

      // Dispatch AI classification for raw captures (non-blocking)
      // Upgrades profileSlug from "capture" → typed profile (note, bookmark, task…)
      if (profileSlug === "capture") {
        try {
          await getBoss().send("ai-analysis", {
            entityId: createdEntity.id,
            workspaceId: ctx.workspaceId,
            userId: ctx.userId,
          });
        } catch (err) {
          logger.warn(
            { err },
            "[entities.create] Failed to queue AI analysis job"
          );
        }
      }

      // Kind + Facets: attach any requested roles now that the entity exists,
      // through the governed door. Additive `facets` summary — always an array
      // (empty when none requested); a direct field, not a conditional spread,
      // so the union stays `.id`-narrowable for the door's many callers.
      const createdFacets = await attachRequestedFacets(createdEntity.id);

      // If profileSlug itself resolved to a ROLE, EntityRepository.create's
      // adapter silently attached it as a facet (never a second entity) — that
      // facet is invisible above (attachRequestedFacets only sees input.facets)
      // so a caller creating profileSlug:"client" would otherwise get back
      // `entity.type:"person"` + `facets:[]`, with the submitted role nowhere
      // in the response. Surface it explicitly.
      if (earlyResolvedProfile?.profileKind === "role") {
        const facetRepo = new FacetRepository(database, eventRepo);
        const liveFacets = await facetRepo.getByEntity(createdEntity.id, {
          userId: ctx.userId,
          workspaceId: governanceWorkspaceId,
        });
        const adapterFacet = liveFacets.find(
          (f) => f.profileId === earlyResolvedProfile.id
        );
        if (
          adapterFacet &&
          !createdFacets.some((f) => f.facetId === adapterFacet.id)
        ) {
          createdFacets.push({
            slug: earlyResolvedProfile.slug,
            status: "attached",
            outcome: "attached",
            facetId: adapterFacet.id,
          });
        }
      }

      return {
        status: "created",
        message: "Entity created",
        id: createdEntity.id,
        entity: toApiEntity(createdEntity),
        facets: createdFacets,
        // Advisory: property keys the caller sent that no property_def models.
        // Stored verbatim (never a failure) but surfaced on the write receipt
        // with a did-you-mean, so an agent that invents a key is TOLD instead
        // of getting a silent 200. Forwarded EXPLICITLY — it also rides along
        // inside `entity` via toApiEntity's spread, but relying on that is
        // incidental and would break silently if the spread ever changed.
        ...(createdEntity.unmodeled?.length
          ? { unmodeled: createdEntity.unmodeled }
          : {}),
      };
    }),
  batchCreate: podProcedure
    .input(
      z.object({
        entities: z.array(
          z.object({
            /** Stable caller-supplied reference key (e.g. "app:web", "pkg:@synap-core/client") */
            refKey: z.string().min(1),
            profileSlug: z.string().min(1),
            title: z.string().min(1),
            description: z.string().optional(),
            properties: z.record(z.string(), z.unknown()).optional(),
            content: z.string().optional(),
            source: z
              .enum(["user", "ai", "intelligence", "system", "agent", "cli"])
              .optional(),
            /** If the profile doesn't exist, create it with these hints */
            profileHints: z
              .object({
                displayName: z.string().optional(),
                icon: z.string().optional(),
                color: z.string().optional(),
                description: z.string().optional(),
              })
              .optional(),
          })
        ),
      })
    )
    .output(
      z.object({
        created: z.number(),
        skipped: z.number(),
        profilesCreated: z.number(),
        entityIds: z.record(z.string(), z.string()), // refKey → entityId
        errors: z.array(
          z.object({
            refKey: z.string(),
            error: z.string(),
          })
        ),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const database = await getDb();
      // Must be the shared singleton, not `new EventRepository(sql)` — a fresh
      // instance has no registered hooks, so emitCompleted()'s append silently
      // never reaches the realtime/materialization/sync hooks.
      const eventRepo = eventRepository;
      const entityRepo = new EntityRepository(database, eventRepo);
      const profileRepo = new (
        await import("@synap/database")
      ).ProfileRepository(database);

      // 1. Ensure all profiles exist (auto-create missing ones)
      const profileCache = new Map<string, string>(); // slug → id
      // slug → the profile's entity-scope ("pod" | "workspace"), for placement.
      const entityScopeCache = new Map<string, string | null>();
      // slug → resolved workspace placement (computed once per slug via the door).
      const placementCache = new Map<string, string | null>();
      let profilesCreated = 0;

      // Gather unique profile slugs that need hints
      const profileHintsMap = new Map<
        string,
        {
          displayName?: string;
          icon?: string;
          color?: string;
          description?: string;
        }
      >();
      for (const e of input.entities) {
        if (e.profileHints && !profileHintsMap.has(e.profileSlug)) {
          profileHintsMap.set(e.profileSlug, e.profileHints);
        }
      }

      for (const entity of input.entities) {
        if (profileCache.has(entity.profileSlug)) continue;

        // Resolve the existing profile. `getBySlug` tolerates a null workspace
        // (pod-wide floor: SYSTEM/SHARED + the caller's member profiles) —
        // `getBySlugForWorkspace` demands a string, so it can't serve the relaxed
        // pod-wide path. With a workspace it delegates to the same lookup, so
        // behavior is identical when one is present.
        const existing = await profileRepo.getBySlug(
          entity.profileSlug,
          ctx.workspaceId ?? undefined,
          ctx.userId
        );
        if (existing) {
          profileCache.set(entity.profileSlug, existing.id);
          entityScopeCache.set(
            entity.profileSlug,
            existing.entityScope ?? null
          );
          continue;
        }

        // Profile doesn't exist. Auto-creating it needs a concrete workspace to
        // scope the new (workspace-scoped) profile to — the pod-wide path can't
        // invent one, so leave the slug uncached; each such row is reported as an
        // error in step 3 rather than forcing a bogus scope.
        if (!ctx.workspaceId) continue;
        const hints = profileHintsMap.get(entity.profileSlug) ?? {};
        const newProfile = await profileRepo.create({
          slug: entity.profileSlug,
          displayName: hints.displayName ?? entity.profileSlug,
          uiHints: {
            icon: hints.icon,
            color: hints.color,
            description: hints.description,
          },
          scope: "workspace" as any,
          workspaceId: ctx.workspaceId,
          userId: ctx.userId,
        });
        profileCache.set(entity.profileSlug, newProfile.id);
        entityScopeCache.set(
          entity.profileSlug,
          newProfile.entityScope ?? null
        );
        profilesCreated++;
      }

      // 2. Resolve per-slug placement via the ONE door, UP FRONT (cached per
      // slug). An explicit ambient workspace PINS every row to it (rung 1 —
      // identical to the pre-relax behavior, no extra DB query); with no
      // ambient, a pod kind lands pod-wide and a workspace-scoped kind follows
      // its ontology (rung 2) — which can resolve to a concrete workspace even
      // on the headerless path. Resolving this BEFORE the idempotency check
      // below (rather than lazily per-row during creation) lets that check key
      // on where each slug will actually land.
      for (const entity of input.entities) {
        if (placementCache.has(entity.profileSlug)) continue;
        const placement = await resolveWorkspacePlacement(database, {
          userId: ctx.userId,
          kindSlug: entity.profileSlug,
          entityScope:
            (entityScopeCache.get(entity.profileSlug) as
              "pod" | "workspace" | null) ?? null,
          explicitWorkspaceId: ctx.workspaceId ?? undefined,
          ambientWorkspaceId: ctx.workspaceId,
        });
        placementCache.set(entity.profileSlug, placement.workspaceId);
      }

      // 3. Check for existing entities (idempotency by profileSlug + title),
      // scoped to the RESOLVED placement workspace per slug — not
      // unconditionally `isNull(workspaceId)`. On the headerless path a
      // workspace-scoped kind can resolve (rung 2 ontology) into a concrete
      // workspace; keying the dedup check on `isNull` alone missed those rows
      // entirely, so a re-run created a duplicate instead of matching the one
      // already placed there. Callers that pass an explicit ctx.workspaceId are
      // unaffected — every slug still resolves to that same pinned workspace.
      const placedWorkspaceIds = new Set(placementCache.values());
      const existingEntities = await database.query.entities.findMany({
        where: and(
          eq(entities.userId, ctx.userId),
          or(
            ...Array.from(placedWorkspaceIds).map((wsId) =>
              wsId
                ? eq(entities.workspaceId, wsId)
                : isNull(entities.workspaceId)
            )
          ),
          inArray(
            entities.type,
            input.entities.map((e) => e.profileSlug)
          )
        ),
      });

      const existingByKey = new Map<string, string>(); // "slug:title:workspaceId" → entityId
      for (const e of existingEntities) {
        existingByKey.set(
          `${e.type}:${e.title}:${e.workspaceId ?? "null"}`,
          e.id
        );
      }

      // 4. Create missing entities
      const entityIds: Record<string, string> = {};
      const errors: Array<{ refKey: string; error: string }> = [];
      let created = 0;
      let skipped = 0;

      for (const entity of input.entities) {
        const placedWorkspaceId =
          placementCache.get(entity.profileSlug) ?? null;
        const cacheKey = `${entity.profileSlug}:${entity.title}:${placedWorkspaceId ?? "null"}`;

        // Already exists → skip
        if (existingByKey.has(cacheKey)) {
          entityIds[entity.refKey] = existingByKey.get(cacheKey)!;
          skipped++;
          continue;
        }

        try {
          const profileId = profileCache.get(entity.profileSlug);
          if (!profileId) {
            throw new Error(`Profile ${entity.profileSlug} not in cache`);
          }

          const result = await entityRepo.create(
            {
              profileId,
              title: entity.title,
              properties: entity.properties,
              workspaceId: placedWorkspaceId,
              userId: ctx.userId,
              // Batch provisioning remains permissive for legacy templates,
              // except Knowledge: its canonical one-form contract must hold
              // at every entity creation door.
              skipValidation: entity.profileSlug !== "knowledge",
            },
            ctx.userId
          );
          entityIds[entity.refKey] = result.id;
          created++;
        } catch (err) {
          errors.push({
            refKey: entity.refKey,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return { created, skipped, profilesCreated, entityIds, errors };
    }),
};
