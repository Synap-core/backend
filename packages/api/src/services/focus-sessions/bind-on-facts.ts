/**
 * BIND ON FACTS — load the facts, run the ladder (`resolve-binding-rung.ts`),
 * and apply its decision through the ONE follow door (`follow-playbook.ts`).
 *
 * Two callers, both AI doors (founder decision d02, 2026-11-05):
 *   - the START (`create-session.ts`), once the session row exists;
 *   - ONE late re-resolve (`update-session.ts`), the first time a subject or a
 *     goal (`trackId`) arrives on a session that still follows nothing.
 *
 * Going through `followPlaybook` keeps every rule of a follow: criteria and
 * deliverables MERGE (nothing is overwritten), no stage is seeded mid-flight,
 * the definition is pinned on a run row, an unanswered required param becomes
 * a slot owed by the person. Two extra floors here, because nobody asked for
 * this bind:
 *   - a playbook that GRANTS capabilities is not bound for the caller (the
 *     follow would file a widening proposal the agent never asked for); the
 *     reply says it fits and how to follow it;
 *   - a session that released a playbook (`unfollowedAt`) or already follows
 *     one is never bound again by the server.
 *
 * Every server bind is recorded on `metadata.boundBy` ({rung, reason,
 * playbookId, phase, at}) and said back in ONE reply line (`bindingLine`).
 */
import {
  db,
  entities,
  focusSessions,
  playbooks,
  profiles,
  eq,
  and,
  drizzleSql,
  getParentSessionId,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { isUuid } from "@synap-core/types/property-render";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";
import { mergeSessionMetadata } from "./session-metadata.js";
import { UNFOLLOWED_AT_METADATA_KEY } from "./follow-playbook.js";
import {
  bindingLine,
  resolveBindingRung,
  type BindingDecision,
  type BindingPlaybook,
  type BindingRung,
  type BindingSituation,
} from "./resolve-binding-rung.js";

const logger = createLogger({ module: "bind-on-facts" });

/** Why the server bound this session, on `focus_sessions.metadata`. */
export const BOUND_BY_METADATA_KEY = "boundBy";
/** Stamped once when the late re-resolve ran (d02: once per session). */
export const BIND_RECHECKED_AT_METADATA_KEY = "bindRecheckedAt";

export interface BoundBy {
  rung: BindingRung;
  reason: string;
  playbookId: string;
  phase: "start" | "update";
  at: string;
}

export interface BindOnFactsResult {
  decision: BindingDecision["kind"] | "not_bound";
  /** The ONE reply line; absent when there is nothing to say. */
  line?: string;
  boundBy?: BoundBy;
}

export interface BindOnFactsInput {
  sessionId: string;
  userId: string;
  agentUserId?: string;
  phase: "start" | "update";
  title: string | null;
  workspaceId: string | null;
  subjectEntityId: string | null;
  parentSessionId: string | null;
}

/** The facts the ladder reads, loaded through the owner floor. */
export async function loadBindingFacts(input: {
  userId: string;
  workspaceId: string | null;
  title: string | null;
  subjectEntityId: string | null;
  parentSessionId: string | null;
}): Promise<{ situation: BindingSituation; pool: BindingPlaybook[] }> {
  // The pool the follow door can see (`userVisibleWhere`, its own floor), so
  // a decision is always one the door can apply. Active only: a draft never
  // binds.
  const pool = (await db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      status: playbooks.status,
      scope: playbooks.scope,
      workspaceId: playbooks.workspaceId,
      subjectProfile: playbooks.subjectProfile,
      inputStrategy: playbooks.inputStrategy,
      stages: playbooks.stages,
      params: playbooks.params,
    })
    .from(playbooks)
    .where(
      and(
        userVisibleWhere(playbooks.workspaceId, input.userId),
        eq(playbooks.status, "active")
      )
    )) as BindingPlaybook[];

  // The subject was floored by the door that set it (`isOutputRefVisible`).
  let subject: BindingSituation["subject"] = null;
  let subjectWorkspaceId: string | null = null;
  if (input.subjectEntityId && isUuid(input.subjectEntityId)) {
    const [row] = await db
      .select({
        kind: profiles.slug,
        workspaceId: entities.workspaceId,
        properties: entities.properties,
      })
      .from(entities)
      .leftJoin(profiles, eq(profiles.id, entities.profileId))
      .where(eq(entities.id, input.subjectEntityId))
      .limit(1);
    if (row) {
      subject = {
        kind: row.kind ?? null,
        properties: (row.properties as Record<string, unknown> | null) ?? {},
      };
      subjectWorkspaceId = row.workspaceId ?? null;
    }
  }

  let parent: BindingSituation["parent"] = null;
  if (input.parentSessionId && isUuid(input.parentSessionId)) {
    const [row] = await db
      .select({
        id: focusSessions.id,
        playbookId: focusSessions.playbookId,
        currentStage: focusSessions.currentStage,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, input.parentSessionId),
          eq(focusSessions.userId, input.userId)
        )
      )
      .limit(1);
    parent = row ?? null;
  }

  return {
    situation: {
      title: input.title,
      // A project session has no space of its own: its subject's space is
      // where its playbooks live.
      workspaceId: input.workspaceId ?? subjectWorkspaceId,
      subject,
      parent,
    },
    pool,
  };
}

async function grantsCapabilities(
  userId: string,
  playbookId: string
): Promise<number> {
  const edges = await getLinksFor(userId, "playbook", playbookId);
  const granted = await resolveGrantedCapabilities(edges, {
    linkType: "grants",
    fromType: "playbook",
  });
  return granted.length;
}

/** Record a bind the caller named (rung 1) — the start door did the bind. */
export async function stampBoundBy(
  sessionId: string,
  boundBy: BoundBy
): Promise<void> {
  await db
    .update(focusSessions)
    .set({
      metadata: mergeSessionMetadata({ [BOUND_BY_METADATA_KEY]: boundBy }),
    })
    .where(eq(focusSessions.id, sessionId));
}

/**
 * Resolve and apply. Never throws: binding is a courtesy of the door, and a
 * failure is said back (`not_bound`), never read as "nothing fits".
 */
export async function bindOnFacts(
  input: BindOnFactsInput
): Promise<BindOnFactsResult> {
  const { situation, pool } = await loadBindingFacts(input);
  const decision = resolveBindingRung(situation, pool);
  if (decision.kind === "none") return { decision: "none" };
  if (decision.kind === "offer") {
    return {
      decision: "offer",
      line: bindingLine({
        kind: "offer",
        reason: decision.reason,
        candidates: decision.candidates,
      }),
    };
  }

  const notBound = (reason: string): BindOnFactsResult => ({
    decision: "not_bound",
    line: bindingLine({
      kind: "not_bound",
      playbookId: decision.playbookId,
      playbookName: decision.playbookName,
      reason,
    }),
  });

  const grants = await grantsCapabilities(input.userId, decision.playbookId);
  if (grants > 0) {
    return notBound(
      `${decision.reason}, but it grants ${grants} capabilit${grants === 1 ? "y" : "ies"}, a widening you review by following it yourself`
    );
  }

  const { followPlaybook } = await import("./follow-playbook.js");
  const followed = await followPlaybook({
    sessionId: input.sessionId,
    userId: input.userId,
    agentUserId: input.agentUserId,
    followPlaybookId: decision.playbookId,
    ...(decision.params ? { params: decision.params } : {}),
  });
  if (followed.status !== "ok") {
    const why =
      followed.status === "not_found"
        ? "the session was not found"
        : followed.reason;
    logger.info(
      { sessionId: input.sessionId, playbookId: decision.playbookId, why },
      "a fact named a playbook the follow door did not attach"
    );
    return notBound(why);
  }

  const boundBy: BoundBy = {
    rung: decision.rung,
    reason: decision.reason,
    playbookId: decision.playbookId,
    phase: input.phase,
    at: new Date().toISOString(),
  };
  await stampBoundBy(input.sessionId, boundBy);
  return {
    decision: "bind",
    boundBy,
    line: bindingLine({
      kind: "bound",
      playbookId: decision.playbookId,
      playbookName: decision.playbookName,
      reason: decision.reason,
    }),
  };
}

/**
 * The late re-resolve (d02): ONCE per session, the first time a subject or a
 * goal arrives on a session that follows nothing and never released one. The
 * claim is atomic (only the call that flips the key runs it), so two
 * concurrent updates never both bind.
 */
export async function rebindOnFirstFact(input: {
  session: {
    id: string;
    playbookId: string | null;
    origin?: string | null;
    title: string | null;
    workspaceId: string | null;
    subjectEntityId: string | null;
    metadata: unknown;
  };
  userId: string;
  agentUserId?: string;
}): Promise<BindOnFactsResult | undefined> {
  const { session } = input;
  if (session.playbookId || session.origin === "playbook") return undefined;
  const meta = (session.metadata ?? {}) as Record<string, unknown>;
  if (meta[UNFOLLOWED_AT_METADATA_KEY] !== undefined) return undefined;
  if (meta[BIND_RECHECKED_AT_METADATA_KEY] !== undefined) return undefined;

  const won = await db
    .update(focusSessions)
    .set({
      metadata: mergeSessionMetadata({
        [BIND_RECHECKED_AT_METADATA_KEY]: new Date().toISOString(),
      }),
    })
    .where(
      and(
        eq(focusSessions.id, session.id),
        eq(focusSessions.userId, input.userId),
        drizzleSql`${focusSessions.playbookId} IS NULL`,
        drizzleSql`NOT (coalesce(${focusSessions.metadata}, '{}'::jsonb) ? ${BIND_RECHECKED_AT_METADATA_KEY})`,
        drizzleSql`NOT (coalesce(${focusSessions.metadata}, '{}'::jsonb) ? ${UNFOLLOWED_AT_METADATA_KEY})`
      )
    )
    .returning({ id: focusSessions.id });
  if (won.length === 0) return undefined;

  try {
    return await bindOnFacts({
      sessionId: session.id,
      userId: input.userId,
      agentUserId: input.agentUserId,
      phase: "update",
      title: session.title,
      workspaceId: session.workspaceId,
      subjectEntityId: session.subjectEntityId,
      // The `spawned_from` edge, read-only: a lane's parent may follow a
      // playbook (rung 3). Never a close path (`session-detour-pop.test.ts`).
      parentSessionId: await getParentSessionId(session.id),
    });
  } catch (err) {
    logger.warn(
      { err, sessionId: session.id },
      "late playbook re-resolve failed — the session stays unbound"
    );
    return {
      decision: "not_bound",
      line: "No playbook bound: the pod could not read the facts to decide.",
    };
  }
}
