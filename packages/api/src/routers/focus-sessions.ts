/**
 * Focus Sessions tRPC Router
 *
 * Goal-bound user work sessions — workflow-side, not data-side.
 * Uses `protectedProcedure` (Kratos session cookie) since sessions
 * span workspaces and are owned by the authenticated user.
 */

import { z } from "zod";
import { router, protectedProcedure } from "../trpc.js";
import { TRPCError } from "@trpc/server";
import {
  and,
  assertGrantScoped,
  capabilities,
  db,
  desc,
  drizzleSql,
  eq,
  focusSessions,
  vaultGrants,
} from "@synap/database";
import type { FocusSession } from "@synap/database/schema";
import {
  withParentSessionId,
  attachParentSessionIds,
} from "../services/focus-sessions/parent-lineage.js";
import {
  sessionListConditions,
  type SessionListQuery,
} from "../services/focus-sessions/session-list-conditions.js";
import { paginatedInput, buildPaginatedResponse } from "../utils/pagination.js";

import { createFocusSession } from "../services/focus-sessions/create-session.js";
import {
  sessionCriteriaSchema,
  sessionEvidenceSchema,
} from "../schemas/session-criteria.js";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
  titleSourcePatch,
  type SessionVerdict,
} from "@synap-core/types/focus-sessions";
import {
  isTerminalSessionStatus,
  SESSION_STATUSES,
  UPDATABLE_SESSION_STATUSES,
} from "../services/focus-sessions/session-statuses.js";
import { listSessionOutputs } from "../services/focus-sessions/session-outputs.js";
import {
  recordSessionArtifact,
  SESSION_ARTIFACT_KINDS,
} from "../services/focus-sessions/record-session-artifact.js";
import { isOutputRefVisible } from "../services/focus-sessions/assert-output-ref-visible.js";
import { delegateExpectedOutput } from "../services/focus-sessions/delegate-output.js";
import {
  blockExpectedOutput,
  unblockExpectedOutput,
  type BlockExpectedOutputResult,
} from "../services/focus-sessions/block-output.js";
import { BLOCKED_REASONS } from "@synap/playbooks";
import {
  attestExpectedOutput,
  type AttestExpectedOutputResult,
} from "../services/focus-sessions/satisfy-expected-output.js";
import { listOwedSlots } from "../services/focus-sessions/owed-outputs.js";
import { readSessionDocument } from "../services/session-document/upsert-section.js";

import {
  expectedOutputWireSchema,
  outputRefWireSchema,
  mergeExpectedOutputs,
} from "../services/focus-sessions/update-session.js";
import {
  addSessionBlocker,
  removeSessionBlocker,
  attachSessionEdges,
  type SessionEdges,
} from "../services/focus-sessions/session-blocked-by.js";
import {
  attachSessionOutputDependencies,
  type SessionOutputDependencies,
} from "../services/focus-sessions/session-output-edges.js";
import {
  acceptFromTriage,
  discardFromTriage,
  attachTriage,
  projectTriage,
  type TriageProjection,
} from "../services/focus-sessions/triage.js";
import {
  SESSION_KINDS,
  attachSessionKind,
  projectSessionKind,
  type SessionKind,
} from "../services/focus-sessions/session-kind.js";
import { spawnProjectFromSession } from "../services/focus-sessions/spawn-project.js";
import { revertConversion } from "../services/focus-sessions/session-conversion.js";
import { revertSession } from "../services/focus-sessions/revert-session.js";
import { assertWorkspaceWrite } from "../utils/workspace-write-access.js";
import { getDb } from "@synap/database";
import {
  getLinksFor,
  createLinks,
  getCapabilityMemberParts,
} from "../services/links/links-service.js";
import { userVisibleWhere } from "../utils/user-visible-where.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { emitSideEffects } from "@synap/events";
import { ScopeFilterShape, resolveScope } from "../utils/scope-filter.js";
import { requireUserId } from "../utils/user-scoped.js";
import { aiRateLimitMiddleware } from "../middleware/ai-rate-limit.js";
import {
  attachSessionParticipants,
  withSessionParticipants,
  type SessionParticipants,
} from "../services/focus-sessions/participants.js";

// ── Shared input fragment ──────────────────────────────────────────────────

// The ONE wire shape for a declared deliverable, imported rather than
// re-declared: a narrower local copy STRIPS the server-owned slot fields
// (`delegatedTo`, `returnedReason`, `satisfiedByProposalId`, …) out of any
// array a client echoes back, before `mergeExpectedOutputs` can carry them.
const expectedOutputItemSchema = expectedOutputWireSchema;

/**
 * The ONE error mapping for the slot-ownership doors — `blockOutput` and
 * `unblockOutput` answer the same four failures for the same reasons, so they
 * share one translation rather than two that can drift into two different
 * sentences about the same missing label.
 */
function slotOwnershipResult(
  result: BlockExpectedOutputResult | AttestExpectedOutputResult,
  input: { sessionId: string; expectedLabel: string }
) {
  switch (result.status) {
    case "not_found":
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `Focus session ${input.sessionId} not found`,
      });
    case "unknown_label":
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `This session declares no output labelled "${input.expectedLabel}"`,
      });
    case "already_done":
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `"${input.expectedLabel}" is already delivered`,
      });
    case "ref_unreachable":
      // Block only. The `default` below returns SUCCESS, so a refusal with no
      // case here would report `ok: true` while the pointer was dropped.
      throw new TRPCError({ code: "BAD_REQUEST", message: result.reason });
    case "not_owed_by_you":
      // Attestation only. A slot an AGENT still owes is not the human's to
      // close — and saying so out loud is the point: a bare 200 on an unchanged
      // row reads as "delivered" to whoever asked.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `"${input.expectedLabel}" is not blocked on you — an agent still owes it`,
      });
    case "retired":
      // Attestation only. The `default` below returns SUCCESS, so a refusal
      // that is not named here reports `ok: true` with an undefined label —
      // exactly the "guard works, report lies" shape. Every refusal gets a case.
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `"${input.expectedLabel}" was retired when its session was cancelled — there is nothing left to attest`,
      });
    default:
      return {
        ok: true as const,
        expectedLabel: result.expectedLabel,
        kind: result.kind,
      };
  }
}

// DERIVED from the ONE status vocabulary (`@synap-core/types/focus-sessions`),
// never hand-mirrored: a new `focus_sessions.status` value reaches this filter
// automatically instead of being silently unfilterable. `"all"` is a filter
// sentinel, not a stored state.
const statusFilterSchema = z
  .union([
    z.enum([...SESSION_STATUSES, "all"]),
    /**
     * A SET of statuses, because the alternative is narrowing AFTER the limit.
     *
     * ⚠️ MEASURED ON THE LIVE POD. Relay's Work tab shows the sessions that
     * still want you — the open four plus `stale` and `failed` — which this
     * filter could not express, so it asked for `"all"` and filtered on the
     * phone. The limit is applied HERE, before that filter: of 29 `work` rows,
     * the page of 20 carried 9 visible ones while 14 qualified, so FIVE
     * sessions that pass the rule never reached the device. Silently: no
     * error, no "load more", just a working list missing a third of itself.
     *
     * This is the same reasoning `sessionKindWhere` already states one file
     * over — "a page of runs must not consume the 50 slots a person's work
     * needs" — and it was never applied to the status axis.
     */
    z.array(z.enum(SESSION_STATUSES)).nonempty(),
  ])
  .default("all");

/**
 * Per-status recency windows: admit `stale` / `closed` rows whose last activity
 * (`coalesce(closedAt, updatedAt)`) is at or after the given instant, ORed with
 * `status`. A status already selected ignores its window. Shared by `list` and
 * `browse` so the two doors cannot interpret a window differently. See
 * `services/focus-sessions/session-status-filter.ts`.
 */
const statusSinceSchema = z
  .object({
    stale: z.string().datetime({ offset: true }).optional(),
    closed: z.string().datetime({ offset: true }).optional(),
  })
  .optional();

/** The states a client may write — the ONE list, shared with the Hub REST PATCH door. */
const updatableStatusSchema = z.enum(UPDATABLE_SESSION_STATUSES);

/**
 * WHICH SESSIONS. Orthogonal to `status`, which is the row's own lifecycle.
 *
 *   - `default` — the working list: everything EXCEPT sessions still waiting to
 *     be triaged. This is a deliberate behaviour change; an agent-opened session
 *     no longer appears in the working list until a person accepts it.
 *   - `triage`  — only those: agent/automation-originated, still open, not yet
 *     accepted (`services/focus-sessions/triage.ts` owns the predicate).
 *   - `all`     — the pre-triage behaviour, kept addressable so nothing has to
 *     union two calls to count everything.
 */
const sessionLensSchema = z
  .enum(["default", "triage", "all"])
  .default("default");

/**
 * WHICH POPULATION. Orthogonal to BOTH `status` (the row's own lifecycle) and
 * `lens` (accepted vs waiting-to-be-triaged): `services/focus-sessions/
 * session-kind.ts` owns the predicate. Default `work` — a person's session
 * surfaces are about work, so machine runs and agent-write receipts leave them.
 * That is a deliberate behaviour change at this HUMAN door; the agent-facing
 * Hub REST door defaults to `all`.
 */
const sessionKindFilterSchema = z
  .enum([...SESSION_KINDS, "all"])
  .default("work");

// ── Links sub-router (read-only) ───────────────────────────────────────────

const sessionLinksRouter = router({
  /**
   * Return all `links` edges where fromType='session' AND fromId=sessionId,
   * plus reverse edges where toType='session' AND toId=sessionId.
   *
   * Groups results by `linkType` so the frontend can render "tools used",
   * "skills used", "produced entities", "targets", etc. without reshaping.
   *
   * Scoping: reuses getLinksFor which applies userVisibleWhere (pod-wide OR
   * workspace the user belongs to). The session ownership check mirrors the
   * get procedure — we verify ownership before exposing the link graph.
   */
  bySession: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify session ownership before exposing its link graph.
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }

      const edges = await getLinksFor(ctx.userId, "session", input.sessionId);

      // Group by linkType for convenient frontend consumption.
      const grouped: Record<string, typeof edges> = {};
      for (const edge of edges) {
        const key = edge.linkType;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push(edge);
      }

      return { edges, grouped };
    }),
});

// ── Shared read body ─────────────────────────────────────────────────────────

/**
 * THE one query body for the focus-sessions read door. focus_sessions is
 * user-owned (`userId`), so the floor is `eq(userId)` — every door starts there.
 * The lenses then only NARROW within the user's own rows:
 *   - workspace lens: `null` → pod-personal (workspaceId IS NULL); `"<id>"` →
 *     that workspace; `string[]` (non-empty) → that SET; `undefined`/`[]` → no
 *     narrow (the floor — all the user's sessions across workspaces).
 *   - project lens: `"<id>"`/`string[]` narrows on the session's own projectId
 *     column (sessions carry projectId directly — a simple eq/inArray, NOT
 *     exposureLensWhere); `null`/`undefined`/`[]` → no narrow.
 * An empty array never narrows (never matches-zero); a lens can only restrict.
 */
/** `list`: newest-started first, capped. Unchanged ordering for its consumers. */
function queryUserSessions(query: SessionListQuery, limit: number) {
  return db
    .select()
    .from(focusSessions)
    .where(and(...sessionListConditions(query)))
    .orderBy(desc(focusSessions.startedAt))
    .limit(limit);
}

/**
 * The derived fields EVERY session list row carries — lineage, triage, kind and
 * participants — applied in one place so `list` and `browse` return the same row
 * shape. Written once when `browse` arrived: a projection added to one door and
 * not the other is how a field ends up "present on the wire, populated by
 * nobody" on half the surfaces.
 */
async function projectSessionRows(
  sessions: FocusSession[],
  userId: string | null | undefined
) {
  // Derived lineage for the whole page in ONE query (never N+1, never a
  // second store) — mirrors `synap_list_sessions` (mcp/handlers/session.ts).
  const withLineage = await attachParentSessionIds(sessions);
  // `triage` is projected onto EVERY row in EVERY lens (it is pure — no
  // query), so no consumer ever re-derives the predicate from origin +
  // metadata + status. That re-derivation is exactly how a second, drifting
  // copy of a rule gets written.
  const withTriage = attachTriage(withLineage);
  // `kind` rides along on EVERY row in EVERY lens, same contract as
  // `triage`: pure, no query, and the one place the predicate is decided.
  const withKind = attachSessionKind(withTriage);
  // WHO worked here — one shared derivation with `get` (see
  // `services/focus-sessions/participants.ts`), so a list row and a detail
  // page can never name different agents for the same session.
  //
  // UNCONDITIONAL, not behind a flag like `edges`. The cost is two indexed
  // reads for the whole page (`idx_proposals_session_id`, then one
  // `users` lookup that is SKIPPED when the page has no participants), and
  // the alternative is worse in kind rather than in degree: an opt-in flag
  // leaves the DEFAULT answer wrong, which is exactly why every consumer
  // reached past this door for the raw `agentIds` invite list instead. A
  // field present on the type and populated only under a flag nobody sets
  // is the "declared on the wire, populated by nobody" shape this codebase
  // keeps paying for. `triage`, `kind` and `parentSessionId` ride along the
  // same way and for the same reason.
  const withParticipants = await attachSessionParticipants(
    withKind,
    requireUserId(userId)
  );
  // The grade against the session's criteria — `verdict` present only on rows
  // that declare criteria. One batched read for the page (see
  // `attachSessionVerdicts`), same unconditional contract as participants.
  const { attachSessionVerdicts } =
    await import("../services/focus-sessions/evaluations/record.js");
  return attachSessionVerdicts(withParticipants);
}

// ── Router ─────────────────────────────────────────────────────────────────

/**
 * One row of `focusSessions.list`. The edge fields are OPTIONAL on the type
 * and PRESENT on the wire only under `edges: true` — see the note inside the
 * procedure for why this must be spelled out rather than inferred.
 */
type SessionListRow = FocusSession & { parentSessionId: string | null } & {
  triage: TriageProjection;
  kind: SessionKind;
} & SessionParticipants & { verdict?: SessionVerdict } & Partial<SessionEdges> &
  Partial<SessionOutputDependencies>;

/**
 * Merge `metadata.titleSource` into the row — never assign over metadata. A
 * human rename is stamped "human" so the background titler never overwrites
 * it; a CLEAR stamps "derived", handing the name back to it.
 */
export function titleSourceMetadataSql(source: "human" | "derived") {
  return drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || ${JSON.stringify(
    titleSourcePatch(source)
  )}::jsonb`;
}

export const focusSessionsRouter = router({
  links: sessionLinksRouter,
  /**
   * THE one door for focus sessions (collapses the old list/listAll split).
   *
   * Floor = `eq(userId)` (sessions are user-owned). No lens → ALL the user's
   * sessions across workspaces, INCLUDING project-only sessions (null
   * workspaceId). A workspace and/or project lens only NARROWS:
   *   - no `workspaceId` (and no active-ws header) → all my sessions
   *   - active-ws header / a `workspaceId` → that workspace's sessions
   *   - `workspaceId: null` → pod-personal (workspaceId IS NULL) sessions
   *   - `workspaceId: [a, b]` → those workspaces (union)
   *   - `projectId: "<id>"` / `[a, b]` → that project (across workspaces)
   * Most recent first.
   */
  list: protectedProcedure
    .input(
      z.object({
        workspaceId: ScopeFilterShape.workspaceId,
        projectId: ScopeFilterShape.projectId,
        status: statusFilterSchema,
        /**
         * Admit `stale` / `closed` rows by recency, ORed with `status`, in SQL.
         * Fetching them by status and filtering the window on the device let
         * long-concluded rows fill the page — measured on the live pod as 11
         * rendered of 19 qualifying. See `session-status-filter.ts`.
         */
        statusSince: statusSinceSchema,
        limit: z.number().int().min(1).max(50).default(20),
        /**
         * Also project the dependency edges for the page. TWO kinds, on the
         * one flag because a consumer drawing "what is this waiting on" needs
         * both or neither:
         *   - DECLARED — `blockedBy` / `unblocks`, the `blocked_by` edges.
         *   - DERIVED — `waitsOnOutputs` / `outputsWaitedOnBy`, from
         *     `targets` ∩ `produced` over the same entity
         *     (`session-output-edges.ts`). No edge type of its own.
         * Opt-in because most callers do not draw them, and it is a projection
         * on THIS door rather than a `graph` procedure of its own: a second
         * door would be a second shape to keep in lockstep.
         */
        edges: z.boolean().optional(),
        /** Which sessions — see `sessionLensSchema`. Default EXCLUDES triage. */
        lens: sessionLensSchema,
        /** Which population — see `sessionKindFilterSchema`. Default `work`. */
        kind: sessionKindFilterSchema,
        /**
         * Only sessions run FROM this playbook definition (the session's own
         * `playbookId` column). Pair with `kind: "run"` or `kind: "all"` — the
         * default `work` lens excludes playbook-linked sessions except the
         * `scheduled` ones (an appointment is a person's, see
         * `services/focus-sessions/session-kind.ts`), so `playbookId` alone
         * returns a playbook's pending appointments and nothing else.
         */
        playbookId: z.string().uuid().optional(),
        /**
         * Only sessions run FROM this automation definition
         * (`metadata.automationId`). Same pairing note as `playbookId`.
         */
        automationId: z.string().uuid().optional(),
      })
    )
    .query(async ({ ctx, input }): Promise<SessionListRow[]> => {
      // The explicit return type is LOAD-BEARING: with an inferred union of
      // `A[]` (no edges) and `(A & Edges)[]` (edges), TypeScript's subtype
      // reduction DROPS the wider member because arrays are covariant — so
      // `blockedBy`/`waitsOnOutputs` were erased from the api-types snapshot
      // and no typed client could see a dependency edge. Optional here means
      // "present when `edges: true`", which is the true contract.
      const scope = resolveScope(ctx, input);
      const sessions = await queryUserSessions(
        {
          userId: ctx.userId,
          scope,
          status: input.status,
          lens: input.lens,
          kind: input.kind,
          flow: {
            playbookId: input.playbookId,
            automationId: input.automationId,
          },
          statusSince: input.statusSince,
        },
        input.limit
      );
      const withParticipants = await projectSessionRows(sessions, ctx.userId);
      if (!input.edges) return withParticipants;
      // Second batch projection, ONE more links query for the whole page.
      const withEdges = await attachSessionEdges(withParticipants);
      // Third: the DERIVED output dependencies. Owner-floored explicitly —
      // unlike `blocked_by`, these edges have no single producer that floors
      // both ends, so the counterparty can belong to another user.
      return attachSessionOutputDependencies(withEdges, ctx.userId);
    }),
  /**
   * BROWSE — the full, searchable, paged session list behind "See all".
   *
   * `list` feeds home surfaces: newest-started first, capped at 50, returning a
   * bare array that browser's SessionsApp and PodHomeApp type their caches on.
   * A collection screen needs three things `list` cannot give without breaking
   * those consumers: text search, paging past the cap, and "is there more".
   * This door adds exactly those and reuses the SAME WHERE clause
   * (`sessionListConditions`) and the SAME row projection
   * (`projectSessionRows`), so the two cannot disagree about which sessions
   * match or what a row contains.
   *
   * Ordered by LAST ACTIVITY (`updatedAt`), not by start: a person scanning
   * everything wants what moved recently, and ordering by start is exactly how
   * a session begun long ago but closed today fell off `list`'s page. `id` is
   * the tie-break, so offset paging never repeats or skips a row between pages.
   *
   * Every filter — status, windows, kind, lens, search — is a WHERE clause
   * applied BEFORE the limit. Filtering a fetched page is the bug this codebase
   * has now shipped twice on this table.
   */
  browse: protectedProcedure
    .input(
      paginatedInput.extend({
        workspaceId: ScopeFilterShape.workspaceId,
        projectId: ScopeFilterShape.projectId,
        status: statusFilterSchema,
        statusSince: statusSinceSchema,
        lens: sessionLensSchema,
        kind: sessionKindFilterSchema,
        q: z.string().trim().max(200).optional(),
        limit: z.number().int().min(1).max(100).default(30),
      })
    )
    .query(async ({ ctx, input }) => {
      const scope = resolveScope(ctx, input);
      const rows = await db
        .select()
        .from(focusSessions)
        .where(
          and(
            ...sessionListConditions({
              userId: ctx.userId,
              scope,
              status: input.status,
              lens: input.lens,
              kind: input.kind,
              statusSince: input.statusSince,
              q: input.q,
            })
          )
        )
        .orderBy(desc(focusSessions.updatedAt), desc(focusSessions.id))
        // One extra row tells `buildPaginatedResponse` whether there is more.
        .limit(input.limit + 1)
        .offset(input.offset);
      const { items, pagination } = buildPaginatedResponse(rows, input);
      return {
        items: await projectSessionRows(items, ctx.userId),
        pagination,
      };
    }),

  /**
   * Declare that a session is blocked by another — `session --blocked_by-->
   * session`.
   *
   * There is NO `blocked` status to set: blocked-ness is derived from the
   * edges whose target is still open (see `session-blocked-by.ts`). Ownership
   * is floored on BOTH endpoints inside the producer, mirroring the spawn
   * door; a handle the caller does not own is reported, never thrown.
   */
  addBlocker: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        blockerSessionId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
        columns: { id: true },
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      // `addSessionBlocker` derives the edge's workspace from the blocked
      // session's own row — never pass one in.
      return addSessionBlocker({
        sessionId: input.sessionId,
        blockerSessionId: input.blockerSessionId,
        userId: ctx.userId,
      });
    }),

  /** Drop a `blocked_by` edge. Reports whether one was actually there. */
  removeBlocker: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        blockerSessionId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
        columns: { id: true },
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return removeSessionBlocker({
        sessionId: input.sessionId,
        blockerSessionId: input.blockerSessionId,
        userId: ctx.userId,
      });
    }),

  // ── Triage ───────────────────────────────────────────────────────────────
  // A session an agent or an automation opened is a SUGGESTION until a person
  // says otherwise. Two verbs, no stored status: acceptance is a receipt on
  // `metadata.triage`, discard routes to the existing terminal `cancelled`.

  /**
   * "Accept as ready" — take ownership of a triage session. Stamps
   * `metadata.triage.acceptedAt`/`acceptedBy`; changes NO status.
   *
   * Returns `{ accepted, session? , reason? }`. `reason: "not_pending"` means
   * the session was never in triage (or somebody accepted it first) — a fact,
   * not a fault, so it is not a 4xx.
   */
  acceptFromTriage: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await acceptFromTriage({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        }
        return { accepted: false as const, reason: result.reason };
      }
      return { accepted: true as const, session: result.session };
    }),

  /**
   * Discard a triage session — cancel it (nothing is deleted) and retire the
   * ephemeral proposals bound to work that is now not happening.
   *
   * Returns `{ discarded, session?, expiredEphemerals?, reason? }`.
   * `expiredEphemerals` is reported, never silent: a retirement the person does
   * not learn about is the lying-count defect wearing a different hat.
   */
  discardFromTriage: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await discardFromTriage({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        }
        return { discarded: false as const, reason: result.reason };
      }
      return {
        discarded: true as const,
        session: result.session,
        expiredEphemerals: result.expiredEphemerals,
      };
    }),

  // ── Conversions ──────────────────────────────────────────────────────────

  /**
   * Spawn a PROJECT from this session — the container half of the conversion
   * pair (promote → playbook is the other, and lives on `playbooks.promote`).
   *
   * Governance mirrors promote exactly: load by id, `assertWorkspaceWrite` on
   * the LOADED row's workspace, then `checkPermissionOrPropose` — a human caller
   * executes, an agent caller files a `project/spawn_from_session` proposal that
   * re-runs THIS procedure on approval.
   *
   * Returns `{ status, projectId, receipt, ... }`. The receipt carries
   * `created: {kind,id,name}`, `renamedFrom` and `undoUntil`; undo is
   * `focusSessions.revertConversion`.
   */
  spawnProject: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        name: z.string().min(1).max(255).optional(),
        description: z.string().max(4000).optional(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const database = await getDb();
      // Load by id + owner floor, gate on the LOADED row (never on a
      // request-supplied workspaceId).
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, requireUserId(ctx.userId))
        ),
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      await assertWorkspaceWrite(database, ctx.userId, {
        workspaceId: session.workspaceId,
      });

      const perm = await checkPermissionOrPropose({
        userId: requireUserId(ctx.userId),
        agentUserId: input.agentUserId,
        workspaceId: session.workspaceId ?? undefined,
        subjectType: "project",
        // Its OWN verb, not `create`: the two are materialized by different
        // executors (a raw create takes a name; this takes a sessionId and
        // carries the mapping + the rename + the lineage edge), and one
        // proposalType cannot materialize both. `requiredPermissionFor`
        // fail-closes an unknown verb to "write", so RBAC is identical to
        // create — only the apply key forks. Same split promote made.
        action: "spawn_from_session",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          sessionId: input.sessionId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          status: "proposed" as const,
          projectId: null as string | null,
          proposalId: perm.proposalId,
          receipt: null,
        };
      }

      const result = await spawnProjectFromSession({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
        name: input.name,
        description: input.description,
        agentUserId: input.agentUserId ?? null,
        door: "trpc",
      });
      if (result.status === "refused") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: result.message,
          cause: result.reason,
        });
      }
      return {
        status: "spawned" as const,
        projectId: result.projectId as string | null,
        proposalId: null as string | null,
        deduped: result.deduped,
        expectedOutputsCarried: result.expectedOutputsCarried,
        ...(result.subjectBound !== undefined
          ? { subjectBound: result.subjectBound }
          : {}),
        receipt: result.receipt,
      };
    }),

  /**
   * UNDO a conversion — the inverse verb, one door for both promote and spawn.
   *
   * Restores the session's goal, ARCHIVES the created playbook/project (never
   * deletes: an undo that destroys rows is a worse failure than one that hides
   * them) and drops the lineage edge. Refuses with a typed reason once the
   * window has passed or the created object has been used.
   */
  revert: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        reason: z.string().max(2000).optional(),
        /** Revert only these proposals of the session; omit for all of them. */
        proposalIds: z.array(z.string().uuid()).min(1).max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await revertSession({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
        reason: input.reason,
        proposalIds: input.proposalIds,
        callerContext: ctx,
      });
      if (!result.ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return {
        sessionId: result.sessionId,
        proposals: result.proposals,
        counts: result.counts,
      };
    }),

  /**
   * CANCEL a session (a run) — the ONE close door with `cancelled`: stops the
   * work still in flight where a real stop exists, and records what was
   * stopped, what will finish, and what already applied on
   * `metadata.run.cancel` (also returned as `cancel`). Undo what finished with
   * `revert`. A session already closed returns as it stands, with no `cancel`.
   */
  cancel: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        reason: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { cancelSession } =
        await import("../services/focus-sessions/cancel-session.js");
      const result = await cancelSession({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
        reason: input.reason,
      });
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return {
        status: result.session.status,
        session: result.session,
        cancel: result.cancel ?? null,
        alreadyClosed: result.cancel === undefined,
        counts: result.counts,
        warnings: result.warnings,
      };
    }),

  /**
   * RERUN a session (a run) — a NEW session `spawned_from` this one that
   * re-analyses its stored sources with the current guidelines. `replace`
   * reverts this session's applied work first (skips listed); `add` runs on
   * top. `dryRun` answers the counts + cap verdict and writes nothing. A
   * refusal (still open, over cap, no stored sources…) comes back as
   * `{ ok: false, reason, message }` for the run bar to show; only an unknown
   * session throws.
   */
  rerun: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        mode: z.enum(["replace", "add"]),
        scope: z
          .object({
            sourceDocumentIds: z.array(z.string().uuid()).min(1).max(500),
          })
          .optional(),
        dryRun: z.boolean().optional(),
        reason: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { rerunSession } =
        await import("../services/focus-sessions/rerun-session.js");
      const result = await rerunSession({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
        mode: input.mode,
        scope: input.scope,
        dryRun: input.dryRun,
        reason: input.reason,
        agentUserId: ctx.agentUserId ?? null,
        callerContext: ctx,
      });
      if (!result.ok && result.reason === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: result.message });
      }
      return result;
    }),

  /**
   * A run's stored sources ("What came in") — the rows the rerun plan counts,
   * so a room can select some and pass their ids to `rerun({ scope })`.
   * Owner-floored; a failed read throws (never an empty list).
   */
  runSources: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { listRunSources } =
        await import("../services/focus-sessions/run-sources.js");
      const result = await listRunSources({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return result;
    }),

  /**
   * STRUCTURE AGAIN — run an entity's text (title + preview + content) through
   * the capture door as a NEW intake run whose subject is that entity. The
   * source is kept on the run before structuring, so Rerun works from there.
   * Returns the run's `sessionId` for the host to open its room. A refusal
   * (no text, source not kept…) RETURNS `{ ok: false, reason, message }`; only
   * an entity the caller cannot read throws.
   */
  structureAgain: protectedProcedure
    .use(aiRateLimitMiddleware)
    .input(z.object({ entityId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { structureAgain } =
        await import("../services/intake/structure-again.js");
      const result = await structureAgain({
        entityId: input.entityId,
        userId: requireUserId(ctx.userId),
        agentUserId: ctx.agentUserId ?? null,
        callerContext: ctx,
      });
      if (!result.ok && result.reason === "not_found") {
        throw new TRPCError({ code: "NOT_FOUND", message: result.message });
      }
      return result;
    }),

  revertConversion: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await revertConversion({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      });
      if (!result.ok) {
        if (result.reason === "not_found") {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        }
        return { reverted: false as const, reason: result.reason };
      }
      return {
        reverted: true as const,
        goal: result.goal,
        retired: result.retired,
      };
    }),

  /**
   * Get a single focus session by ID.
   * Scoped to the authenticated user — cannot read another user's session.
   *
   * Returns `participants` — everyone STAFFED on this session, unioned from the
   * declared and the derived store. The derivation lives in
   * `services/focus-sessions/participants.ts` and is SHARED with `list`, which
   * is the whole reason it is no longer inline here: a detail page and a list
   * row must never name different agents for the same session.
   */
  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.id),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.id} not found`,
        });
      }

      // Derived detour lineage (see `services/focus-sessions/parent-lineage.ts`)
      // — mirrors `synap_get_session` (mcp/handlers/session.ts) so the two
      // doors can never disagree.
      // Same projection the list door attaches (pure, no query) so a detail
      // page never re-derives triage-pending from origin + metadata + status.
      const staffed = await withSessionParticipants(
        row,
        requireUserId(ctx.userId)
      );
      // The continuation packet (`continuation-packet.ts`) — the SAME projection
      // MCP `synap_get_session` and Hub `GET /focus-sessions/:id` return. It
      // carries the rerun door's OWN rule (`assessRerunAvailability`), so
      // `rerun` is read from it rather than computed a second time.
      const { projectContinuationPacket } =
        await import("../services/focus-sessions/continuation-packet.js");
      const continuation = await projectContinuationPacket(row, {
        database: db,
        userId: requireUserId(ctx.userId),
      });
      return withParentSessionId({
        ...staffed,
        triage: projectTriage(row),
        kind: projectSessionKind(row),
        rerun: continuation.rerun,
        continuation,
        // The contract + grade, lifted from the packet so a detail page reads
        // them off the session: normalized criteria, the verdict, and the
        // CURRENT evaluation per criterion. Absent when the read failed —
        // `continuation.evaluation` then says so.
        ...(continuation.evaluation.status === "ok"
          ? {
              criteria: continuation.evaluation.criteria,
              verdict: continuation.evaluation.verdict,
              evaluations: continuation.evaluation.evaluations,
            }
          : {}),
      });
    }),

  /**
   * A session's criteria, its verdict, the CURRENT evaluation per criterion
   * (human wins) and the full append-only `history` of attempts.
   */
  evaluations: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, userId)
        ),
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      const { listSessionEvaluations, summarizeEvaluations } =
        await import("../services/focus-sessions/evaluations/record.js");
      const history = await listSessionEvaluations({
        sessionId: row.id,
        userId,
      });
      return { ...summarizeEvaluations(row.criteria, history), history };
    }),

  /**
   * Run the session's pending criteria (evidence → capability → judge). The
   * evaluation never blocks anything by itself; a check-gated pause resumes
   * when the left stage's required criteria now pass (`resumed`).
   */
  evaluate: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        evidence: sessionEvidenceSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { evaluateSession } =
        await import("../services/focus-sessions/evaluations/evaluate.js");
      const result = await evaluateSession({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
        evidence: input.evidence,
      });
      if (result.status === "not_found") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return result;
    }),

  /**
   * The OWNER's verdict on one criterion — final, and it overrides every
   * evidence / capability / judge row. Discharges the criterion's escalation
   * slot when one was filed, and resumes a check-gated pause it clears.
   */
  grade: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        criterionKey: z.string().min(1).max(80),
        verdict: z.enum(["pass", "fail"]),
        rationale: z.string().max(2000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = requireUserId(ctx.userId);
      const { recordSessionEvaluation, loadSessionEvaluationSummary } =
        await import("../services/focus-sessions/evaluations/record.js");
      const { resumeCheckGateIfMet } =
        await import("../services/focus-sessions/evaluations/evaluate.js");
      const out = await recordSessionEvaluation({
        sessionId: input.sessionId,
        userId,
        criterionKey: input.criterionKey,
        verdict: input.verdict,
        evaluatorKind: "human",
        rationale: input.rationale ?? null,
      });
      if (out.status === "not_found" || out.status === "unknown_criterion") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message:
            out.status === "not_found"
              ? `Focus session ${input.sessionId} not found`
              : `No criterion "${input.criterionKey}" on this session`,
        });
      }
      if (out.status !== "recorded") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "reason" in out ? out.reason : out.status,
        });
      }
      const resumed = await resumeCheckGateIfMet({
        sessionId: input.sessionId,
        userId,
      });
      const row = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, input.sessionId),
      });
      const summary = row ? await loadSessionEvaluationSummary(row) : undefined;
      return { evaluation: out.evaluation, resumed, ...summary };
    }),

  /**
   * Get a focus session by IS correlation ID.
   * Used by IS to link proposals and events back to the session.
   */
  getByCorrelationId: protectedProcedure
    .input(z.object({ correlationId: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.correlationId, input.correlationId),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No focus session found for correlationId ${input.correlationId}`,
        });
      }

      return row;
    }),

  /**
   * Create a new focus session.
   */
  create: protectedProcedure
    .input(
      z.object({
        // A session can start on the personal floor. Space and project are
        // optional associations, not a required parent hierarchy.
        workspaceId: z.string().nullish(),
        /** Short one-line NAME; `goal` is the outcome. Blank ⇒ untitled. */
        title: z.string().max(SESSION_TITLE_MAX).nullish(),
        goal: z.string().min(1).max(2000),
        /**
         * The PARENT — this session is its child (a detour or a planned
         * sub-session). The parent stays open and lists its children. A miss
         * is reported on `parentLink`, never silently dropped.
         */
        parentSessionId: z.string().uuid().optional(),
        /** Sessions this one waits on — `blocked_by` edges, reported per id. */
        blockedBySessionIds: z.array(z.string().uuid()).max(20).optional(),
        templateId: z.string().optional(),
        expectedOutputs: z.array(expectedOutputItemSchema).default([]),
        channelId: z.string().uuid().optional(),
        agentIds: z.array(z.string()).default([]),
        // Optional project association. The active work context stays
        // independent from this persisted association.
        projectId: z.string().uuid().nullish(),
        /**
         * The entity this session is ABOUT — the subject-spine anchor. The
         * service has always accepted it; this door did not declare it, so
         * every browser-started session landed subject-less and the room's
         * Subject row could only ever read "No subject". Floored below through
         * the SAME predicate the output doors use.
         */
        subjectEntityId: z.string().uuid().nullable().optional(),
        /**
         * Open a NEW session even when an open session of the same goal and
         * scope exists. Without it the door returns that session, marked
         * `deduped: true`.
         */
        forceCreate: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // The subject must be an entity the caller can ALREADY see. Same floor,
      // same door (`isOutputRefVisible`) as an output's ref, and for the same
      // reason: the room resolves the subject's live title by bare id, so an
      // unfloored write would be a read oracle over every entity in the pod.
      if (input.subjectEntityId) {
        const visible = await isOutputRefVisible({
          userId: ctx.userId,
          kind: "entity",
          refId: input.subjectEntityId,
        });
        if (!visible) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `No entity ${input.subjectEntityId} you can access`,
          });
        }
      }
      // ONE create door (`createFocusSession`): the bare insert this replaced
      // stamped every human-started session `origin: "agent"`, which is the
      // exact mislabel the triage lens keys on. The service derives origin
      // from the caller (no agentUserId here ⇒ "human") and runs the same
      // membership membrane every other start door runs.
      const result = await createFocusSession({
        userId: ctx.userId,
        workspaceId: input.workspaceId ?? null,
        projectId: input.projectId ?? null,
        subjectEntityId: input.subjectEntityId ?? null,
        title: input.title ?? null,
        goal: input.goal,
        templateId: input.templateId ?? null,
        expectedOutputs: input.expectedOutputs,
        channelId: input.channelId ?? null,
        agentIds: input.agentIds,
        parentSessionId: input.parentSessionId ?? null,
        blockedBySessionIds: input.blockedBySessionIds ?? [],
        forceCreate: input.forceCreate,
      });
      if (result.status === "proposed") {
        throw new TRPCError({ code: "FORBIDDEN", message: result.message });
      }
      if (result.status === "deduped") {
        // The EXISTING session — flagged, never silent. The row's own `status`
        // is the session's lifecycle, so reuse rides as `deduped: true`.
        // NO `template` here, on purpose: nothing was created, so no matching
        // ran; carrying a report would claim an application that never
        // happened. `CreateFocusSessionResult`'s deduped arm has none either.
        return {
          ...(result.session as FocusSession),
          deduped: true as const,
          ...(result.candidates.length > 0
            ? { dedupCandidates: result.candidates }
            : {}),
        };
      }
      // Edge outcomes ride the returned row, only when they were asked for.
      // `template` + `adopted` are the SAME blocks the MCP and Hub start doors
      // already return: what matched, what else fit, why nothing applied, and
      // whether an auto-opened session was adopted instead of a row created.
      // This door used to drop both, so a browser-started session could never
      // say which template ran. The shape comes from `CreateFocusSessionResult`
      // and is never restated here.
      return {
        ...(result.candidates ? { dedupCandidates: result.candidates } : {}),
        ...(result.session as FocusSession),
        ...(result.parentLink ? { parentLink: result.parentLink } : {}),
        ...(result.blockerLinks ? { blockerLinks: result.blockerLinks } : {}),
        ...(result.template ? { template: result.template } : {}),
        ...(result.adopted ? { adopted: result.adopted } : {}),
      };
    }),

  /**
   * APPEND one agent to the session's roster.
   *
   * Separate from `update` on purpose. `update.agentIds` REPLACES the array —
   * the only shape the column ever had, and the reason nothing could staff a
   * session already in flight without first re-reading and re-sending the whole
   * list (a lost-update race between any two callers). This door appends, is
   * idempotent, and is the ONE writer that may do so; see
   * `services/focus-sessions/attach-session-agent.ts`.
   */
  attachAgent: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        agentId: z.string().min(1),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { attachSessionAgent } =
        await import("../services/focus-sessions/attach-session-agent.js");
      const result = await attachSessionAgent({
        sessionId: input.id,
        agentId: input.agentId,
        userId: ctx.userId,
      });
      if (result.status === "not_found") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.id} not found`,
        });
      }
      return { agentIds: result.agentIds, added: result.added };
    }),

  /**
   * Update an existing focus session.
   * Caller must own the session (userId check).
   */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        status: updatableStatusSchema.optional(),
        progress: z.number().int().min(0).max(100).optional(),
        channelId: z.string().uuid().optional(),
        correlationId: z.string().optional(),
        /** Rename; `null` or blank CLEARS (untitled). */
        title: z.string().max(SESSION_TITLE_MAX).nullable().optional(),
        goal: z.string().min(1).max(2000).optional(),
        agentIds: z.array(z.string()).optional(),
        expectedOutputs: z.array(expectedOutputItemSchema).optional(),
        // First-class stages: advance the active playbook stage (PlaybookStage.key).
        currentStage: z.string().min(1).optional(),
        /**
         * Re-point (or CLEAR, with an explicit `null`) the entity this session
         * is about. Omitted leaves the anchor alone; `null` is the un-set.
         */
        subjectEntityId: z.string().uuid().nullable().optional(),
        /** WHOLESALE replace of the session's binary acceptance criteria. */
        criteria: sessionCriteriaSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // VISIBILITY FLOOR before the load, same predicate and same refusal as
      // the create door above. `null` clears and names nothing, so it skips.
      if (input.subjectEntityId) {
        const visible = await isOutputRefVisible({
          userId: ctx.userId,
          kind: "entity",
          refId: input.subjectEntityId,
        });
        if (!visible) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `No entity ${input.subjectEntityId} you can access`,
          });
        }
      }

      // Load first to verify ownership
      const existing = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.id),
          eq(focusSessions.userId, ctx.userId)
        ),
      });

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.id} not found`,
        });
      }

      const { id: _id, ...patch } = input;

      // Build only the fields that were supplied
      const set: Partial<typeof focusSessions.$inferInsert> = {
        updatedAt: new Date(),
      };

      if (patch.status !== undefined) set.status = patch.status;
      if (patch.progress !== undefined) set.progress = patch.progress;
      if (patch.channelId !== undefined) set.channelId = patch.channelId;
      if (patch.correlationId !== undefined)
        set.correlationId = patch.correlationId;
      if (patch.goal !== undefined) set.goal = patch.goal;
      if (patch.title !== undefined) {
        set.title = normalizeSessionTitle(patch.title);
        set.metadata = titleSourceMetadataSql(set.title ? "human" : "derived");
      }
      if (patch.agentIds !== undefined) set.agentIds = patch.agentIds;
      // Merge, never assign: the surfaces that patch this list read it, edit
      // one slot, and send the whole array back — so a wholesale assignment
      // erased every server-owned field (`delegatedTo`, `returnedReason`, the
      // `satisfiedByProposalId` lineage) the client did not echo. ONE merge,
      // shared with the MCP + Hub REST doors (`mergeExpectedOutputs`), so the
      // three cannot disagree about what a patch destroys.
      if (patch.expectedOutputs !== undefined)
        set.expectedOutputs = mergeExpectedOutputs(
          (existing.expectedOutputs as typeof patch.expectedOutputs) ?? [],
          patch.expectedOutputs
        );
      if (patch.currentStage !== undefined)
        set.currentStage = patch.currentStage;
      // `undefined` leaves the anchor; `null` is the CLEAR. Assigned rather
      // than `?? existing` so "no subject" is expressible at all.
      if (patch.subjectEntityId !== undefined)
        set.subjectEntityId = patch.subjectEntityId;
      if (patch.criteria !== undefined) set.criteria = patch.criteria;

      // Any terminal status via update funnels through completeFocusSession —
      // the ONE close door (pack + run close + ephemeral expiry + close event).
      // A bare `status: "cancelled"` write used to skip all four.
      if (
        isTerminalSessionStatus(patch.status) &&
        !isTerminalSessionStatus(existing.status)
      ) {
        const { completeFocusSession } =
          await import("../services/focus-sessions/complete-session.js");
        try {
          const result = await completeFocusSession({
            sessionId: input.id,
            userId: ctx.userId,
            terminalStatus: patch.status,
          });
          if (!result) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: `Focus session ${input.id} not found`,
            });
          }
          // Apply any non-status fields still in the patch onto the closed row.
          const extra: Partial<typeof focusSessions.$inferInsert> = {
            updatedAt: new Date(),
          };
          if (patch.progress !== undefined) extra.progress = patch.progress;
          if (patch.goal !== undefined) extra.goal = patch.goal;
          if (patch.title !== undefined) {
            extra.title = normalizeSessionTitle(patch.title);
            extra.metadata = titleSourceMetadataSql(
              extra.title ? "human" : "derived"
            );
          }
          if (patch.subjectEntityId !== undefined)
            extra.subjectEntityId = patch.subjectEntityId;
          if (patch.expectedOutputs !== undefined)
            extra.expectedOutputs = mergeExpectedOutputs(
              (existing.expectedOutputs as typeof patch.expectedOutputs) ?? [],
              patch.expectedOutputs
            );
          if (Object.keys(extra).length > 1) {
            const [merged] = await db
              .update(focusSessions)
              .set(extra)
              .where(eq(focusSessions.id, input.id))
              .returning();
            return (merged ?? result.session) as FocusSession;
          }
          return result.session as FocusSession;
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code === "FORBIDDEN") {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: e.message ?? "Session completion not allowed",
            });
          }
          throw err;
        }
      }

      const [updated] = await db
        .update(focusSessions)
        .set(set)
        .where(eq(focusSessions.id, input.id))
        .returning();

      // ── STAGE ADVANCE ─────────────────────────────────────────────────────
      // ONE door owns the `stage_changed` fan-out AND the human stage gate
      // (`services/focus-sessions/advance-stage.ts`). This router used to carry
      // a hand-copy of the emit and NO gate at all, so a `gate: { kind: "human" }`
      // stage advanced from the browser walked straight through the approval it
      // was declared to require.
      //
      // `stageWrite: "caller"` — the stage was already written by the UPDATE above.
      let stageGated = false;
      if (patch.currentStage !== undefined) {
        const { advanceSessionStage } =
          await import("../services/focus-sessions/advance-stage.js");
        const advance = await advanceSessionStage({
          session: {
            id: updated.id,
            currentStage: existing.currentStage,
            workspaceId: existing.workspaceId,
            projectId: existing.projectId,
            channelId: existing.channelId,
            playbookId: existing.playbookId,
            subjectEntityId: existing.subjectEntityId,
          },
          toStage: patch.currentStage,
          userId: ctx.userId,
          stageWrite: "caller",
        });
        stageGated = advance.paused;
      }

      // Return the status the ROW now holds. A caller handed `active` while the
      // gate has just paused the session would step past the approval it opened.
      return (
        stageGated ? { ...updated, status: "paused" } : updated
      ) as FocusSession;
    }),

  /**
   * Complete a focus session (canonical close).
   * Delegates to completeFocusSession — pack + playbook_run + verification recap.
   * Prefer this over update({ status: "closed" }).
   */
  close: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        /** Short human recap — stored on verificationReport.summary */
        summary: z.string().max(4000).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { completeFocusSession } =
        await import("../services/focus-sessions/complete-session.js");
      try {
        const result = await completeFocusSession({
          sessionId: input.id,
          userId: ctx.userId,
          summary: input.summary,
        });
        if (!result) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.id} not found`,
          });
        }
        // `verdict` rides alongside the row exactly as the MCP and Hub close
        // doors return it — absent when the session declared no criteria, so
        // it is never "unknown" — together with the close `warnings` (the
        // unmet-criteria sentence among them) this door used to drop.
        return {
          ...(result.session as FocusSession),
          warnings: result.warnings,
          ...(result.verdict ? { verdict: result.verdict } : {}),
        };
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "FORBIDDEN") {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: e.message ?? "Session completion not allowed",
          });
        }
        throw err;
      }
    }),

  /**
   * Grant a capability (tool/skill/command) to a live session — the runtime
   * counterpart to a playbook's static grants. Writes `session --grants-->
   * {capability}` so the session room's "add tool/skill" affordance has a
   * backing edge. Gated by checkPermissionOrPropose (AI grants route to a
   * reviewable proposal). Idempotent via the links unique-edge index.
   */
  grantCapability: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        // "capability" grants a CONTAINER — expanded to per-part enforcement
        // rows below (the gate stays per-tool/skill/command).
        capabilityKind: z.enum(["tool", "skill", "command", "capability"]),
        capabilityId: z.string(),
        agentUserId: z.string().uuid().optional(),
        source: z.string().optional(),
        reasoning: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Load by id ONLY, then gate on the loaded row's workspace.
      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, input.sessionId),
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }

      // Guard the latent project-scope hole: a session with a null workspace
      // would make checkPermissionOrPropose treat the grant as a personal
      // resource and AUTO-GRANT it, skipping workspace governance. No path
      // creates such a session today (P4b), so fail loud rather than silently
      // bypass — cross-workspace grant governance is not yet defined.
      if (!session.workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Project-scoped sessions (no workspace) cannot grant capabilities yet.",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        agentUserId: input.agentUserId,
        workspaceId: session.workspaceId,
        subjectType: "focus_session",
        action: "grant_capability",
        source: input.source,
        reasoning: input.reasoning,
        data: {
          sessionId: input.sessionId,
          capabilityKind: input.capabilityKind,
          capabilityId: input.capabilityId,
        },
      });
      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          granted: false,
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      await createLinks([
        {
          workspaceId: session.workspaceId,
          fromType: "session",
          fromId: session.id,
          toType: input.capabilityKind,
          toId: input.capabilityId,
          linkType: "grants",
          metadata: { grantedAt: new Date().toISOString() },
        },
      ]);

      // Write the ENFORCEMENT row alongside the `links{grants}` provenance edge
      // (G1 §4 convergence): the link is descriptive (graph view); the
      // capability_grants row is what a delegated capability-execution gate
      // consults at run time. Scope it to the session's workspace (and the
      // specific agent when one was named). Session-grants are 'session' scope
      // (unlimited within the session window) with execMode='auto'. The
      // canonical wildcard firewall runs here too — a grant must bind to an
      // agent and/or a workspace.
      assertGrantScoped({
        grantedTo: input.agentUserId ?? null,
        workspaceId: session.workspaceId,
      });
      // Enforcement rows are ALWAYS per runnable part — the gate is per-(kind,id)
      // and has no notion of a container. Granting a "capability" expands to one
      // vault_grants row per member part; a direct tool/skill/command grant is
      // the single part. (An empty container grants nothing enforceable yet; new
      // parts added later are not retroactively granted.)
      // For a capability CONTAINER grant, confirm the caller can actually SEE
      // the container before fanning its members out into grant rows — the
      // fan-out helper is a pure graph lookup with no visibility filter, so the
      // check belongs here (mirrors `containers.get`'s userVisibleWhere gate).
      if (input.capabilityKind === "capability") {
        const [container] = await db
          .select({ id: capabilities.id })
          .from(capabilities)
          .where(
            and(
              eq(capabilities.id, input.capabilityId),
              userVisibleWhere(capabilities.workspaceId, ctx.userId)
            )
          );
        if (!container) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Capability not found",
          });
        }
      }

      const grantParts =
        input.capabilityKind === "capability"
          ? await getCapabilityMemberParts([input.capabilityId])
          : [{ kind: input.capabilityKind, id: input.capabilityId }];
      if (grantParts.length > 0) {
        await db.insert(vaultGrants).values(
          grantParts.map((p) => ({
            grantableType: p.kind,
            grantableId: p.id,
            execMode: "auto" as const,
            grantedTo: input.agentUserId ?? null,
            workspaceId: session.workspaceId,
            scope: "session" as const,
            createdBy: ctx.userId,
          }))
        );
      }

      emitSideEffects({
        subjectType: "focus_session",
        action: "grant_capability",
        subjectId: session.id,
        userId: ctx.userId,
        workspaceId: session.workspaceId,
        data: {
          capabilityKind: input.capabilityKind,
          capabilityId: input.capabilityId,
        },
      });

      return { granted: true, status: "granted" as const };
    }),

  /**
   * MINT the session's room, if it has none — the browser-reachable half of the
   * one channel writer.
   *
   * `ensureSessionChannel` has existed since the session spine landed, but only
   * the CREATE paths called it, so an ad-hoc session that started channel-less
   * stayed channel-less forever and its room rendered a permanently disabled
   * composer. This door lets the composer mint the room on first send.
   *
   * NEVER a second channel writer: the insert, the title derivation and the
   * `focus_sessions.channel_id` write all stay inside that service. This is the
   * owner floor plus a call.
   *
   * Idempotent by construction — the service returns the existing `channelId`
   * when one is already set, so a double-send cannot mint two rooms.
   */
  ensureChannel: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Owner floor — the same predicate `get`/`update`/`attachOutput` use.
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
        columns: { id: true, workspaceId: true, goal: true, channelId: true },
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }

      const { ensureSessionChannel } =
        await import("../services/focus-sessions/ensure-session-channel.js");
      const channelId = await ensureSessionChannel({
        sessionId: session.id,
        userId: ctx.userId,
        workspaceId: session.workspaceId,
        goal: session.goal,
      });
      if (!channelId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not create a room for this session",
        });
      }
      return { channelId };
    }),

  /**
   * Record an EXISTING object as something this session produced — the human
   * counterpart to the agent write doors, which reach `recordSessionArtifact`
   * only as a side effect of creating the object themselves. A person looking
   * at a document/view/entity they made by hand had no way to say "this is the
   * session's output"; the room could only ever show what an agent made.
   *
   * Ungoverned on purpose, exactly like `update` above: `protectedProcedure` IS
   * the person, and a provenance row is not an AI mutation.
   *
   * `expectedLabel` names WHICH declared deliverable this satisfies. It is a
   * claim about the slot, stored on the artifact and honoured by
   * `joinSessionOutputs` (rule 3) — it does NOT stamp `status: "done"`, which
   * only `satisfyExpectedOutputs` may write (an approval, not an assertion).
   */
  attachOutput: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        // DERIVED from the artifacts ledger's own kind list, never re-typed.
        kind: z.enum(SESSION_ARTIFACT_KINDS),
        refId: z.string().min(1),
        /** Display title. Live titles still win on read for backed kinds. */
        label: z.string().min(1).max(500).optional(),
        /** A declared `expectedOutputs[].label` this output is claimed against. */
        expectedLabel: z.string().min(1).max(500).optional(),
        /**
         * FALLBACK lens, used ONLY when the session itself has none. The
         * session's own workspace always wins — this can never re-file an
         * output away from the session that produced it. Omitted on a
         * pod-personal session ⇒ the row is recorded pod-personal (NULL), which
         * `artifacts.workspace_id` has allowed since 0245.
         */
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Owner floor — the same predicate `get`/`update`/`outputs` use.
      const session = await db.query.focusSessions.findFirst({
        where: and(
          eq(focusSessions.id, input.sessionId),
          eq(focusSessions.userId, ctx.userId)
        ),
        columns: { id: true, workspaceId: true },
      });
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      // A pod-personal session files a pod-personal output. `input.workspaceId`
      // is only a fallback for a session that has no lens of its own.
      const workspaceId = session.workspaceId ?? input.workspaceId ?? null;

      // MEMBERSHIP FLOOR on the FALLBACK lens. The session's own workspace is
      // already gated by the owner floor above, but `input.workspaceId` is bare
      // request input: without this, a caller could file an artifact row into a
      // workspace they do not belong to, and the `artifacts` visibility rule
      // (workspace rows follow membership) would then show that row to THAT
      // workspace's members — a write-side leak into someone else's lens.
      if (!session.workspaceId && input.workspaceId) {
        await assertWorkspaceWrite(db, ctx.userId, {
          workspaceId: input.workspaceId,
        });
      }

      // The object the output POINTS AT must already be visible to the caller —
      // otherwise attaching it and re-reading the room returns its live title.
      const refVisible = await isOutputRefVisible({
        userId: ctx.userId,
        kind: input.kind,
        refId: input.refId,
      });
      if (!refVisible) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No ${input.kind} ${input.refId} you can access`,
        });
      }

      const outputId = await recordSessionArtifact({
        sessionId: session.id,
        workspaceId,
        userId: ctx.userId,
        kind: input.kind,
        refId: input.refId,
        title: input.label ?? input.refId,
        expectedLabel: input.expectedLabel,
        // No agentUserId — a person did this, so the ledger says originKind
        // "user" and the join reports `producedBy: "human"`.
      });
      if (!outputId) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Could not record the session output",
        });
      }
      return { ok: true as const, outputId };
    }),

  /**
   * DELEGATE one declared deliverable to an agent — the verb a slot never had.
   *
   * Composed entirely from existing doors (see
   * `services/focus-sessions/delegate-output.ts` for the order and the reasons):
   * the roster append, the ONE message door, the ONE turn starter, and the
   * row-locked `expectedOutputs` write. It stamps `delegatedTo`/`delegatedAt`
   * and NEVER `status` — a delegation is the moment the work has not been done.
   *
   * Ungoverned on purpose, exactly like `update` and `attachOutput` above:
   * `protectedProcedure` IS the person, asking on their own session.
   */
  delegateOutput: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        /** The declared `expectedOutputs[].label` to hand over. */
        expectedLabel: z.string().min(1).max(500),
        /**
         * Specialist agent type for the turn. Omitted ⇒ the orchestrator
         * ("meta"), which is `triggerAutoRespond`'s own default — not a second
         * one declared here.
         */
        agentType: z.string().min(1).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await delegateExpectedOutput({
        sessionId: input.sessionId,
        userId: ctx.userId,
        expectedLabel: input.expectedLabel,
        agentType: input.agentType,
      });
      switch (result.status) {
        case "not_found":
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Focus session ${input.sessionId} not found`,
          });
        case "unknown_label":
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `This session declares no output labelled "${input.expectedLabel}"`,
          });
        case "already_done":
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `"${input.expectedLabel}" is already delivered`,
          });
        case "no_channel":
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "Could not open a room for this session",
          });
        default:
          return {
            ok: true as const,
            expectedLabel: result.expectedLabel,
            kind: result.kind,
            agentType: result.agentType,
            channelId: result.channelId,
            messageId: result.messageId,
            triggered: result.triggered,
            agentAttached: result.agentAttached,
          };
      }
    }),

  /**
   * BLOCK one declared deliverable ON THE HUMAN — the other verb a slot needed.
   *
   * The twin of `delegateOutput`: that one hands a slot to an AGENT, this one
   * hands it to the PERSON, with the class of blocker and one line saying which
   * thing is missing. Both are targeted stampers rather than array patches, for
   * the reason `services/focus-sessions/block-output.ts` sets out — a wholesale
   * `update` cannot express "unset this field" at all.
   *
   * Never stamps `status`: declaring you cannot do the work is the opposite of
   * having done it.
   *
   * Ungoverned on purpose, exactly like `update`, `attachOutput` and
   * `delegateOutput`: `protectedProcedure` IS the person, on their own session.
   */
  blockOutput: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        /** The declared `expectedOutputs[].label` to hand over. */
        expectedLabel: z.string().min(1).max(500),
        blockedReason: z.enum(BLOCKED_REASONS),
        /** ONE line naming WHICH thing is missing, not its class. */
        why: z.string().max(500).optional(),
        /**
         * WHERE to go — the card's title becomes a door. `null` clears a stored
         * pointer; omitted leaves it alone. Refused when it names an object the
         * caller cannot already see (`isOutputRefVisible`, the one floor).
         */
        ref: outputRefWireSchema.nullable().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await blockExpectedOutput({
        sessionId: input.sessionId,
        userId: ctx.userId,
        expectedLabel: input.expectedLabel,
        blockedReason: input.blockedReason,
        why: input.why,
        ref: input.ref,
      });
      return slotOwnershipResult(result, input);
    }),

  /**
   * UNBLOCK — the agent reclaiming a slot it can now do. Clears `owner`,
   * `blockedReason`, `why` and `owedSince` together; the deliverable itself is
   * unchanged and still owed.
   */
  unblockOutput: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        expectedLabel: z.string().min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await unblockExpectedOutput({
        sessionId: input.sessionId,
        userId: ctx.userId,
        expectedLabel: input.expectedLabel,
      });
      return slotOwnershipResult(result, input);
    }),

  /**
   * ATTEST — "I did this". The human owner of a blocked slot discharging it.
   *
   * The DISCHARGE half of the pair the owed board needs; the other verb is
   * "Not mine", which is `unblockOutput` above and is NOT rebuilt here. There is
   * deliberately no third verb and no DISMISS: a row may be closed or handed
   * back, never merely hidden — GitHub's ambiguous "Done" is the precedent this
   * refuses to repeat.
   *
   * Runs through `attestExpectedOutput`, which lives inside
   * `satisfy-expected-output.ts` because `status: "done"` has ONE write door.
   *
   * tRPC ONLY, and that is a floor rather than an omission: `protectedProcedure`
   * IS the person, on their own session. There is no Hub REST twin because Hub
   * REST is the intelligence service's door, and an agent attesting that a human
   * did the thing the agent said it could not do is exactly the self-graded
   * homework this whole subsystem exists to prevent.
   */
  attestOutput: protectedProcedure
    .input(
      z.object({
        sessionId: z.string().uuid(),
        expectedLabel: z.string().min(1).max(500),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const result = await attestExpectedOutput({
        sessionId: input.sessionId,
        userId: ctx.userId,
        expectedLabel: input.expectedLabel,
      });
      return slotOwnershipResult(result, input);
    }),

  /**
   * OWED — every deliverable blocked on YOU, across every session you own.
   *
   * NOT composed over `list`, and it must never become so: `list` is capped at
   * 50 rows in SQL, while owed slots accumulate on OLD CLOSED sessions — exactly
   * the rows that fall off page one. The predicate is a WHERE clause
   * (`owed-outputs.ts`) for the same reason the triage and kind lenses are.
   *
   * No status filter: a slot outlives its session on `closed`/`failed`/`stale`,
   * and `cancelled` retires it with a stamp rather than a delete.
   *
   * Same lenses as `list` and the SAME application of them
   * (`sessionScopeConditions`), so "pod-wide" means one population, not two.
   * Oldest first — blocks never expire, and `owedSince` is the ordering key.
   */
  owed: protectedProcedure
    .input(
      z.object({
        workspaceId: ScopeFilterShape.workspaceId,
        projectId: ScopeFilterShape.projectId,
        /** Cap on SLOTS, not sessions. */
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      return listOwedSlots({
        userId: requireUserId(ctx.userId),
        scope: resolveScope(ctx, input),
        limit: input.limit,
      });
    }),

  /**
   * THE one door for "what did this session produce?" — the join of the three
   * output ledgers (`produced` edges, `artifacts` rows, `expected_outputs`).
   *
   * Consumers must navigate with `refId`, never an artifact row id.
   */
  outputs: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await listSessionOutputs({
        db,
        userId: ctx.userId,
        sessionId: input.sessionId,
      });
      if (!result) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Focus session ${input.sessionId} not found`,
        });
      }
      return result;
    }),

  /**
   * THE session's designated document: id, current version (the `baseVersion`
   * a section write must pass), content, and each section's owner + stamps.
   *
   * Pod tRPC mirror of the hub-protocol `getSessionDocument` procedure
   * (`routers/hub-protocol/documents.ts`) — both call the same
   * `readSessionDocument`, never a re-implementation. A session the caller
   * doesn't own (or a malformed id) is NOT_FOUND, enforced by
   * `loadOwnedSession` inside `readSessionDocument`.
   */
  document: protectedProcedure
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) =>
      readSessionDocument({
        sessionId: input.sessionId,
        userId: requireUserId(ctx.userId),
      })
    ),
});
