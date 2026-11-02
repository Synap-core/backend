/**
 * THE SESSION VERBS — what a person (or an agent) can do TO a session, declared
 * ONCE for every surface (plan d679e92c §C9).
 *
 * Before this module the set was decided per app: the browser kept a local
 * Pause / Resume map (`SessionRoomView.tsx` `STATUS_SWITCH_VERB`), Relay had no
 * lifecycle verb at all, and neither had Stop. A surface renders its ⋯ menu
 * from {@link sessionVerbsFor} and words each item with
 * {@link sessionVerbLabel}; it never keeps a list of its own.
 *
 *   pause    active → paused (a person stops it for now; it will run again).
 *   resume   paused or stale → active.
 *   stop     an open or stale session ends `cancelled`, through the ONE close
 *            door (`completeFocusSession`), which also stops its in-flight work.
 *   rerun    a NEW session `spawned_from` this run, from its stored sources. A
 *            closed run stays closed (`closedRunRefusal`): there is no reopen.
 *            Offered only when the session read says so (`rerun.available`,
 *            `assessRerunAvailability`), never re-derived here.
 *   wait_on  add a `session --blocked_by--> session` edge.
 *   release  drop that edge (stop waiting on that session).
 *
 * WORDS come from the vocabulary door (`resolveActionLabel`) in both moods:
 * imperative for the menu item ("Pause"), past for the receipt ("Paused").
 * `stop`, `wait_on` and `release` are keyed `session.*` there, so a bare
 * `stop` or `release` elsewhere keeps its own reading.
 *
 * DOORS: each verb names the door that runs it on every surface (tRPC for the
 * apps, MCP for agents, Hub REST for the CLI and other clients). `null` = that
 * surface has no door for it today. A backend tripwire
 * (`packages/api/src/__tripwires__/session-verb-doors.test.ts`) asserts every
 * named door exists, so this table can never point at a door that is gone.
 */
import type { VerbMood } from "../vocabulary/index.js";
import type { Locale } from "../i18n/locale.js";
import { resolveActionLabel } from "../vocabulary/index.js";
import { SESSION_STATUSES, type SessionStatus } from "./statuses.js";

/** The verbs, in the order a menu shows them. */
export const SESSION_VERBS = [
  "pause",
  "resume",
  "stop",
  "rerun",
  "wait_on",
  "release",
] as const;
export type SessionVerb = (typeof SESSION_VERBS)[number];

/** What a verb does to the session. */
export type SessionVerbEffect =
  /** `status` moves to `to` through the update door. */
  | { kind: "status"; to: "paused" | "active" }
  /** The session ends with `terminalStatus` through the one close door. */
  | { kind: "close"; terminalStatus: "cancelled" }
  /** A new session `spawned_from` this one; this one is untouched. */
  | { kind: "new_session"; link: "spawned_from" }
  /** A `blocked_by` edge from this session to another is added or dropped. */
  | { kind: "edge"; link: "blocked_by"; op: "add" | "remove" };

/** The door that runs a verb, per surface. `null` = no door there today. */
export interface SessionVerbDoors {
  /** tRPC procedure on the `focusSessions` router (Relay, the browser, apps). */
  trpc: string | null;
  /** MCP tool and the argument that carries the verb (agents). */
  mcp: { tool: string; arg: string } | null;
  /** Hub REST route under `/api/hub` (CLI, external clients). */
  hub: string | null;
}

export interface SessionVerbDeclaration {
  /** The vocabulary token the verb's words come from (`resolveActionLabel`). */
  action: string;
  /**
   * The stored statuses it is offered from. `rerun` lists every status and
   * is offered only when the read's `rerun.available` is true.
   */
  from: readonly SessionStatus[];
  effect: SessionVerbEffect;
  doors: SessionVerbDoors;
}

/** Open (not ended) statuses plus `stale`: what a session can still be. */
const LIVE: readonly SessionStatus[] = [
  "active",
  "paused",
  "forming",
  "scheduled",
  "stale",
];

export const SESSION_VERB_DECLARATION = {
  pause: {
    action: "pause",
    from: ["active"],
    effect: { kind: "status", to: "paused" },
    doors: {
      trpc: "update",
      mcp: { tool: "synap_update_session", arg: "status" },
      hub: "PATCH /focus-sessions/:id",
    },
  },
  resume: {
    action: "resume",
    from: ["paused", "stale"],
    effect: { kind: "status", to: "active" },
    doors: {
      trpc: "update",
      mcp: { tool: "synap_update_session", arg: "status" },
      hub: "PATCH /focus-sessions/:id",
    },
  },
  stop: {
    action: "session.stop",
    from: LIVE,
    effect: { kind: "close", terminalStatus: "cancelled" },
    doors: {
      trpc: "cancel",
      mcp: { tool: "synap_complete_session", arg: "terminalStatus" },
      hub: "POST /focus-sessions/:id/cancel",
    },
  },
  rerun: {
    action: "rerun",
    // Any status: whether it may run again is the read's `rerun.available`.
    from: SESSION_STATUSES,
    effect: { kind: "new_session", link: "spawned_from" },
    doors: {
      trpc: "rerun",
      mcp: { tool: "synap_rerun_session", arg: "mode" },
      hub: "POST /focus-sessions/:id/rerun",
    },
  },
  wait_on: {
    action: "session.wait_on",
    from: LIVE,
    effect: { kind: "edge", link: "blocked_by", op: "add" },
    doors: {
      trpc: "addBlocker",
      mcp: { tool: "synap_update_session", arg: "addBlockedBySessionIds" },
      // The generic edge door (`linkType: "blocked_by"`), same producer.
      hub: "POST /links",
    },
  },
  release: {
    action: "session.release",
    from: LIVE,
    effect: { kind: "edge", link: "blocked_by", op: "remove" },
    doors: {
      trpc: "removeBlocker",
      mcp: { tool: "synap_update_session", arg: "removeBlockedBySessionIds" },
      // Hub REST has no edge delete (only POST/GET /links).
      hub: null,
    },
  },
} as const satisfies Record<SessionVerb, SessionVerbDeclaration>;

/** A verb's words, through the vocabulary door. */
export function sessionVerbLabel(
  verb: SessionVerb,
  mood: VerbMood = "imperative",
  locale?: Locale
): string {
  return resolveActionLabel(
    SESSION_VERB_DECLARATION[verb].action,
    mood,
    locale
  );
}

/** What a surface knows about a session when it draws its verbs. */
export interface SessionVerbSubject {
  status: string | null | undefined;
  /**
   * The read's `rerun.available` (`assessRerunAvailability`). Anything but
   * `true` (false, unknown, a failed read) hides Rerun: a door that would
   * refuse is not offered.
   */
  rerunAvailable?: boolean | null;
}

/**
 * The verbs a session offers now, in menu order. Edge verbs (`wait_on`,
 * `release`) are offered by status only: which session to wait on, or which
 * edge to drop, is the surface's picker, and `release` belongs on an existing
 * edge's row.
 */
export function sessionVerbsFor(subject: SessionVerbSubject): SessionVerb[] {
  const status = subject.status;
  if (status == null) return [];
  return SESSION_VERBS.filter((verb) => {
    const decl: SessionVerbDeclaration = SESSION_VERB_DECLARATION[verb];
    if (!(decl.from as readonly string[]).includes(status)) return false;
    if (verb === "rerun") return subject.rerunAvailable === true;
    return true;
  });
}
