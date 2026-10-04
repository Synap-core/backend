/**
 * LENS CONTAINERS — which session (and so which track, project) a
 * notification belongs to, DERIVED from what it already points at.
 *
 * `notifications` carries a workspace and nothing narrower, so a project,
 * track or session lens used to drop every notification and AI suggestion
 * (`signals.list` read them "proposals-only" under a container scope). No
 * column is needed to fix that: the row already names its subject.
 *
 *   - a SESSION target — `targetFromNotification` resolves it to a session
 *     (`sourceType: "session"`), or the registry type opens a session on its
 *     own `sourceId` (a `navigate-object` action of kind `session` with no
 *     literal id: `session.unblocked`, written with `sourceType: "system"`);
 *   - a ROOM message — `proactive_message` rows carry the message id; the
 *     message's channel is a session's room (`focus_sessions.channel_id`).
 *
 * The session is then read THROUGH THE SESSION READ FLOOR
 * (`sessionReadableWhere`, with the door's own roster reading): a session the
 * viewer cannot read is absent, so its notification resolves to no container
 * at all and stays a pod/workspace row — it neither names the session nor
 * leaks that it belongs to one. A session's track carries the track's project
 * (`focus_sessions.track_id`), so session ⊂ track ⊂ project nests.
 *
 * Also here: `sessionsWithOwedSlot`, the uncapped "does this pointer's session
 * still owe the person something" read (needs-you duplicate cause 3).
 */

import {
  db,
  and,
  eq,
  inArray,
  isNotNull,
  or,
  drizzleSql as sql,
  focusSessions,
  messages,
  notifications,
  type SQL,
} from "@synap/database";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import {
  sessionReadableWhere,
  type SessionReader,
} from "../../access/session-visibility.js";
import { NOTIFICATION_REGISTRY_MAP } from "../../notifications/registry.js";
import { owedSlotWhere } from "../focus-sessions/owed-outputs.js";
import {
  targetFromNotification,
  type NotificationContainer,
  type NotificationSignalInput,
} from "./needs-you-union.js";

/** What a notification points at, before any read. Pure. */
export type NotificationRef =
  | { kind: "session"; sessionId: string }
  | { kind: "message"; messageId: string }
  | null;

/** Does this registry type open a session on its OWN `sourceId`? */
function typeOpensItsSession(type: string | undefined): boolean {
  const def = type ? NOTIFICATION_REGISTRY_MAP.get(type) : undefined;
  return !!def?.actions?.some((a) => {
    const h = a.handler as { type?: string; kind?: string; id?: string };
    return h.type === "navigate-object" && h.kind === "session" && !h.id;
  });
}

export function notificationRef(row: NotificationSignalInput): NotificationRef {
  if (!row.sourceId) return null;
  const target = targetFromNotification(row.sourceType, row.sourceId);
  if (target?.kind === "session" || typeOpensItsSession(row.type)) {
    return { kind: "session", sessionId: row.sourceId };
  }
  if (row.sourceType === "proactive_message") {
    return { kind: "message", messageId: row.sourceId };
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * notification id → its container, for every row whose subject resolves to a
 * session the reader may read. A row absent from the map has NO container
 * narrower than its workspace. Two batched reads at most (messages, sessions).
 */
export async function resolveNotificationContainers(
  rows: readonly NotificationSignalInput[],
  reader: SessionReader
): Promise<Map<string, NotificationContainer>> {
  const out = new Map<string, NotificationContainer>();
  const refs = rows.map((r) => [r.id, notificationRef(r)] as const);
  const sessionIds = new Set<string>();
  const messageIds = new Set<string>();
  for (const [, ref] of refs) {
    // Ids are text on the notification row; a non-uuid can name nothing here
    // and would make the uuid comparison throw.
    if (ref?.kind === "session" && UUID.test(ref.sessionId))
      sessionIds.add(ref.sessionId);
    if (ref?.kind === "message" && UUID.test(ref.messageId))
      messageIds.add(ref.messageId);
  }
  if (sessionIds.size === 0 && messageIds.size === 0) return out;

  const channelOfMessage = new Map<string, string>();
  if (messageIds.size > 0) {
    const msgs = await db
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(inArray(messages.id, [...messageIds]));
    for (const m of msgs) {
      if (m.channelId) channelOfMessage.set(m.id, m.channelId);
    }
  }
  const channelIds = [...new Set(channelOfMessage.values())];
  const keys = [
    ...(sessionIds.size ? [inArray(focusSessions.id, [...sessionIds])] : []),
    ...(channelIds.length
      ? [inArray(focusSessions.channelId, channelIds)]
      : []),
  ];
  if (keys.length === 0) return out;
  const sessions = await db
    .select({
      id: focusSessions.id,
      title: focusSessions.title,
      goal: focusSessions.goal,
      projectId: focusSessions.projectId,
      trackId: focusSessions.trackId,
      channelId: focusSessions.channelId,
    })
    .from(focusSessions)
    .where(and(or(...keys), sessionReadableWhere(reader)));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const byChannel = new Map(
    sessions.filter((s) => s.channelId).map((s) => [s.channelId!, s])
  );

  for (const [id, ref] of refs) {
    const s =
      ref?.kind === "session"
        ? byId.get(ref.sessionId)
        : ref?.kind === "message"
          ? byChannel.get(channelOfMessage.get(ref.messageId) ?? "")
          : undefined;
    if (!s) continue;
    out.set(id, {
      sessionId: s.id,
      sessionTitle: resolveSessionTitle(s) || null,
      projectId: s.projectId ?? null,
      trackId: s.trackId ?? null,
    });
  }
  return out;
}

/** The container lenses a notification can be narrowed by. */
export interface ContainerLens {
  sessionId?: string;
  trackId?: string;
  projectId?: string;
}

/**
 * Is this notification INSIDE the container lens? With no container lens every
 * row is (the pod / workspace floor). Under one, only a row whose resolved
 * container matches every lens given. Pure — the ONE predicate every class
 * narrows notifications by, at every scope.
 */
export function inContainerLens(
  container: NotificationContainer | undefined,
  lens: ContainerLens
): boolean {
  if (!lens.sessionId && !lens.trackId && !lens.projectId) return true;
  if (!container) return false;
  if (lens.sessionId && container.sessionId !== lens.sessionId) return false;
  if (lens.trackId && container.trackId !== lens.trackId) return false;
  if (lens.projectId && container.projectId !== lens.projectId) return false;
  return true;
}

/**
 * The container lens IN SQL — a SUPERSET prefilter for a `notifications` read,
 * so a narrow scope spends the read's LIMIT on its own rows instead of the
 * newest N pod-wide (a project's notification older than the pod's newest 100
 * unread was silently absent, and every narrow page read as truncated).
 *
 * Mirrors `notificationRef` → `resolveNotificationContainers`: a row whose
 * `source_id` names a session inside the lens (a session target, or a type
 * that opens a session on its own `sourceId`), or a `proactive_message` whose
 * message sits in such a session's room. Sessions go through the SAME read
 * floor (`sessionReadableWhere`), and the same nesting (a track's sessions
 * carry its project). It may over-match — a row whose `sourceId` merely
 * equals a session id — so `inContainerLens` over the resolved containers
 * stays the authority; it never under-matches a row that resolution places
 * inside the lens. `undefined` = no container lens (nothing to narrow).
 */
export function containerNotificationWhere(
  lens: ContainerLens,
  reader: SessionReader
): SQL | undefined {
  if (!lens.sessionId && !lens.trackId && !lens.projectId) return undefined;
  const inScope = and(
    ...(lens.sessionId ? [eq(focusSessions.id, lens.sessionId)] : []),
    ...(lens.trackId ? [eq(focusSessions.trackId, lens.trackId)] : []),
    ...(lens.projectId ? [eq(focusSessions.projectId, lens.projectId)] : []),
    sessionReadableWhere(reader)
  );
  const sessionIds = db
    .select({ id: sql<string>`${focusSessions.id}::text` })
    .from(focusSessions)
    .where(inScope);
  const roomMessageIds = db
    .select({ id: sql<string>`${messages.id}::text` })
    .from(messages)
    .where(
      inArray(
        messages.channelId,
        db
          .select({ channelId: focusSessions.channelId })
          .from(focusSessions)
          .where(and(inScope, isNotNull(focusSessions.channelId)))
      )
    );
  return or(
    inArray(notifications.sourceId, sessionIds),
    and(
      eq(notifications.sourceType, "proactive_message"),
      inArray(notifications.sourceId, roomMessageIds)
    )
  );
}

/**
 * Which of these sessions still hold an owed slot for this person — measured
 * directly, NOT read off a capped owed page. A `session.needs_you` pointer
 * folds into its session's need whenever this says so, whatever the owed
 * page's cap cut (needs-you duplicate cause 3). Ids only; the ids come from the
 * caller's OWN notification rows, and the owner floor is the owed read's.
 */
export async function sessionsWithOwedSlot(
  userId: string,
  sessionIds: readonly string[]
): Promise<Set<string>> {
  const ids = [...new Set(sessionIds)].filter((id) => UUID.test(id));
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: focusSessions.id })
    .from(focusSessions)
    .where(
      and(
        inArray(focusSessions.id, ids),
        eq(focusSessions.userId, userId),
        owedSlotWhere()
      )
    );
  return new Set(rows.map((r) => r.id));
}
