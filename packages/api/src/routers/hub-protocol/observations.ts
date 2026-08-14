/**
 * Hub Protocol — Observations Router
 *
 * The key-authenticated door for recording that SOMETHING HAPPENED in the
 * outside world: a commit landed, a build finished, a webhook arrived.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The only key-authenticated append door was `POST /api/hub/agent-runs`
 * (hub-protocol/rest/events.ts), and it is deliberately narrow: one fixed event
 * type, ownership pinned, for agent-run telemetry. There was no GENERAL way for
 * a CLI, a CI job or an external agent to record that something happened —
 * `trpc.events.log` is Kratos-cookie-only and `hubProtocolRouter` had no
 * events member.
 *
 * So such producers could only file a proposal, which is the wrong shape: a
 * proposal asks permission for something that has not happened yet, while an
 * observation reports something that already did. Approving a commit that is
 * already in git is ceremony, and at volume it buries the review queue.
 *
 * ── Observations are NOT commands ──────────────────────────────────────────
 * Mixing "this happened" with "do this" in one append-only stream is a known
 * anti-pattern (Dudycz's "passive-aggressive events"): subscribers start
 * treating an unauthorised report as an instruction. In this codebase that was
 * not theoretical — the materialization hook fires on ANY event type ending
 * `.validated` and executes it, which is how a logging endpoint became a
 * remote-shell.
 *
 * So the boundary is enforced in TWO ways, both required:
 *   1. `OBSERVATION_NAMESPACES` — a type must start with a registered
 *      namespace. A caller cannot invent `entity.*` or `workspace.*`.
 *   2. `RESERVED_PHASES` — a type may not end in a lifecycle phase. Even
 *      inside a legitimate namespace, `dev.commit.validated` is refused.
 * `handleMaterialize` independently requires an approved proposal, so even if
 * both checks were bypassed nothing would materialize. Three layers, on
 * purpose: this door is reachable by every agent key in the system.
 *
 * The allowlist is deliberately CODE, not config. It is a security boundary,
 * and a config-driven boundary can be widened by anyone who can write config —
 * which includes the agents this door is exposed to. Adding a namespace is one
 * line and a review.
 *
 * ── Attribution ────────────────────────────────────────────────────────────
 * Observations set `agentUserId` but NOT `isAgent`.
 *
 * `is_agent = true AND proposal_id IS NULL` is not merely a dashboard: it is
 * the population `countAgentWritesTodayUtc` counts against an agent's DAILY
 * WRITE CEILING. Stamping `isAgent` would burn an agent's governed-write budget
 * every time it recorded a commit — recording a fact would cost it the right to
 * act. So `isAgent` stays off.
 *
 * But `agentUserId` IS filled, because every governance predicate that matters
 * ANDs on `is_agent = true`; filling the id alone pollutes nothing while
 * keeping observations visible to the existing "what did this agent do?" reader
 * (`GET /api/hub/events?agentUserId=`). Leaving it NULL would have traded a
 * false-positive problem for a blind spot.
 */

import { createHash } from "crypto";

import { z } from "zod";

import { createSynapEvent } from "@synap-core/core";
import { getEventRepository } from "@synap/database";
import { getBoss } from "@synap/events";

import { router } from "../../trpc.js";
import { scopedProcedure } from "../../middleware/api-key-auth.js";
import { apiKeyService } from "../../services/api-keys.js";
import { resolveConfinedWorkspace } from "./confine-workspace.js";
import { getUserAccessibleWorkspaceIds } from "./rest/_shared.js";

/**
 * Stable namespace for observation subject refs. Any fixed UUID works; this one
 * must never change or previously-recorded subjects stop matching.
 */
const OBSERVATION_SUBJECT_NAMESPACE = "6f1e5b7a-3c2d-4e8f-9a0b-1d2c3e4f5a6b";

/**
 * Derive a deterministic UUID from an arbitrary subject reference.
 *
 * `SynapEvent.subjectId` is `z.string().uuid()` and `createSynapEvent` ends in
 * `SynapEventSchema.parse`, so a raw ref like `repo:backend` or a git SHA
 * THROWS. Observations are about things the pod may never have modelled, so
 * requiring a real entity UUID would defeat the point of the door.
 *
 * RFC-4122 v5 (SHA-1, name-based) gives the same UUID for the same ref forever,
 * so a subject stays queryable across batches and machines. The human-readable
 * original is preserved in `data.subjectRef` — never lose the real identifier.
 *
 * Implemented here rather than via the `uuid` package: that package only
 * resolves as a hoisted transitive dependency, which pnpm may stop providing.
 */
function deriveSubjectUuid(ref: string): string {
  const nsHex = OBSERVATION_SUBJECT_NAMESPACE.replace(/-/g, "");
  const nsBytes = Buffer.from(nsHex, "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([nsBytes, Buffer.from(ref, "utf8")]))
    .digest();

  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC-4122 variant

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Registered observation namespaces. A type MUST be `<namespace>.<rest>`.
 *
 * To add a producer: add its namespace here. Keep them coarse (one per
 * producing system), never per-event-type.
 */
export const OBSERVATION_NAMESPACES = [
  /** Local development tooling — commits, gate runs, deploys (`./dev`). */
  "dev",
  /** Continuous integration — workflow runs, build results. */
  "ci",
] as const;

/**
 * A caller may never assert a lifecycle phase. `.validated` is the one that
 * executes; the others are meaningless coming from a client and are refused
 * for the same reason.
 */
export const RESERVED_PHASES = [".validated", ".completed", ".failed"] as const;

/**
 * Strict shape: lowercase dot-separated segments, nothing else.
 *
 * This is enforced BEFORE the namespace and phase checks on purpose. Those two
 * are `startsWith`/`endsWith` tests, and any character the shape does not
 * forbid can defeat them: `"dev.commit.validated "` with a trailing space slips
 * past `endsWith(".validated")`, as does a trailing newline. Pinning the shape
 * first means the later checks see a canonical string and cannot be dodged by
 * padding, casing, empty segments or a trailing dot.
 */
const TYPE_SHAPE = /^[a-z0-9]+(?:\.[a-z0-9][a-z0-9_-]*)+$/;

const ObservationTypeSchema = z
  .string()
  .min(3)
  .max(128)
  .refine((t) => TYPE_SHAPE.test(t), {
    message:
      "observation type must be lowercase dot-separated segments " +
      "(e.g. dev.commit) — no whitespace, uppercase, empty segments or trailing dot",
  })
  .refine((t) => OBSERVATION_NAMESPACES.some((ns) => t.startsWith(`${ns}.`)), {
    message:
      `observation type must start with a registered namespace ` +
      `(${OBSERVATION_NAMESPACES.map((n) => `${n}.`).join(", ")})`,
  })
  .refine((t) => !RESERVED_PHASES.some((p) => t.endsWith(p)), {
    message:
      `observation type may not end in a lifecycle phase ` +
      `(${RESERVED_PHASES.join(", ")}) — an observation reports a fact, ` +
      `it never asserts an outcome`,
  });

/**
 * One recorded fact.
 *
 * `occurredAt` is separate from ingest time on purpose: a producer may batch
 * or replay (a CLI journal shipping a week of commits), and the timeline must
 * reflect when things HAPPENED, not when we heard about them.
 */
/**
 * `subjectType` values a caller may NEVER claim.
 *
 * The namespace allowlist constrains `type`, but several readers key off
 * `subjectType` alone and would treat a forged row as first-party signal:
 *   • `ai_decision` / `ai_correction` — `fetchWorkspaceRoutingThreshold`
 *     computes `corrections / decisions` and lowers the auto-routing confidence
 *     threshold as that ratio falls. Flooding uncorrected forged "decisions"
 *     pins the threshold to its FLOOR, i.e. an agent could loosen its own
 *     auto-apply gate. `fetchRoutingMemory` also mines these as few-shot
 *     examples, so forged rows become prompt content.
 *   • `focus_session` — the workflow-place feed selects on subjectType +
 *     subjectId with NO userId floor, so a forged row lands in ANOTHER user's
 *     feed on a team pod (an indirect prompt-injection path into whatever
 *     summarises it).
 *   • `entity` / `agentRun` — first-party domain and telemetry surfaces.
 *
 * An agent silently moving its own oversight metrics is precisely the loop
 * governance exists to close, so this is a floor, not a nicety.
 */
const RESERVED_SUBJECT_TYPES = new Set([
  "ai_decision",
  "ai_correction",
  "focus_session",
  "entity",
  "entity_facet",
  "agentRun",
  "agent_run",
  "proposal",
  "workspace",
  "command",
  "profile",
  "view",
  "relation",
  "user",
  "member",
  "apiKey",
]);

const ObservationSchema = z.object({
  type: ObservationTypeSchema,
  /**
   * What it is about. Free-form on the wire — an observation may reference
   * something the pod has never modelled (a repo, a build, a commit SHA). It is
   * hashed to a stable UUID for storage; the original is kept in
   * `data.subjectRef`.
   */
  subjectId: z.string().min(1).max(256),
  subjectType: z
    .string()
    .min(1)
    .max(64)
    .default("observation")
    .refine((t) => !RESERVED_SUBJECT_TYPES.has(t), {
      message:
        "subjectType is reserved for first-party domain events — an observation " +
        "may not claim one (it would be read as first-party signal)",
    }),
  data: z.record(z.string(), z.unknown()),
  occurredAt: z.coerce.date().optional(),
  correlationId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
});

export const observationsRouter = router({
  /**
   * Record one or more observations.
   *
   * Batched because the canonical producer is a journal being flushed — a CLI
   * that recorded events offline and is now catching up. Returns per-item
   * results rather than failing the batch, so one malformed row cannot strand
   * a producer's entire backlog.
   */
  append: scopedProcedure(["hub-protocol.write"])
    .input(
      z.object({
        // 200, not 500: this is a bulk-ingest door on an append-only
        // hypertable, and the per-call cap multiplies against the
        // request budget. See the `import` rate-limit class.
        observations: z.array(ObservationSchema).min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId as string;
      const agentUserId = ctx.agentUserId as string | undefined;
      const eventRepo = getEventRepository();

      // Workspace tagging is resolved ONCE, up front, and never taken from the
      // request unchecked:
      //   • a bound `service` key is confined to its own workspace — the rule in
      //     confine-workspace.ts is that confinement applies before a value
      //     reaches any write;
      //   • anything else must still be a workspace this user can actually see,
      //     or it is dropped rather than stamped.
      // Dropping (not rejecting) is deliberate: a mis-tagged workspace should
      // not cost a producer the FACT, which is the thing we promised never to
      // lose. It lands pod-wide instead, and says so.
      const accessible = new Set(await getUserAccessibleWorkspaceIds(userId));
      const resolveWorkspace = (requested?: string): string | undefined => {
        const confined = resolveConfinedWorkspace(
          ctx.keyType as string | undefined,
          ctx.keyWorkspaceId as string | undefined,
          requested ?? null
        );
        if (confined == null) return undefined;
        if (!accessible.has(confined)) return undefined;
        return confined;
      };

      // Results are aligned 1:1 with the input array, by INDEX. A caller
      // marking its journal as delivered must know exactly WHICH items landed:
      // returning only a count forces it to assume failures are trailing, and
      // a failure in the middle then marks the wrong entries as sent — silently
      // losing some and re-sending others.
      const results: Array<
        | { ok: true; index: number; id: string }
        | { ok: false; index: number; error: string }
      > = [];

      for (const [index, obs] of input.observations.entries()) {
        try {
          const workspaceId = resolveWorkspace(obs.workspaceId);
          const event = createSynapEvent({
            type: obs.type,
            userId,
            // Hashed, because SynapEvent.subjectId must be a UUID. The real ref
            // rides in data.subjectRef so nothing is lost.
            subjectId: UUID_RE.test(obs.subjectId)
              ? obs.subjectId
              : deriveSubjectUuid(obs.subjectId),
            subjectType: obs.subjectType,
            data: {
              ...obs.data,
              subjectRef: obs.subjectId,
              // When we HEARD about it, kept only when the producer told us when
              // it actually happened (the row `timestamp` is that occurrence
              // time). This lives in `data`, NOT `metadata`, because
              // `EventRepository.append` REPLACES the event's metadata with
              // `{version, requestId}` and silently drops everything else —
              // verified against a live pod, where a metadata field written here
              // came back null. `data` is the only caller-controlled payload
              // that survives.
              ...(obs.occurredAt
                ? { ingestedAt: new Date().toISOString() }
                : {}),
              // Kept for back-compat with readers that COALESCE the two; the
              // indexable column is set on append below.
              ...(workspaceId ? { workspaceId } : {}),
            },
            source: "api",
            correlationId: obs.correlationId,
            // Attribution WITHOUT `isAgent` — see the file header. Filling
            // `agentUserId` alone is safe: every governance predicate that
            // matters (including the daily-write-ceiling count) ANDs on
            // `is_agent = true`, so this pollutes no metric while keeping the
            // existing `GET /api/hub/events?agentUserId=` reader able to see
            // what an agent recorded.
            ...(agentUserId ? { agentUserId } : {}),
            // NOTE: no `metadata` — see the `ingestedAt` comment above.
            // `append` discards caller metadata, so writing any here would be a
            // field that reads back null. The type namespace already identifies
            // an observation; nothing else needs a marker.
          });

          const row = await eventRepo.append({
            ...event,
            // `occurredAt` must drive the ROW timestamp, not a metadata field.
            // Everything that orders, filters, partitions or expires an event
            // keys on `timestamp`; a metadata copy is read by nothing. Without
            // this, a CLI flushing a week of commits lands them all as "now" —
            // precisely the case this field exists for.
            ...(obs.occurredAt ? { timestamp: obs.occurredAt } : {}),
            // The real, indexable `workspace_id` column (0223). `createSynapEvent`
            // has no workspaceId parameter, which is why the canonical writer
            // (utils/audit-log.ts) also passes it separately here. Leaving it in
            // `data` only forces readers onto an unindexed JSONB fallback.
            workspaceId,
          });

          // ── UNIFIED TRIGGER HOP (additive) ────────────────────────────────
          // A recorded observation can now fire automations, exactly like a
          // governed event does via emitSideEffects' automation-trigger-match
          // reactor. Enqueue the SAME queue in the SAME payload shape — but with
          // `eventType = obs.type` (raw, e.g. "dev.commit"), which the matcher's
          // `matchPattern` already handles (dotted + trailing-wildcard:
          // "dev.commit" / "dev.*"). We deliberately do NOT route through
          // `emitSideEffects`: it would synthesize `<subjectType>.<action>.
          // completed` (the wrong eventType) and fire every unrelated reactor
          // (search-index, webhook-delivery, …) for a row that is not a
          // first-party domain event. The matcher's exactly-once
          // (automation_claims), owner-floor, cycle/depth guard and workspace
          // fan-out all apply unchanged (additive).
          //
          // RATE/VOLUME BOUND (Part C): consume a per-(producer, namespace)
          // token from the shared key rate limiter BEFORE enqueuing. The FACT is
          // already recorded above; only the trigger side-effect is gated, so a
          // noisy/malicious key floods neither the trigger queue nor the
          // proposals it would spawn — while never losing the fact. Bucketed on
          // the producing PRINCIPAL (agent user id if present, else the human)
          // × the coarse namespace, so varying the type suffix cannot bypass it.
          //
          // Best-effort: a boss / limiter error must never flip a RECORDED fact
          // to `ok:false`. The row exists; the trigger is a side-effect.
          try {
            const dot = obs.type.indexOf(".");
            const namespace = dot > 0 ? obs.type.slice(0, dot) : obs.type;
            const triggerProducer = agentUserId ?? userId;
            const withinTriggerBudget = apiKeyService.checkRateLimit(
              `obs-trigger:${triggerProducer}:${namespace}`,
              "observation-trigger"
            );
            if (withinTriggerBudget) {
              await getBoss().send("automation-trigger-match", {
                eventType: obs.type,
                subjectId: event.subjectId,
                userId,
                workspaceId: workspaceId ?? null,
                data: event.data,
                // The producing agent, so a fired automation's THEN-actions are
                // governed against it (proposal, never an ungoverned effect).
                // Null for a human producer → owner-only governance, unchanged.
                producerAgentUserId: agentUserId ?? null,
              });
            }
          } catch {
            // Trigger enqueue is a best-effort side-effect of a recorded fact.
          }

          results.push({ ok: true, index, id: row.id });
        } catch (err) {
          results.push({
            ok: false,
            index,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const recorded = results.filter((r) => r.ok);
      return {
        recorded: recorded.length,
        failed: results.length - recorded.length,
        results,
      };
    }),

  /** The namespaces this pod accepts — so a producer can check before shipping a batch. */
  namespaces: scopedProcedure(["hub-protocol.read"]).query(() => ({
    namespaces: [...OBSERVATION_NAMESPACES],
    reservedPhases: [...RESERVED_PHASES],
  })),
});
