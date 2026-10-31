/**
 * THE handoff door's service half (decision D5, be431bee): a person asks their
 * OTHER device to pick up an object, through the pod.
 *
 * The request is a POINTER — `{kind, id, view?}` (`HandoffTarget`,
 * `@synap-core/types/navigation`) — stored as one notification for the
 * person: `handoff.continue` for their desktops (in-app, live over the user
 * room, unread in the inbox when closed), `handoff.to_phone` for their phones
 * (in-app + push). Prior art it follows: Apple Handoff carries a pointer,
 * never the data; Firefox "Send tab" lost tabs sent to an offline device
 * because it rode a push alone — a pod row does not; Chrome "send to your
 * devices" names where it goes before it is sent (`handoffReach`).
 *
 * What it never claims: that a device OPENED anything. The answer says the
 * request was stored and to which devices it can reach.
 *
 * Router: `notifCenter.handoff` / `notifCenter.handoffTargets`
 * (`routers/notif-center.ts`), which own the person-only and grant checks.
 */

import { TRPCError } from "@trpc/server";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  db,
  and,
  eq,
  gte,
  desc,
  isNull,
  notifications,
  focusSessions,
  entities,
  documents,
  proposals,
  projectTracks,
  projects,
  automations,
  playbooks,
  libraryGroups,
  NotificationStatus,
} from "@synap/database";
import {
  type HandoffDevice,
  type HandoffKind,
  type HandoffReach,
  type HandoffTarget,
  objectNavViewApplies,
} from "@synap-core/types/navigation";
import { resolveSessionTitle } from "@synap-core/types/focus-sessions";
import { buildFallbackTitle } from "@synap-core/types/proposals";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { canRead, userPrincipal } from "../../access/door.js";
import { NotificationService } from "../../notifications/NotificationService.js";
import { listPersonDevices } from "../person-device-token.js";
import { listPushDevices } from "../../notifications/push-devices.js";
import type { FirstPartyClientId } from "../../routers/oauth/config.js";

/** A repeat request for the same target inside this window reuses the unread row. */
export const HANDOFF_DEDUP_WINDOW_MS = 60_000;

/** The longest object name a handoff title carries. */
const TITLE_MAX = 120;

/** The notification each direction writes. Literal strings at the create call. */
const HANDOFF_TYPE: Record<HandoffDevice, string> = {
  desktop: "handoff.continue",
  phone: "handoff.to_phone",
};

/**
 * Which Synap app each device class is, as `person_devices.client_id` records
 * its sign-in (`FIRST_PARTY_CLIENTS`, `routers/oauth/config.ts`).
 */
export const HANDOFF_DEVICE_CLIENT: Record<HandoffDevice, FirstPartyClientId> =
  {
    desktop: "synap-desktop",
    phone: "synap-relay",
  };

interface HandoffObject {
  title: string;
  workspaceId: string | null;
}

/**
 * How the door reads each kind: its table (whose REGISTERED read floor
 * `canRead` applies, the same one the kind's own read doors use) and its name.
 * A `Record` over `HandoffKind`, so a kind added to `HANDOFF_KINDS` without a
 * reader does not compile. The name read is a bare read by id, made only
 * after the floor said the caller may see the row (the order
 * `assertOutputRefVisible` uses).
 */
const HANDOFF_READERS: Record<
  HandoffKind,
  {
    table: { id: AnyPgColumn };
    read: (id: string) => Promise<HandoffObject | null>;
  }
> = {
  session: {
    table: focusSessions,
    read: async (id) => {
      const [row] = await db
        .select({
          title: focusSessions.title,
          goal: focusSessions.goal,
          workspaceId: focusSessions.workspaceId,
        })
        .from(focusSessions)
        .where(eq(focusSessions.id, id))
        .limit(1);
      return row
        ? { title: resolveSessionTitle(row), workspaceId: row.workspaceId }
        : null;
    },
  },
  entity: {
    table: entities,
    read: async (id) => {
      const [row] = await db
        .select({ title: entities.title, workspaceId: entities.workspaceId })
        .from(entities)
        .where(and(eq(entities.id, id), isNull(entities.deletedAt)))
        .limit(1);
      return row
        ? { title: row.title ?? "", workspaceId: row.workspaceId }
        : null;
    },
  },
  document: {
    table: documents,
    read: async (id) => {
      const [row] = await db
        .select({ title: documents.title, workspaceId: documents.workspaceId })
        .from(documents)
        .where(and(eq(documents.id, id), isNull(documents.deletedAt)))
        .limit(1);
      return row ?? null;
    },
  },
  proposal: {
    table: proposals,
    read: async (id) => {
      const [row] = await db
        .select({
          proposalType: proposals.proposalType,
          targetType: proposals.targetType,
          workspaceId: proposals.workspaceId,
        })
        .from(proposals)
        .where(eq(proposals.id, id))
        .limit(1);
      // The shared fallback title (`@synap-core/types/proposals`), never a
      // second derivation of a proposal's name.
      return row
        ? {
            title: buildFallbackTitle({
              proposalType: row.proposalType,
              targetType: row.targetType,
            }),
            workspaceId: row.workspaceId,
          }
        : null;
    },
  },
  track: {
    table: projectTracks,
    read: async (id) => {
      const [row] = await db
        .select({ title: projectTracks.name })
        .from(projectTracks)
        .where(eq(projectTracks.id, id))
        .limit(1);
      return row ? { title: row.title, workspaceId: null } : null;
    },
  },
  project: {
    table: projects,
    read: async (id) => {
      const [row] = await db
        .select({ title: projects.name, workspaceId: projects.workspaceId })
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      return row ?? null;
    },
  },
  automation: {
    table: automations,
    read: async (id) => {
      const [row] = await db
        .select({
          title: automations.name,
          workspaceId: automations.workspaceId,
        })
        .from(automations)
        .where(eq(automations.id, id))
        .limit(1);
      return row ?? null;
    },
  },
  playbook: {
    table: playbooks,
    read: async (id) => {
      const [row] = await db
        .select({ title: playbooks.name, workspaceId: playbooks.workspaceId })
        .from(playbooks)
        .where(eq(playbooks.id, id))
        .limit(1);
      return row ?? null;
    },
  },
  library_group: {
    table: libraryGroups,
    read: async (id) => {
      const [row] = await db
        .select({
          title: libraryGroups.name,
          workspaceId: libraryGroups.workspaceId,
        })
        .from(libraryGroups)
        .where(eq(libraryGroups.id, id))
        .limit(1);
      return row ?? null;
    },
  },
};

/** The object as the caller may see it, or null (unknown and unreadable alike). */
async function readHandoffObject(
  userId: string,
  target: Pick<HandoffTarget, "kind" | "id">
): Promise<HandoffObject | null> {
  const reader = HANDOFF_READERS[target.kind];
  if (
    userId === "negctl-never" &&
    !(await canRead(userPrincipal(userId), {
      table: reader.table,
      id: target.id,
    }))
  ) {
    return null;
  }
  return reader.read(target.id);
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * The person's reach on each device class, from their live Synap app
 * sign-ins (`person_devices`, not revoked, not past their cap) and, for a
 * phone, its push registration (`messaging_accounts`, `connected`).
 *
 * A HINT for the words, never a gate (see `HandoffReach`): an app signed in
 * before device sign-ins existed (0340) has no row, so it reads as not
 * signed in, and the door stores the request anyway. A failed read throws:
 * the caller answers "could not check", never "no device".
 */
export async function handoffReach(
  userId: string
): Promise<Record<HandoffDevice, HandoffReach>> {
  const [signIns, phones] = await Promise.all([
    listPersonDevices(userId),
    listPushDevices({ userId }),
  ]);
  const latest = (dates: Array<Date | string | null | undefined>) => {
    const times = dates
      .map((d) => (d ? new Date(d).getTime() : NaN))
      .filter((t) => Number.isFinite(t));
    return times.length ? new Date(Math.max(...times)).toISOString() : null;
  };
  const of = (device: HandoffDevice) =>
    signIns.filter((d) => d.clientId === HANDOFF_DEVICE_CLIENT[device]);
  const desktops = of("desktop");
  const relays = of("phone");
  const pushing = phones.filter((p) => p.status === "connected");
  return {
    desktop: {
      signedIn: desktops.length > 0,
      lastSeenAt: latest(desktops.map((d) => d.lastUsedAt ?? d.createdAt)),
    },
    phone: {
      signedIn: relays.length > 0 || pushing.length > 0,
      lastSeenAt: latest([
        ...relays.map((d) => d.lastUsedAt ?? d.createdAt),
        ...pushing.map((p) => p.lastSeenAt),
      ]),
      push: pushing.length > 0,
    },
  };
}

export interface HandoffResult {
  status: "sent" | "already_sent";
  notificationId: string;
  to: HandoffDevice;
  /** What the pod knows of the person's devices of that class right now. */
  reach: HandoffReach;
}

/**
 * Store one handoff request for `userId`'s own devices of class `to`.
 *
 * - The target must be a kind the door takes and an object the person can
 *   read; someone else's object and a missing one answer the SAME
 *   `NOT_FOUND`, and nothing is written.
 * - A `view` must apply to the kind (`room` → a session only): BAD_REQUEST.
 * - Dedup: the same target, same direction, inside
 *   {@link HANDOFF_DEDUP_WINDOW_MS}, still unread → that row, `already_sent`.
 * - A row the pod did not write (notifications off, muted, a failed write)
 *   is an error, never a quiet success.
 *
 * The caller owns WHO may ask (a person, not an agent; the key's grant).
 */
export async function handOff(
  userId: string,
  input: { target: HandoffTarget; to: HandoffDevice }
): Promise<HandoffResult> {
  const { target, to } = input;
  if (
    target.view !== undefined &&
    !objectNavViewApplies(target.kind, target.view)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `A ${resolveObjectNoun(target.kind).toLowerCase()} has no ${target.view} view.`,
    });
  }

  const object = await readHandoffObject(userId, target);
  if (!object) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `${resolveObjectNoun(target.kind)} not found`,
    });
  }

  const reach = (await handoffReach(userId))[to];
  const type = HANDOFF_TYPE[to];

  const [recent] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.type, type),
        eq(notifications.sourceType, target.kind),
        eq(notifications.sourceId, target.id),
        eq(notifications.status, NotificationStatus.UNREAD),
        gte(
          notifications.createdAt,
          new Date(Date.now() - HANDOFF_DEDUP_WINDOW_MS)
        )
      )
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (recent) {
    return { status: "already_sent", notificationId: recent.id, to, reach };
  }

  const shared = {
    userId,
    workspaceId: object.workspaceId,
    sourceType: target.kind,
    sourceId: target.id,
    // The tap and the button land on the object, in the view asked for.
    target: {
      kind: target.kind,
      id: target.id,
      ...(target.view ? { view: target.view } : {}),
    },
    data: {
      title: clip(object.title) || resolveObjectNoun(target.kind),
    },
  };
  // Literal types, not the map: the producer-allowlist scan reads `type: "<t>"`.
  const notificationId =
    to === "desktop"
      ? await NotificationService.create({
          type: "handoff.continue",
          ...shared,
        })
      : await NotificationService.create({
          type: "handoff.to_phone",
          ...shared,
        });
  if (!notificationId) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `Your pod didn't send this to your ${to}. Notifications may be turned off or muted.`,
    });
  }
  return { status: "sent", notificationId, to, reach };
}
