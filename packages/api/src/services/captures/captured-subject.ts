/**
 * CAPTURED SUBJECT — which ONE thing a capture's work is about, read from what
 * the capture already filed. Shared by the two doors that start or continue
 * work from a capture: "Give to agent" (`give-to-agent.ts`) and relay's
 * capture into a work session (`capture.execute`).
 *
 * A session's work type is the kind of its subject (founder decision 2 A,
 * 2026-10-26). These doors attach a subject only when they KNOW it:
 *   - the person's own pick (`anchorEntityId`) wins;
 *   - else exactly ONE entity the capture filed (created or strong-linked: the
 *     pipeline already resolved identity) whose kind DECLARES a lifecycle
 *     (`ProfileResolutionService.getEffectiveLifecycles`, the one reader — not
 *     a slug heuristic, not a hand list of kinds). That keeps notes, knowledge
 *     and references out of the slot and lets issues, tasks, features,
 *     decisions, deals in;
 *   - several such entities, or none: no subject. Never a guess.
 *
 * Nothing here CREATES an entity: the capture pipeline is the only producer.
 * A failed read throws; it is never folded into "no subject".
 */
import {
  and,
  db,
  entities,
  eq,
  focusSessions,
  inArray,
  isNull,
  links,
  ProfileResolutionService,
} from "@synap/database";
import { projectSessionKind } from "../focus-sessions/session-kind.js";
import { updateFocusSession } from "../focus-sessions/update-session.js";

/**
 * The sole entity among `entityIds` whose kind declares a lifecycle, or null
 * (none, several, or deleted).
 */
export async function capturedSubjectOf(
  entityIds: ReadonlyArray<string>
): Promise<string | null> {
  const ids = [...new Set(entityIds)];
  if (ids.length === 0) return null;
  const rows = await db
    .select({ id: entities.id, profileId: entities.profileId })
    .from(entities)
    .where(and(inArray(entities.id, ids), isNull(entities.deletedAt)));
  const profileIds = [
    ...new Set(rows.map((r) => r.profileId).filter((p): p is string => !!p)),
  ];
  const lifecycles = await new ProfileResolutionService(
    db
  ).getEffectiveLifecycles(profileIds);
  const typed = rows.filter(
    (r) =>
      !!r.profileId && (lifecycles.get(r.profileId)?.options.length ?? 0) > 0
  );
  return typed.length === 1 ? typed[0]!.id : null;
}

/**
 * The subject of what an intake RUN filed: its `session --produced--> entity`
 * links (written by `capture.execute`), through {@link capturedSubjectOf}.
 */
export async function intakeRunSubjectOf(
  runSessionId: string
): Promise<string | null> {
  const produced = await db
    .select({ id: links.toId })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, runSessionId),
        eq(links.toType, "entity"),
        eq(links.linkType, "produced")
      )
    );
  return capturedSubjectOf(produced.map((l) => l.id));
}

export type NameCapturedSubjectResult =
  | { status: "named"; subjectEntityId: string }
  | {
      status: "skipped";
      reason: "not_found" | "not_work" | "has_subject" | "no_subject";
    }
  | { status: "refused"; reason: string };

/**
 * Name the subject of a person's WORK session a capture was filed into, when
 * it has none yet. Never overwrites a subject, never touches a run (an intake
 * run's subject is `ensureIntakeSession`'s), and writes through the floored
 * door (`updateFocusSession`).
 */
export async function nameCapturedSubject(p: {
  sessionId: string;
  userId: string;
  agentUserId?: string | null;
  anchorEntityId?: string | null;
  entityIds: ReadonlyArray<string>;
}): Promise<NameCapturedSubjectResult> {
  const [session] = await db
    .select({
      origin: focusSessions.origin,
      playbookId: focusSessions.playbookId,
      metadata: focusSessions.metadata,
      status: focusSessions.status,
      subjectEntityId: focusSessions.subjectEntityId,
    })
    .from(focusSessions)
    .where(
      and(eq(focusSessions.id, p.sessionId), eq(focusSessions.userId, p.userId))
    )
    .limit(1);
  if (!session) return { status: "skipped", reason: "not_found" };
  if (projectSessionKind(session) !== "work") {
    return { status: "skipped", reason: "not_work" };
  }
  if (session.subjectEntityId) {
    return { status: "skipped", reason: "has_subject" };
  }
  const subject = p.anchorEntityId || (await capturedSubjectOf(p.entityIds));
  if (!subject) return { status: "skipped", reason: "no_subject" };
  const res = await updateFocusSession({
    sessionId: p.sessionId,
    userId: p.userId,
    ...(p.agentUserId ? { agentUserId: p.agentUserId } : {}),
    subjectEntityId: subject,
  });
  if (res.status === "updated") {
    return { status: "named", subjectEntityId: subject };
  }
  return {
    status: "refused",
    reason: "reason" in res ? String(res.reason) : res.status,
  };
}
