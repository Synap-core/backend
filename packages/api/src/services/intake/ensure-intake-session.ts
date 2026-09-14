/**
 * ensureIntakeSession — THE one door that answers "which session does this
 * intake run belong to?" for every capture and import door.
 *
 * A capture/import that produces proposals must belong to a session (intake
 * plan, locked decision 1 + D16 "room persisted from the first token").
 *
 * Ladder:
 *   1. a handle the caller sent that VERIFIES (`resolveVerifiedSessionId`: the
 *      already-verified header handle, else a body handle the caller owns) →
 *      `provided`;
 *   2. otherwise an intake session is MINTED through `openRunSession` (the one
 *      ungated run-session door — a session container is not a domain write;
 *      every write filed INTO it is still governed on its own proposal). With a
 *      `correlationKey`, an earlier intake session of the same user under the
 *      same key is REUSED, so a retry of one capture lands in one room.
 *
 * SECURITY is unchanged from `resolveVerifiedSessionId`: a handle the caller
 * does not own is never used. What is NEW is that the refusal is no longer
 * silent to the caller: `requestedSessionIgnored` + the real `sessionId` ride
 * the response, so a client hands off only on the id that was actually used.
 *
 * Classification: a minted session carries `metadata.intake`, which
 * `session-kind.ts` reads as a RUN signal (a machine execution recorded as a
 * session) — never `work`, never a `receipt`.
 *
 * A mint FAILURE is returned as `status: "failed"` with the error — never as
 * "no session", which would read as a capture that simply had none.
 */

import { createLogger } from "@synap-core/core";
import {
  db,
  focusSessions,
  openRunSession,
  and,
  eq,
  isNull,
  or,
  drizzleSql,
} from "@synap/database";
import { resolveVerifiedSessionId } from "../../routers/hub-protocol/_middleware/session.js";

const logger = createLogger({ module: "intake/ensure-intake-session" });

/** The metadata key that marks a session as a minted intake run. */
export const INTAKE_SESSION_METADATA_KEY = "intake";

export type IntakeDoor = "capture" | "import";

export interface EnsureIntakeSessionInput {
  userId: string;
  /** Placement of a MINTED session only; a provided session keeps its own. */
  workspaceId?: string | null;
  projectId?: string | null;
  agentUserId?: string | null;
  /** A handle already verified upstream (the `X-Session-Id` middleware). */
  verifiedHandle?: string | null;
  /** A raw handle off the request body — verified here, never trusted. */
  bodyHandle?: string | null;
  door: IntakeDoor;
  /** Goal of a minted session ("Capture · …", "Import 12 markdown items"). */
  goal: string;
  /** Stable per-capture key: a retry reuses the room instead of minting a second. */
  correlationKey?: string | null;
  /**
   * The canonical key of the PLAN (`capturePlanKey`): structure remembers it on
   * its room, execute looks it up — so an execute whose client did not forward
   * the structure `sessionId` still lands in structure's room (decision F).
   */
  planKey?: string | null;
  /**
   * Workspaces a REUSED session may belong to. Default: `[workspaceId]`.
   * Reuse never crosses workspaces and never picks a closed/cancelled session.
   */
  reuseWorkspaceIds?: ReadonlyArray<string | null>;
  /**
   * A rerun's parent: a MINTED session records `session --spawned_from-->
   * parent` (openRunSession's edge). Ignored for a provided session.
   */
  parentSessionId?: string | null;
  /**
   * The entity this run is ABOUT ("Structure again" on a note): a MINTED
   * session records it as `subject_entity_id` (openRunSession's column, which
   * also feeds the project placement ladder). Ignored for a provided session.
   */
  subjectEntityId?: string | null;
}

interface RequestEcho {
  /** The handle the caller SENT (body first, then header), or null. */
  requestedSessionId: string | null;
  /** True when a handle was sent and a DIFFERENT session was used. */
  requestedSessionIgnored: boolean;
}

export type EnsureIntakeSessionResult =
  | ({ status: "provided"; sessionId: string } & RequestEcho)
  | ({ status: "minted"; sessionId: string; reused: boolean } & RequestEcho)
  | ({ status: "failed"; sessionId: null; error: string } & RequestEcho);

/**
 * Remember a plan key on a session (owner-floored) so a later execute that was
 * not handed the `sessionId` can find the room by the plan it executes. Kept at
 * the top level of `metadata`, not under `intake`, so a person's own (provided)
 * session can carry it too without becoming a run.
 */
export async function rememberIntakePlanKey(args: {
  sessionId: string;
  userId: string;
  planKey: string;
}): Promise<void> {
  await db
    .update(focusSessions)
    .set({
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || jsonb_build_object('intakePlanKeys', COALESCE(${focusSessions.metadata} -> 'intakePlanKeys', '[]'::jsonb) || ${JSON.stringify([args.planKey])}::jsonb)`,
    })
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    );
}

/**
 * The refine inputs a capture follow-up answer re-runs structure with. SERVER
 * ONLY: stored on the session, never in a message. A file source keeps its
 * EXTRACTED text — the bytes already live in the staged source document.
 */
export interface IntakeClarificationRefine {
  text?: string;
  url?: string;
  context?: string;
  instructions?: string;
  anchorEntityId?: string;
  previousEntities?: Array<{
    tempId: string;
    profileSlug: string;
    title: string;
    description?: string;
    properties?: Record<string, unknown>;
  }>;
}

export interface IntakeClarification {
  questionMessageId: string;
  round: number;
  refine: IntakeClarificationRefine;
}

/** At most this many previous entities ride a stored refine. */
export const CLARIFICATION_PREVIOUS_ENTITIES_MAX = 12;

/**
 * Remember the open clarification on a session (owner-floored), as a jsonb
 * merge under `metadata.intake.clarification`. Replaces the previous one — only
 * the latest question can be answered with these inputs. Never touches
 * `metadata.run` (its single writer is `recordSessionRunManifest`).
 */
export async function rememberIntakeClarification(args: {
  sessionId: string;
  userId: string;
  clarification: IntakeClarification;
}): Promise<void> {
  const clarification: IntakeClarification = {
    ...args.clarification,
    refine: {
      ...args.clarification.refine,
      ...(args.clarification.refine.previousEntities
        ? {
            previousEntities: args.clarification.refine.previousEntities.slice(
              0,
              CLARIFICATION_PREVIOUS_ENTITIES_MAX
            ),
          }
        : {}),
    },
  };
  await db
    .update(focusSessions)
    .set({
      // Merged under `intake` (INTAKE_SESSION_METADATA_KEY) without disturbing
      // its other keys (door, mintedAt, correlationKey).
      metadata: drizzleSql`COALESCE(${focusSessions.metadata}, '{}'::jsonb) || jsonb_build_object('intake', COALESCE(${focusSessions.metadata} -> 'intake', '{}'::jsonb) || jsonb_build_object('clarification', ${JSON.stringify(clarification)}::jsonb))`,
    })
    .where(
      and(
        eq(focusSessions.id, args.sessionId),
        eq(focusSessions.userId, args.userId)
      )
    );
}

/** The stored clarification, or null when absent or malformed. */
export function readIntakeClarification(
  metadata: unknown
): IntakeClarification | null {
  const c = (metadata as { intake?: { clarification?: unknown } } | null)
    ?.intake?.clarification as Partial<IntakeClarification> | undefined;
  if (
    !c ||
    typeof c.questionMessageId !== "string" ||
    typeof c.round !== "number" ||
    !c.refine ||
    typeof c.refine !== "object"
  ) {
    return null;
  }
  return c as IntakeClarification;
}

function normalizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim().slice(0, 240) || "Intake";
}

export async function ensureIntakeSession(
  input: EnsureIntakeSessionInput
): Promise<EnsureIntakeSessionResult> {
  const requestedSessionId = input.bodyHandle ?? input.verifiedHandle ?? null;
  const echo = (sessionId: string | null): RequestEcho => ({
    requestedSessionId,
    requestedSessionIgnored:
      requestedSessionId !== null && sessionId !== requestedSessionId,
  });

  const verified = await resolveVerifiedSessionId(
    input.userId,
    input.verifiedHandle,
    input.bodyHandle
  );
  if (verified) {
    return { status: "provided", sessionId: verified, ...echo(verified) };
  }

  try {
    const reuseKeys = [
      ...(input.correlationKey
        ? [
            drizzleSql`${focusSessions.metadata} #>> '{intake,correlationKey}' = ${input.correlationKey}`,
          ]
        : []),
      ...(input.planKey
        ? [
            drizzleSql`${focusSessions.metadata} -> 'intakePlanKeys' @> ${JSON.stringify([input.planKey])}::jsonb`,
          ]
        : []),
    ];
    if (reuseKeys.length > 0) {
      const workspaces = input.reuseWorkspaceIds ?? [input.workspaceId ?? null];
      const [existing] = await db
        .select({ id: focusSessions.id })
        .from(focusSessions)
        .where(
          and(
            eq(focusSessions.userId, input.userId),
            // Only a LIVE room: a cancelled/closed run is never refilled.
            eq(focusSessions.status, "active"),
            // Never across workspaces.
            or(
              ...workspaces.map((w) =>
                w
                  ? eq(focusSessions.workspaceId, w)
                  : isNull(focusSessions.workspaceId)
              )
            ),
            or(...reuseKeys)
          )
        )
        .limit(1);
      if (existing) {
        return {
          status: "minted",
          sessionId: existing.id,
          reused: true,
          ...echo(existing.id),
        };
      }
    }
    const opened = await openRunSession({
      userId: input.userId,
      goal: normalizeGoal(input.goal),
      workspaceId: input.workspaceId ?? null,
      projectId: input.projectId ?? null,
      agentUserId: input.agentUserId ?? null,
      // A person's capture is a human-started run; only an agent key is "agent".
      origin: input.agentUserId ? "agent" : "human",
      ...(input.parentSessionId
        ? { parentSessionId: input.parentSessionId }
        : {}),
      ...(input.subjectEntityId
        ? { subjectEntityId: input.subjectEntityId }
        : {}),
      source: `intake:${input.door}`,
      extraMetadata: {
        [INTAKE_SESSION_METADATA_KEY]: {
          door: input.door,
          mintedAt: new Date().toISOString(),
          ...(input.correlationKey
            ? { correlationKey: input.correlationKey }
            : {}),
        },
      },
    });
    return {
      status: "minted",
      sessionId: opened.sessionId,
      reused: opened.reused,
      ...echo(opened.sessionId),
    };
  } catch (err) {
    logger.error(
      { err, userId: input.userId, door: input.door },
      "intake session mint failed — the run has no room; the response says so"
    );
    return {
      status: "failed",
      sessionId: null,
      error: err instanceof Error ? err.message : String(err),
      ...echo(null),
    };
  }
}
