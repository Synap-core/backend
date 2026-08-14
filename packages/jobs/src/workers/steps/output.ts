/**
 * `output` step executor — the declarative write switch (entity_create,
 * entity_update, webhook, notification, channel_message, session_update,
 * set_state, facet_attach/update/detach, relation_create). The largest single
 * step family; kept as ONE module because every branch shares the SAME
 * idempotency-id/config/attribution preamble and the governance-gate pattern.
 */
import { randomUUID } from "crypto";
import {
  db,
  eq,
  and,
  or,
  isNull,
  desc,
  automations,
  entities,
  users,
  channels,
  notifications,
  focusSessions,
  playbookEnrollments,
  relations,
  drizzleSql,
  EntityRepository,
  EntityBodyService,
  materializeEntity,
  eventRepository,
  insertChannelMessage,
  ChannelRepository,
} from "@synap/database";
import { emitSideEffects } from "@synap/events";
import {
  resolveVaultReferences,
  isVaultReference,
} from "../../utils/vault-resolver.js";
import {
  checkAutomationWriteOrPropose,
  guardProducerEffect,
} from "../../utils/automation-governance.js";
import { deterministicUuidV5 } from "../../utils/deterministic-uuid.js";
import { validateExternalUrl, safeExternalFetch } from "@synap/shared-utils";
import { deepResolveTemplates } from "../template-resolve.js";
import { dispatchOutputVerb } from "../capability-dispatch.js";
import { logger } from "../automation-executor-logger.js";
import type {
  StepContext,
  ExecutionPayload,
} from "../automation-executor-types.js";

// CONFUSED-DEPUTY BACKSTOP: output sub-types whose confused-deputy posture has
// been consciously reviewed — either they consult the producer ladder
// (entity_create/entity_update/session_update via checkAutomationWriteOrPropose;
// facet_attach/update/detach + relation_create via dispatchOutputVerb's
// producerAgentUserId; webhook + channel_message via guardProducerEffect above),
// or they are pod-internal with no trust boundary an agent producer could exploit
// (notification = the owner's OWN attention row; set_state = run-local JSONB
// cursor). Any effect type NOT in this set fails CLOSED when an agent is in the
// causal chain — so a NEW effect node added later can never silently bypass the
// guard the way `webhook`/`channel_message` originally did (found post-hoc). To
// add a new effect type, classify it here (guard it, or justify it as internal).
const PRODUCER_REVIEWED_OUTPUT_TYPES = new Set<string>([
  "entity_create",
  "entity_update",
  "session_update",
  "webhook",
  "channel_message",
  "notification",
  "set_state",
  "facet_attach",
  "facet_update",
  "facet_detach",
  "relation_create",
]);

export async function executeOutputStep(
  data: {
    outputType: string;
    config: Record<string, unknown>;
    label?: string;
  },
  context: StepContext,
  workspaceId: string,
  automationContext: ExecutionPayload["automationContext"],
  ownerId: string,
  actingUserId: string,
  // Workflow attribution (D3a): the executing flow node + its step-run row, so a
  // governed write becomes a proposal that traces back to the exact step. In a
  // loop body the step run is the loop node's (no per-child row), while nodeId
  // is the child node — the closest honest attribution.
  attribution?: { nodeId?: string; stepRunId?: string },
  // The run's subject entity, when the run was launched about one — lets the
  // `channel_message` node target `channelType:'subjectEntity'` (this run's
  // subject's channel) without hardcoding a channelId.
  runSubjectEntityId?: string | null,
  // CONFUSED-DEPUTY GUARD: the causal-chain producer (see ExecutionPayload /
  // automation-trigger-matcher). When an AGENT is in the chain, the governed
  // write below is resolved against that agent — so an agent-produced trigger
  // firing a HUMAN-owned automation PROPOSES the THEN-action instead of
  // auto-executing it ungoverned. Absent → owner-only governance, unchanged.
  producerAgentUserId?: string | null
): Promise<Record<string, unknown>> {
  // Deep-resolve all template variables in config
  const config = deepResolveTemplates(data.config, context) as Record<
    string,
    unknown
  >;

  // Wave 4.R idempotency: the side-effecting output steps below (notification,
  // channel_message) derive their row id deterministically from (runId, nodeId,
  // loop iteration) so a crash-redelivered run re-inserts the SAME id and
  // conflicts on the primary key (onConflictDoNothing) instead of duplicating
  // the effect — exactly-once per (run, node, iteration). `context.loop.index`
  // is the loop iteration when this step runs inside a loop body, undefined
  // otherwise (it threads through the existing per-item loop context — no new
  // plumbing). `attribution.nodeId` is always supplied by both call sites; the
  // undefined-guard just falls back to a random id rather than crashing.
  const idemNodeId = attribution?.nodeId;
  const outputIdemId = (kind: string): string | undefined =>
    idemNodeId === undefined
      ? undefined
      : deterministicUuidV5(
          `${kind}:${automationContext.automationRunId}:${idemNodeId}:${context.loop?.index ?? "-"}`
        );

  // Backstop: an agent in the causal chain may only reach effect types whose
  // confused-deputy posture has been reviewed (see PRODUCER_REVIEWED_OUTPUT_TYPES).
  // Fires only when a distinct agent producer is present, so human/system/cron
  // triggers and owner-authored automations are byte-unchanged.
  if (
    typeof producerAgentUserId === "string" &&
    producerAgentUserId.length > 0 &&
    producerAgentUserId !== ownerId &&
    !PRODUCER_REVIEWED_OUTPUT_TYPES.has(data.outputType)
  ) {
    throw new Error(
      `output type "${data.outputType}" has no confused-deputy classification and cannot auto-execute with an agent in the trigger chain (fail-closed backstop). Classify it in PRODUCER_REVIEWED_OUTPUT_TYPES.`
    );
  }

  switch (data.outputType) {
    case "entity_create": {
      const profileSlug = (config.profileSlug as string) ?? "note";
      const title = config.title as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;
      // Optional SYSTEM DATA — machine state stamped on the created row's
      // `entities.system_data` column, never rendered as a user-editable
      // property. This is what lets a generator mark the entity it just
      // produced (run id, source cursor, an idempotency stamp another worker
      // reads back) without polluting the entity's schema-validated
      // `properties`. Templates inside it resolve for free: the WHOLE `config`
      // object already went through `deepResolveTemplates` at the top of this
      // function, exactly like `properties`, so `{{steps.x.output}}` works at
      // any depth here with no extra plumbing.
      // Absent → `undefined` → `EntityRepository.create` applies its `{}`
      // default, i.e. byte-for-byte the previous behavior.
      // CREATE-ONLY: `entity_update` has no counterpart and must not grow one
      // (see MaterializeEntityInput.systemData for why).
      const rawSystemData = config.systemData;
      const systemData =
        rawSystemData &&
        typeof rawSystemData === "object" &&
        !Array.isArray(rawSystemData)
          ? (rawSystemData as Record<string, unknown>)
          : undefined;
      // Optional long-form BODY (markdown), e.g. `body: "{{steps.assemble.output}}"`.
      // When present it is materialized through the canonical body door
      // (EntityBodyService) into a `documents` row linked via
      // `entities.documentId` — or folded into `properties.content` when the
      // heuristic says it is too short to be worth a document. Absent (or
      // whitespace-only) → EVERY line below behaves exactly as before.
      const rawBody = config.body;
      const bodyText =
        typeof rawBody === "string" && rawBody.trim() ? rawBody : undefined;

      // Idempotency + empty-guard. When the node declares `dedupeBy` (a property
      // key, e.g. "url" for bookmarks) we (1) SKIP when that value is empty — so a
      // message with no real link never spawns a blank entity — and (2) SKIP when
      // an entity of this profile already carries that value — so the same link in
      // many messages (or a backfill replay, or the digest re-embedding the
      // conversation) never creates duplicates. We skip BEFORE the governance gate,
      // so a duplicate isn't even proposed. Pod-scoped profiles (bookmark is one)
      // can live with workspaceId NULL, so match either.
      const dedupeBy = config.dedupeBy as string | undefined;
      if (dedupeBy) {
        const rawVal = properties[dedupeBy];
        const dedupeStr = rawVal == null ? "" : String(rawVal).trim();
        if (!dedupeStr) {
          return {
            status: "skipped",
            reason: `empty ${dedupeBy} — not creating`,
          };
        }
        const [existing] = await db
          .select({ id: entities.id })
          .from(entities)
          .where(
            and(
              or(
                eq(entities.workspaceId, workspaceId),
                isNull(entities.workspaceId)
              ),
              eq(entities.type, profileSlug),
              isNull(entities.deletedAt),
              drizzleSql`${entities.properties}->>${dedupeBy} = ${dedupeStr}`
            )
          )
          .limit(1);
        if (existing) {
          return {
            status: "skipped",
            reason: "duplicate",
            entityId: existing.id,
          };
        }
      }

      // Governed by the same policy as chat-AI writes (see automation-governance.ts):
      // auto-approve, or a PENDING proposal attributed to the owning agent.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "entity",
        action: "create",
        // The body travels WITH the proposal under `content` — the key the
        // approve path reads (`materializeEntity`'s `data.content`, and
        // approve-executors "entity/create"), so it is carried alongside
        // profileSlug/title/properties rather than being dropped at propose time.
        // Materializing at propose time instead would orphan a document + storage
        // object whenever the proposal is rejected.
        //
        // ⚠️ KNOWN PRE-EXISTING BUG, NOT INTRODUCED HERE, and it gates this
        // branch end-to-end: `proposeAutomationWrite` persists `data` FLAT
        // (jobs/src/utils/automation-governance.ts), while the entity/create
        // approve executor reads a NESTED envelope (`proposal.data?.data`,
        // approve-executors.ts) — the nesting the canonical chat door
        // (`checkPermissionOrPropose`) produces and the automation path bypasses.
        // Verified against live pod proposals, which are nested. So approving ANY
        // automation entity_create proposal currently throws "missing profileSlug",
        // body or not. Not reached on the default path because `entity.create` IS
        // in DEFAULT_AUTO_APPROVE (automations execute entity writes directly);
        // it bites `forceProposeWrites` sessions and tightened workspaces.
        // When the shape is fixed, `content` must land at `data.data.content` —
        // it sits alongside the other keys here, so a nesting fix carries it.
        data: {
          profileSlug,
          title,
          properties,
          ...(bodyText ? { content: bodyText } : {}),
          // Carried on the proposal so a force-propose workspace doesn't
          // SILENTLY lose the stamp. ⚠️ The entity/create approve executor
          // (api, approve-executors.ts) does not read this key yet — same
          // situation as `content` above; when the flat-vs-nested payload bug
          // there is fixed, `systemData` must be read alongside it. Omitted
          // entirely when unset, so the payload is unchanged for every
          // existing flow.
          ...(systemData ? { systemData } : {}),
        },
        reasoning: "Automation proposed creating an entity.",
        subjectProfileSlug: profileSlug,
        automationRunId: automationContext.automationRunId,
        correlationId: automationContext.rootRunId,
        sessionId: automationContext.focusSessionId,
        stepRunId: attribution?.stepRunId,
        nodeId: attribution?.nodeId,
        producerAgentUserId,
      });
      if ("denied" in gate) {
        throw new Error(`entity_create denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write. The change
        // awaits human review, attributed to the owning agent. The body is NOT
        // materialized here (there is no entity id yet, and a document written
        // now would be an orphan if the proposal is rejected): it is carried on
        // the proposal payload as `content` (above) and materialized by the
        // approve path. `bodyDeferred` makes that visible in the step output.
        return {
          status: "proposed",
          proposalId: gate.proposalId,
          ...(bodyText ? { bodyDeferred: true } : {}),
        };
      }

      // Attribution: this write is authored by the automation's owning
      // principal (`ownerId`). For AI-created automations that principal IS an
      // agent user; for manual automations it is a human. Resolve which, so the
      // materialized row's provenance is honest (previously it defaulted to
      // "human", mis-attributing agent-authored automation writes). We only
      // reach this direct-write branch after the governance gate GRANTED.
      const [ownerUser] = await db
        .select({ userType: users.userType })
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      // `correlationId` is carried on the SAME provenance object the document
      // path already uses, so the entity and its body land with identical run
      // attribution — "which run produced this?" is answerable for both.
      const provenance =
        ownerUser?.userType === "agent"
          ? {
              createdByKind: "ai_agent" as const,
              agentUserId: ownerId,
              createdByUserId: ownerId,
              correlationId: automationContext.rootRunId,
            }
          : {
              createdByKind: "system" as const,
              createdByUserId: ownerId,
              correlationId: automationContext.rootRunId,
            };

      // BODY (optional) — materialized through the canonical door BEFORE the
      // entity row is inserted, with the row id pre-minted, exactly like the
      // proposal materializer (materializer.ts:327-353). Rationale: the service
      // only needs the id to namespace the storage object (it never reads the
      // entity row), so pre-minting lets the entity be created ONCE already
      // carrying `documentId` — no post-create UPDATE, no window in which the
      // entity exists bodyless, and no second write to fail halfway.
      // FAILURE ISOLATION: setBody's text path catches its own storage/repo
      // failures and folds back to `{ inlineContent }` (entity-body-service.ts
      // :246-254), so a materialization failure degrades to inline content on
      // the entity instead of failing the step or orphaning a document. We add
      // no second layer — doing so would only convert a degraded-but-complete
      // write into a step failure, and pg-boss would retry it into a duplicate
      // entity.
      let documentId: string | undefined;
      let entityProperties = properties;
      // Only pre-mint (and pass) an id on the body path — the no-body path keeps
      // its DB-minted uuid, byte-for-byte the previous behavior.
      const preMintedEntityId = bodyText ? randomUUID() : undefined;

      if (bodyText && preMintedEntityId) {
        const body = await new EntityBodyService(db, eventRepository).setBody({
          entityId: preMintedEntityId,
          userId: ownerId,
          workspaceId: workspaceId ?? null,
          title: title || undefined,
          text: bodyText,
          // Provenance travels verbatim onto the `documents` row — the same
          // agent/system attribution the entity row gets, plus the run's
          // correlation id. Never re-labelled "human".
          provenance: {
            ...provenance,
            createdByUserId: ownerId,
            correlationId: automationContext.rootRunId,
          },
        });
        if (body.documentId) {
          documentId = body.documentId;
        } else if (body.inlineContent !== undefined) {
          // Short body → stays inline on the entity (no document row created).
          entityProperties = { ...properties, content: body.inlineContent };
        }
      }

      // materializeEntity wraps EntityRepository.create: profile resolution,
      // pod-wide scoping, property indexing, event emission — plus provenance.
      const { entity } = await materializeEntity(
        {
          ...(preMintedEntityId ? { id: preMintedEntityId } : {}),
          profileSlug,
          title,
          properties: entityProperties,
          ...(systemData ? { systemData } : {}),
          ...(documentId ? { documentId } : {}),
          workspaceId,
          userId: ownerId,
          skipValidation: true,
        },
        {
          db,
          eventRepo: eventRepository,
          provenance,
        }
      );

      return {
        status: "created",
        entityId: entity.id,
        title: entity.title,
        ...(documentId ? { documentId } : {}),
      };
    }

    case "entity_update": {
      const entityId = config.entityId as string;
      const properties = (config.properties ?? {}) as Record<string, unknown>;

      if (!entityId)
        throw new Error("entity_update requires entityId in config");

      // Look up the target entity's profile slug so profile-scoped governance
      // rules (e.g. "note=auto, lead=propose") can match on UPDATE the same way
      // they already do on CREATE. `entities.type` IS the profile slug — it's
      // populated from `profile.slug` at create time (entity-repository.ts) and
      // used as the profile-slug filter elsewhere (e.g. `eq(entities.type, profileSlug)`
      // in listEntities). Entity-not-found just leaves this undefined, which the
      // gate treats as "no profile match" — never a hard failure.
      const [targetEntity] = await db
        .select({ type: entities.type })
        .from(entities)
        .where(eq(entities.id, entityId))
        .limit(1);

      // Governed — same gate as entity_create above.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "entity",
        action: "update",
        data: { entityId, properties },
        reasoning: "Automation proposed updating an entity.",
        subjectProfileSlug: targetEntity?.type,
        automationRunId: automationContext.automationRunId,
        correlationId: automationContext.rootRunId,
        sessionId: automationContext.focusSessionId,
        stepRunId: attribution?.stepRunId,
        nodeId: attribution?.nodeId,
        producerAgentUserId,
      });
      if ("denied" in gate) {
        throw new Error(`entity_update denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write. The change
        // awaits human review, attributed to the owning agent.
        return { status: "proposed", proposalId: gate.proposalId };
      }

      // Route through EntityRepository so validation, entity_property_index
      // reindex, and the workspace-scoped property lens (Phase 2) all run.
      // `skipEvent: true` prevents double-emission — we emit our own
      // automation-context event via emitSideEffects() below, which carries
      // the automationContext metadata the repo doesn't know about.
      const entityRepo = new EntityRepository(db, eventRepository);
      await entityRepo.update(
        entityId,
        {
          properties,
          workspaceId,
          skipEvent: true,
        },
        actingUserId
      );

      await emitSideEffects({
        subjectType: "entity",
        action: "update",
        subjectId: entityId,
        userId: ownerId,
        workspaceId,
        data: { updatedProperties: Object.keys(properties) },
        automationContext,
      });

      return { status: "updated", entityId };
    }

    case "webhook": {
      // CONFUSED-DEPUTY GUARD (M1): a webhook resolves the OWNER's vault secrets
      // into headers (`resolveVaultReferences(headers, ownerId)` below) and POSTs
      // agent-influenced data to an external URL. On the observations/governed-event
      // path a human-owned automation runs its THEN-nodes under owner-bypass, so an
      // agent-produced trigger could exfiltrate the owner's secret to an
      // agent-chosen endpoint ungoverned. This is the one effect node that reaches
      // OUTSIDE the pod, so it fails closed BEFORE any URL/SSRF/vault work.
      const webhookGuard = await guardProducerEffect({
        producerAgentUserId,
        principalUserId: ownerId,
        workspaceId,
        subjectType: "webhook",
        action: "send",
      });
      if ("block" in webhookGuard) {
        throw new Error(
          webhookGuard.kind === "deny"
            ? `webhook denied by producer-agent governance (confused-deputy guard): ${webhookGuard.reason ?? "denied"}`
            : `webhook cannot auto-execute: an agent produced this trigger, so a human-owned automation may not POST to an external URL with the owner's credentials ungoverned (confused-deputy guard).`
        );
      }

      const url = config.url as string;
      let headers = (config.headers ?? {}) as Record<string, string>;
      const body = config.body ?? config;

      if (!url) throw new Error("webhook output requires url in config");

      // SSRF guard: reject internal/reserved targets BEFORE resolving any
      // vault secrets into headers (never leak a secret to a private address).
      const webhookUrlCheck = validateExternalUrl(url);
      if (!webhookUrlCheck.valid) {
        throw new Error(`webhook output blocked: ${webhookUrlCheck.reason}`);
      }

      // Resolve vault references in headers (e.g., Authorization: vault://secret-id)
      const hasVaultHeaders = Object.values(headers).some(isVaultReference);
      if (hasVaultHeaders) {
        headers = await resolveVaultReferences(headers, ownerId);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      try {
        const response = await safeExternalFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        clearTimeout(timer);

        return {
          status: response.ok ? "sent" : "error",
          statusCode: response.status,
          url,
        };
      } catch (err) {
        clearTimeout(timer);
        throw new Error(
          `Webhook POST to ${url} failed: ${err instanceof Error ? err.message : "unknown"}`
        );
      }
    }

    case "notification": {
      // Accepts: config.title + config.body (or config.message as body fallback)
      // Optional: config.entityId (person/entity to link to — stored as sourceId)
      //           config.category ('governance'|'data'|'ai'|'system'|'inbox') — default 'ai'
      //           config.priority ('low'|'normal'|'high'|'urgent') — default 'normal'
      //           config.groupKey — for collapsing similar notifications in the bell panel
      const body = (config.body ?? config.message) as string | undefined;
      const title = (config.title ?? "Automation notification") as string;
      const category = (config.category ?? "ai") as string;
      const priority = (config.priority ?? "normal") as string;
      const entityId = config.entityId as string | undefined;
      const groupKey =
        (config.groupKey as string | undefined) ??
        (entityId
          ? `automation.${automationContext.automationId}.${entityId}`
          : undefined);

      if (!body) {
        logger.warn(
          { workspaceId },
          "notification output missing body/message"
        );
        return { status: "skipped" };
      }

      // Deterministic id (Wave 4.R) so a crash-redelivered run re-inserts the
      // same notification and conflicts on the PK instead of duplicating it.
      await db
        .insert(notifications)
        .values({
          id: outputIdemId("notification") ?? randomUUID(),
          workspaceId,
          userId: ownerId,
          type: "automation.notification",
          title,
          body,
          category: category as any,
          priority: priority as any,
          status: "unread",
          sourceType: "automation",
          // entityId takes priority as sourceId so frontend can deep-link to the entity
          sourceId: entityId ?? automationContext.automationId,
          ...(groupKey ? { groupKey } : {}),
        })
        .onConflictDoNothing({ target: notifications.id });

      return { status: "sent", title, body };
    }

    case "channel_message": {
      // The output channel is CONTEXT-DERIVED, resolved in this precedence:
      //   (a) explicit `config.channelId` → use it, but ONLY after re-validating
      //       it is reachable from the automation's OWN workspace at RUN time
      //       (see the scope check below).
      //   (b) `config.channelEntityRef` (a template expr deep-resolved above to an
      //       ENTITY ID) → the find-or-create INTERNAL channel bound to that entity
      //       (ensureEntityChannel EXCLUDES the external client-comms surface —
      //       "the internal team channel for this entity", never the client↔us one).
      //   (c) `config.channelType`:
      //         'personal_thread' → user's personal thread (channelType=PERSONAL)
      //         'proactive'       → user's feed channel (channelType='feed', feedScope='user')
      //         'subjectEntity'   → THIS run's subject's own channel (== channelEntityRef
      //                             of the run's subjectEntityId; per-client recap spine)
      //   (d) DEFAULT (none of the above) → the automation's own run/session channel
      //       (ensureAutomationRunChannel) — a targetless channel_message NEVER errors.
      // CONFUSED-DEPUTY GUARD (S2): posts agent-influenced content into a channel
      // under the OWNER's identity (and may mirror to an external surface e.g.
      // Discord). On the observations/governed-event path a human-owned automation
      // runs THEN-nodes under owner-bypass, so an agent-produced trigger could relay
      // prompt-injected content into a team/feed channel ungoverned. Fail closed
      // before resolving the destination or emitting.
      const channelMsgGuard = await guardProducerEffect({
        producerAgentUserId,
        principalUserId: ownerId,
        workspaceId,
        subjectType: "channel_message",
        action: "send",
      });
      if ("block" in channelMsgGuard) {
        throw new Error(
          channelMsgGuard.kind === "deny"
            ? `channel_message denied by producer-agent governance (confused-deputy guard): ${channelMsgGuard.reason ?? "denied"}`
            : `channel_message cannot auto-execute: an agent produced this trigger, so a human-owned automation may not post to a channel under the owner's identity ungoverned (confused-deputy guard).`
        );
      }

      let channelId = config.channelId as string | undefined;
      const content = config.content as string;
      const metadata = (config.metadata ?? {}) as Record<string, unknown>;

      if (!content) {
        throw new Error("channel_message requires content");
      }

      // (a) SCOPE RE-VALIDATION — the security boundary for the ONLY branch that
      // takes a caller-supplied destination verbatim. Every other branch derives
      // the channel from run context through a ChannelRepository resolver, and
      // `channelEntityRef` already proves its entity is in scope before
      // resolving; an explicit `config.channelId` skipped ALL of that and the
      // sink (`insertChannelMessage`) is a bare insert with no visibility check,
      // so a definition naming an arbitrary channel uuid posted into it at run
      // time under the owner's identity — surviving lens changes, workspace
      // moves and membership revocation, because nothing re-checked.
      //
      // The predicate is the WRITE twin of the `messages_query` READ check
      // (`executeMessagesQueryStep`): the channel must live in the automation's
      // own workspace or be pod-wide. POD-WIDE AUTOMATION (`workspaceId` null at
      // run time — the cron scheduler dispatches `automation.workspaceId`
      // verbatim, which the payload type under-declares as `string`) names no
      // workspace, so NULL must NOT mean "anything goes": it is restricted to
      // pod-wide channels only. Such a flow reaches a workspace channel via the
      // context-derived paths (`channelEntityRef` / `channelType`), which
      // resolve against the run's own scope.
      //
      // FAIL LOUD rather than falling through to the run channel: a destination
      // the author cannot legitimately reach is a wiring fault, not a transient,
      // and silently redirecting the content to a different channel would hide
      // the misconfiguration while still delivering the payload somewhere the
      // author did not name. This matches the two sibling cross-workspace
      // guards in this file (`messages_query`, `session_update`), which both
      // throw. The "targetless channel_message NEVER errors" contract is
      // untouched — it is about the absence of a target, not an out-of-scope one.
      if (channelId) {
        const inScopeChannel = await db.query.channels.findFirst({
          where: and(
            eq(channels.id, channelId),
            workspaceId
              ? or(
                  eq(channels.workspaceId, workspaceId),
                  isNull(channels.workspaceId)
                )
              : isNull(channels.workspaceId)
          ),
          columns: { id: true },
        });
        if (!inScopeChannel) {
          throw new Error(
            `channel_message: channel ${channelId} is not reachable from ${
              workspaceId
                ? `workspace ${workspaceId}`
                : "this pod-wide automation (pod-wide automations may only target pod-wide channels; use channelEntityRef or channelType instead)"
            } — refusing to post. Re-select the destination channel on this automation.`
          );
        }
      }

      // (b) CONTEXT-DERIVED override: an entity ref (deep-resolved above to a
      // native id — so an exact `{{...}}` placeholder resolved to an entity id
      // works) routes into that entity's INTERNAL channel. Same resolver the
      // 'subjectEntity' channelType uses below — reuse-first, THREAD-on-create,
      // never client-comms.
      if (!channelId && config.channelEntityRef != null) {
        const entityId =
          typeof config.channelEntityRef === "string"
            ? config.channelEntityRef.trim()
            : "";
        // A channelEntityRef that did NOT resolve to a real entity id — empty, an
        // unresolved `{{...}}` placeholder, or a stale/wrong id — must not dangle a
        // channel bound to a nonexistent entity, nor throw the whole run. It falls
        // through to the DEFAULT run channel (d) below, consistent with the
        // "targetless channel_message never errors" contract. We route to the
        // entity's channel ONLY when the entity actually exists in this scope.
        if (entityId) {
          const [entityRow] = await db
            .select({ id: entities.id })
            .from(entities)
            .where(
              and(
                eq(entities.id, entityId),
                or(
                  eq(entities.workspaceId, workspaceId),
                  isNull(entities.workspaceId)
                ),
                isNull(entities.deletedAt)
              )
            )
            .limit(1);
          if (entityRow) {
            channelId = (
              await new ChannelRepository(db).ensureEntityChannel(
                entityId,
                ownerId,
                workspaceId
              )
            ).id;
          }
          // else: unknown/unresolved ref → leave channelId unset so the default
          // run channel (d) receives the message rather than a dangling void.
        }
      }

      // Resolve personal thread / proactive feed via the canonical race-safe
      // ChannelRepository resolvers (dedup against the 0182 unique indexes) — not
      // hand-rolled findFirst+insert, which duped and diverged from the api side.
      if (!channelId && config.channelType === "personal_thread") {
        channelId = (
          await new ChannelRepository(db).ensureUserPersonalChannel(ownerId)
        ).id;
      }

      if (!channelId && config.channelType === "proactive") {
        channelId = (
          await new ChannelRepository(db).ensureProactiveFeedChannel(ownerId)
        ).id;
      }

      // Post into THIS run's subject's own channel — the write-twin of the
      // entity-bound read, via the same ChannelRepository resolver the executor's
      // per_entity routing uses (reuse-first, THREAD-on-create, never client-comms).
      if (!channelId && config.channelType === "subjectEntity") {
        if (!runSubjectEntityId) {
          throw new Error(
            "channel_message channelType:'subjectEntity' requires the run to have a subjectEntityId"
          );
        }
        channelId = (
          await new ChannelRepository(db).ensureEntityChannel(
            runSubjectEntityId,
            ownerId,
            workspaceId
          )
        ).id;
      }

      // (d) DEFAULT — no explicit target resolved: post to the automation's own
      // run/session channel (the auto-given per-automation feed — the SAME channel
      // post-run-summary routes to via ensureAutomationRunChannel). A targetless
      // channel_message lands here rather than throwing.
      if (!channelId) {
        channelId = (
          await new ChannelRepository(db).ensureAutomationRunChannel(
            automationContext.automationId,
            ownerId,
            workspaceId
          )
        ).id;
      }

      if (!channelId) {
        // Unreachable for a real run — ensureAutomationRunChannel always resolves
        // or creates. Keep a clear error rather than posting to nowhere.
        throw new Error(
          "channel_message could not resolve a target channel (no channelId/channelEntityRef/channelType, and no automation run channel)"
        );
      }

      // Tag proactive channel messages so the feed can identify their type
      // without needing to know which channel they came from.
      const proactiveType =
        config.channelType === "proactive"
          ? (metadata.proactiveType ?? config.proactiveType ?? "insight")
          : undefined;

      // ONE door (Wave 4.R): insertChannelMessage owns the canonical tamper-hash
      // (computeMessageHash(id, content)) AND the Discord mirror + firewall — no
      // hand-rolled insert. Pass a DETERMINISTIC id so a crash-redelivered run
      // re-inserts the same id and no-ops on the PK (the door's
      // onConflictDoNothing) instead of double-posting. The mirror is
      // BOT-authored (authorType default) so the firewall blocks it from any
      // client-comms channel (team/feed only) and no-ops on internal channels —
      // same behavior the previous explicit mirror had.
      const messageId = outputIdemId("channel_message") ?? randomUUID();
      const result = await insertChannelMessage({
        id: messageId,
        channelId,
        content,
        metadata: {
          automationMessage: true,
          ...(proactiveType ? { proactiveType, proactiveAi: true } : {}),
          ...metadata,
          ...automationContext,
        },
      });
      if (result.mirrored) {
        logger.info(
          { channelId },
          "automation channel_message mirrored to Discord"
        );
      }

      // Return the deterministic id we inserted (not the door's result, which is
      // undefined when the insert conflicted on a retry) so downstream steps get
      // a stable reference either way.
      return { status: "sent", messageId, channelId };
    }

    case "session_update": {
      // Drive a focus session from inside a flow: advance its stage, maintain a
      // grantStatus bag in metadata, or append an expected output. Resolve the
      // session by explicit id, else the active focus_session bound to the
      // subject entity. Governed by the SAME agent policy as entity_update.
      const sessionId = config.sessionId as string | undefined;
      const subjectEntityId = config.subjectEntityId as string | undefined;
      const currentStage = config.currentStage as string | undefined;
      const grantStatus = config.grantStatus as unknown;
      const addOutput = config.addOutput as
        { kind: string; label: string; icon?: string } | undefined;

      let session: typeof focusSessions.$inferSelect | undefined;
      if (sessionId) {
        session = await db.query.focusSessions.findFirst({
          where: eq(focusSessions.id, sessionId),
        });
      } else if (subjectEntityId) {
        session = await db.query.focusSessions.findFirst({
          where: and(
            eq(focusSessions.subjectEntityId, subjectEntityId),
            eq(focusSessions.status, "active")
          ),
          orderBy: [desc(focusSessions.startedAt)],
        });
      }

      if (!session) {
        return { status: "skipped", reason: "no matching session" };
      }

      // Cross-workspace guard: only mutate a session in the automation's
      // workspace (or a pod-wide NULL-workspace session). Mirrors the
      // playbook_run subject IDOR guard — the column has no FK.
      if (session.workspaceId && session.workspaceId !== workspaceId) {
        throw new Error(
          `session_update: session ${session.id} not visible in workspace ${workspaceId}`
        );
      }

      // Governed — same gate as entity_create / entity_update above.
      const gate = await checkAutomationWriteOrPropose({
        ownerId,
        workspaceId,
        subjectType: "focus_session",
        action: "update",
        data: { id: session.id, currentStage, grantStatus, addOutput },
        reasoning: "Automation proposed updating a focus session.",
        automationRunId: automationContext.automationRunId,
        correlationId: automationContext.rootRunId,
        sessionId: automationContext.focusSessionId,
        stepRunId: attribution?.stepRunId,
        nodeId: attribution?.nodeId,
        producerAgentUserId,
      });
      if ("denied" in gate) {
        throw new Error(`session_update denied by governance: ${gate.reason}`);
      }
      if ("proposed" in gate) {
        // SAFETY: a proposal was created — do NOT direct-write.
        return { status: "proposed", proposalId: gate.proposalId };
      }

      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };

      const stageChanged =
        currentStage !== undefined && currentStage !== session.currentStage;
      if (stageChanged) set.currentStage = currentStage;

      // grantStatus → shallow-merge into session.metadata under `grantStatus`.
      if (grantStatus !== undefined) {
        const existingMeta =
          (session.metadata as Record<string, unknown> | null) ?? {};
        set.metadata = { ...existingMeta, grantStatus };
      }

      // addOutput → append to expectedOutputs (status 'pending'); read-modify-write.
      if (addOutput) {
        const existingOutputs = Array.isArray(session.expectedOutputs)
          ? (session.expectedOutputs as Array<Record<string, unknown>>)
          : [];
        set.expectedOutputs = [
          ...existingOutputs,
          {
            kind: addOutput.kind,
            label: addOutput.label,
            ...(addOutput.icon ? { icon: addOutput.icon } : {}),
            status: "pending",
          },
        ];
      }

      await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, session.id));

      // Stage transition side-effect — mirror rest/focus-sessions.ts:503-524 so
      // automations can react (and filter on toStage). Only when stage changed.
      if (stageChanged) {
        emitSideEffects({
          subjectType: "focus_session",
          action: "stage_changed",
          subjectId: session.id,
          userId: ownerId,
          workspaceId: session.workspaceId,
          data: {
            sessionId: session.id,
            subjectId: session.subjectEntityId,
            playbookId: session.playbookId,
            fromStage: session.currentStage,
            toStage: currentStage,
            workspaceId: session.workspaceId,
            userId: ownerId,
          },
        }).catch((err) => {
          logger.warn(
            { err, sessionId: session.id },
            "session_update: stage_changed emit failed (non-fatal)"
          );
        });
      }

      // MIRROR: when the stage-advance actually APPLIED (direct write, not a
      // proposal) and this session drives a playbook for a subject entity, keep
      // that entity's enrollment step truthful so the funnel reflects the new
      // stage. Rides the already-authorized stage-advance — same actor, same
      // run — so it introduces no new governed-write surface. `currentStep` is
      // the string shape deriveStepKey() reads. Merge into existing step_state
      // via the jsonb `||` operator (drizzleSql, per backend rule). Best-effort:
      // a mirror failure must never fail the underlying stage-advance.
      if (stageChanged && session.playbookId && session.subjectEntityId) {
        try {
          await db
            .update(playbookEnrollments)
            .set({
              stepState: drizzleSql`${
                playbookEnrollments.stepState
              } || ${JSON.stringify({ currentStep: currentStage })}::jsonb`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(playbookEnrollments.playbookId, session.playbookId),
                eq(playbookEnrollments.entityId, session.subjectEntityId)
              )
            );
        } catch (err) {
          logger.warn(
            {
              err,
              playbookId: session.playbookId,
              entityId: session.subjectEntityId,
            },
            "session_update: enrollment step mirror failed (non-fatal)"
          );
        }
      }

      return {
        status: "updated",
        sessionId: session.id,
        ...(stageChanged ? { stageChanged: true, toStage: currentStage } : {}),
      };
    }

    case "set_state": {
      // Persist per-automation state (watermark/cursor). `config` is a merge
      // object (after template resolution) that is shallow-merged onto the
      // automations.state jsonb via `||`. Author-controlled (explicit node) —
      // NOT automatic. Templates in the config (e.g. {{steps.x.output.max}})
      // are already resolved above.
      //
      // CONCURRENCY: two overlapping runs of the same automation both do
      // `state || <their patch>`. The DB serializes the two UPDATEs, so the
      // second overwrites keys the first set to a different value (last-writer
      // wins per key). Keys the two runs don't share are both preserved. There
      // is no read-modify-write in app code — the merge is a single atomic SQL
      // statement — so no lost-update beyond that last-writer-per-key semantics.
      // Acceptable for watermark/cursor use (monotonic advance): design the
      // patch so the newest run carries the highest watermark.
      const automationId = context.automation.id;
      const patch = (config ?? {}) as Record<string, unknown>;

      const [updated] = await db
        .update(automations)
        .set({
          state: drizzleSql`${automations.state} || ${JSON.stringify(
            patch
          )}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, automationId))
        .returning({ state: automations.state });

      // Reflect the merge into the live run context so later nodes in THIS run
      // see the new value via {{automation.state.<key>}}.
      if (updated?.state) {
        context.automation.state = updated.state as Record<string, unknown>;
      }

      return { status: "state_set", keys: Object.keys(patch) };
    }

    // ── Kind + Facets / graph (Wave 4.V2) ─────────────────────────────────────
    // Declarative wrappers over the governed builtin verbs — the config becomes
    // the verb's params. Idempotency (safe under at-least-once redelivery):
    //   facet_attach   → entity_facet.attach → FacetRepository.attach conflicts on
    //     the (entity, profile, contextEntityId, workspace) unique index and
    //     returns the existing row — a re-run re-attaches nothing.
    //   facet_update   → entity_facet.update → property MERGE + status set; a
    //     re-run writes the same values (naturally idempotent).
    //   facet_detach   → entity_facet.detach → soft-delete; a re-run after the
    //     facet is gone is a no-op (slug-resolution returns none → noop).
    //   relation_create→ graph.link → relations.create → createLinks
    //     (onConflictDoNothing) — a re-run inserts no duplicate edge.
    case "facet_attach":
      // config: { entityId, facetSlug, properties?, workspaceId?, contextEntityId? }
      return dispatchOutputVerb(
        "entity_facet.attach",
        config,
        workspaceId,
        actingUserId,
        producerAgentUserId
      );

    case "facet_update":
      // config: { facetId | (entityId + facetSlug), status?, properties?, workspaceId? }
      return dispatchOutputVerb(
        "entity_facet.update",
        config,
        workspaceId,
        actingUserId,
        producerAgentUserId
      );

    case "facet_detach":
      // config: { facetId | (entityId + facetSlug) }
      return dispatchOutputVerb(
        "entity_facet.detach",
        config,
        workspaceId,
        actingUserId,
        producerAgentUserId
      );

    case "relation_create":
      // config: { fromEntityId, toEntityId, relationType }
      if (config.dedupe !== false) {
        const [existing] = await db
          .select({ id: relations.id })
          .from(relations)
          .where(
            and(
              eq(relations.sourceEntityId, config.fromEntityId as string),
              eq(relations.targetEntityId, config.toEntityId as string),
              eq(relations.type, config.relationType as string),
              or(
                eq(relations.workspaceId, workspaceId),
                isNull(relations.workspaceId)
              )
            )
          )
          .limit(1);
        if (existing)
          return {
            status: "skipped",
            reason: "duplicate",
            relationId: existing.id,
          };
      }
      return dispatchOutputVerb(
        "graph.link",
        config,
        workspaceId,
        actingUserId,
        producerAgentUserId
      );

    default:
      logger.warn({ outputType: data.outputType }, "Unknown output type");
      return { status: "unknown_output_type", outputType: data.outputType };
  }
}
