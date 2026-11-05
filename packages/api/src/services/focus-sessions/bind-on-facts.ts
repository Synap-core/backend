/**
 * BIND ON FACTS — load the facts, run the ladder (`resolve-binding-rung.ts`),
 * and apply its decision through the ONE follow door (`follow-playbook.ts`).
 *
 * Two callers, both AI doors only (founder decision d02, 2026-11-05):
 *   - the START (`create-session.ts` `bindOnFacts`), once the session row
 *     exists;
 *   - ONE late re-resolve (`rebindOnSubjectArrival`, from `update-session.ts`
 *     `bindOnFirstSubject` and the Hub REST PATCH), the first time the
 *     caller's own `subjectEntityId` lands on a session that still follows
 *     nothing. A subject set by another path (a person's capture naming the
 *     subject of their session) never binds. d02 also names a goal or a parent
 *     stage arriving; no rung reads a goal today, so only a subject re-runs.
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
 *     one is never bound again by the server;
 *   - a finished session (closed, cancelled, failed) is never bound;
 *   - rung 2 never binds a second open session to the same playbook on the
 *     same subject (the run funnel's own rule, `findInFlightSubjectSession`).
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
  notInArray,
  drizzleSql,
  getParentSessionId,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { readPlaybookParams } from "@synap/playbooks";
import { isUuid } from "@synap-core/types/property-render";
import {
  TERMINAL_SESSION_STATUSES,
  isTerminalSessionStatus,
} from "@synap-core/types/focus-sessions";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import {
  getLinksFor,
  resolveGrantedCapabilities,
} from "../links/links-service.js";
import { mergeSessionMetadata } from "./session-metadata.js";
import { UNFOLLOWED_AT_METADATA_KEY } from "./follow-playbook.js";
import { RUN_PARAMS_METADATA_KEY } from "../playbooks/playbook-lifecycle.js";
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
}): Promise<{
  situation: BindingSituation;
  pool: BindingPlaybook[];
  /** The parent's param answers (rung 3 carries them to the lane). */
  parentParams: Record<string, unknown>;
}> {
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
  if (input.subjectEntityId && isUuid(input.subjectEntityId)) {
    const [row] = await db
      .select({
        kind: profiles.slug,
        properties: entities.properties,
        statusCategory: entities.statusCategory,
      })
      .from(entities)
      .leftJoin(profiles, eq(profiles.id, entities.profileId))
      .where(eq(entities.id, input.subjectEntityId))
      .limit(1);
    if (row) {
      subject = {
        kind: row.kind ?? null,
        properties: (row.properties as Record<string, unknown> | null) ?? {},
        statusCategory: row.statusCategory ?? null,
      };
    }
  }

  let parent: BindingSituation["parent"] = null;
  let parentParams: Record<string, unknown> = {};
  if (input.parentSessionId && isUuid(input.parentSessionId)) {
    const [row] = await db
      .select({
        id: focusSessions.id,
        playbookId: focusSessions.playbookId,
        currentStage: focusSessions.currentStage,
        metadata: focusSessions.metadata,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.id, input.parentSessionId),
          eq(focusSessions.userId, input.userId)
        )
      )
      .limit(1);
    if (row) {
      parent = {
        id: row.id,
        playbookId: row.playbookId,
        currentStage: row.currentStage,
      };
      const answers = (row.metadata as Record<string, unknown> | null)?.[
        RUN_PARAMS_METADATA_KEY
      ];
      if (answers && typeof answers === "object" && !Array.isArray(answers)) {
        parentParams = answers as Record<string, unknown>;
      }
    }
  }

  return {
    situation: {
      title: input.title,
      // The SESSION's space only. A session in no space (a project session)
      // binds pod-wide playbooks only: a space's playbook is never bound to a
      // session that is not in that space, whatever space its subject is in.
      workspaceId: input.workspaceId,
      subject,
      parent,
    },
    pool,
    parentParams,
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
  const { situation, pool, parentParams } = await loadBindingFacts(input);
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

  // ONE open session per playbook per subject: the run funnel's own rule
  // (`findInFlightSubjectSession`), so two sessions about one finding never
  // both run "Fix a finding". Rung 2 only: a lane (rung 3) shares its parent's
  // work on purpose.
  if (decision.rung === "subject" && input.subjectEntityId) {
    const { findInFlightSubjectSession } =
      await import("../playbooks/run-playbook.js");
    const twin = await findInFlightSubjectSession(
      decision.playbookId,
      input.subjectEntityId
    );
    if (twin && twin.id !== input.sessionId) {
      return notBound(
        `${decision.reason}, but session ${twin.id} already follows it on this subject`
      );
    }
  }

  // The answers the facts give, in this order (a later one never overrides
  // an earlier one's answer):
  //   - a lane (rung 3) carries its parent's answers: same playbook, same work,
  //     so each lane does not owe the person the same questions again;
  //   - the session's subject answers the playbook's ONE entity param (the run
  //     funnel's own rule, `subjectAnswersEntityParam`): without it, a
  //     playbook asking "which UI design?" about the design it is bound to
  //     would file that question as a slot owed by the person. Two entity
  //     params are not guessed.
  const bound = pool.find((p) => p.id === decision.playbookId);
  const { subjectAnswersEntityParam } =
    await import("../playbooks/playbook-lifecycle.js");
  const params = subjectAnswersEntityParam(
    readPlaybookParams(bound?.params),
    {
      ...(decision.rung === "parent" ? parentParams : {}),
      ...decision.params,
    },
    situation.subject ? input.subjectEntityId : null
  );
  const { followPlaybook } = await import("./follow-playbook.js");
  const followed = await followPlaybook({
    sessionId: input.sessionId,
    userId: input.userId,
    agentUserId: input.agentUserId,
    followPlaybookId: decision.playbookId,
    ...(Object.keys(params).length > 0 ? { params } : {}),
    requireOpen: true,
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
 * The late re-resolve (d02): ONCE per session, the first time a subject
 * arrives on a session that follows nothing, never released one and has not
 * ended. The claim is atomic (only the call that flips the key runs it), so two
 * concurrent updates never both bind.
 */
export async function rebindOnFirstFact(input: {
  session: {
    id: string;
    playbookId: string | null;
    origin?: string | null;
    status?: string | null;
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
  if (isTerminalSessionStatus(session.status)) return undefined;
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
        // A finished session is never bound: no running playbook run, no
        // merged criteria, no owed slots on a closed run.
        notInArray(focusSessions.status, [...TERMINAL_SESSION_STATUSES]),
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

/**
 * WHEN an update re-runs the facts (d02), for every update door that offers it
 * (`update-session.ts`, the Hub REST PATCH): ONE rule, so the doors cannot
 * drift.
 *   - the door is an AI door that asked for it (`enabled`);
 *   - the subject came from THIS call's own `subjectEntityId` (a string) and
 *     the session had none before: a subject another path set (a person's
 *     capture naming their session's subject) never binds;
 *   - the call did not follow or release a playbook itself (its own choice
 *     wins) and the session follows none after the write.
 * Then `rebindOnFirstFact` applies its own once-only claim.
 */
export async function rebindOnSubjectArrival(input: {
  enabled: boolean | undefined;
  /** The call's own `subjectEntityId` argument, as sent. */
  subjectParam: string | null | undefined;
  /** The call's own `followPlaybookId` argument, as sent. */
  followParam: string | null | undefined;
  before: { subjectEntityId: string | null };
  after: Parameters<typeof rebindOnFirstFact>[0]["session"];
  userId: string;
  agentUserId?: string;
}): Promise<BindOnFactsResult | undefined> {
  if (!input.enabled) return undefined;
  if (typeof input.subjectParam !== "string") return undefined;
  if (input.followParam !== undefined) return undefined;
  if (input.before.subjectEntityId) return undefined;
  if (input.after.subjectEntityId !== input.subjectParam) return undefined;
  if (input.after.playbookId) return undefined;
  return rebindOnFirstFact({
    session: input.after,
    userId: input.userId,
    agentUserId: input.agentUserId,
  });
}
