/**
 * A session's status, read at a glance and changed through its own doors —
 * PURE, so the draft rule, the moves per status and the door behind each move
 * are tested at the seam and the page only draws what this returns.
 *
 *   `sessionStatusMark` — the header mark: tone + glyph + the vocabulary's
 *       word. A DRAFT (`triage.pending`: an agent or an automation opened it
 *       and nobody has accepted it) is its own mark, whatever the stored
 *       status says — triage is derived, never stored (`services/
 *       focus-sessions/triage.ts`), so the pod projects it onto the row and
 *       this reads the projection, never origin + metadata by hand.
 *   `sessionMoves` — the status moves the viewer can make from here: ONE
 *       primary (the next move) and the rest for the overflow menu. Every move
 *       names the tRPC door that makes it; nothing here writes the status
 *       column.
 *
 * The doors, per move (`packages/api/src/routers/focus-sessions.ts`):
 *   accept   `acceptFromTriage`  — stamps the triage receipt, changes no
 *            status, and starts the run an agent HELD on the draft (B6).
 *   discard  `discardFromTriage` — the draft ends `cancelled` through the one
 *            close door; nothing is deleted.
 *   start    `update {status: active}` — opens an appointment (`scheduled`);
 *            `schedule-session.ts` names this the ordinary way one starts.
 *   pause    `update {status: paused}`.
 *   resume   `update {status: active}` — from `paused` or `stale`.
 *   close    `close` — `completeFocusSession`, the one close door.
 *   cancel   `cancel` — the close door with `cancelled`, stopping what is
 *            still in flight first.
 * A terminal session has no status move: no door reopens one.
 */

import {
  isSuspendedSessionStatus,
  isTerminalSessionStatus,
  type SessionStatus,
} from "@synap-core/types/focus-sessions";
import { getEnumTone } from "@synap-core/types/property-render";
import {
  resolveActionLabel,
  resolveProvenanceLabel,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import {
  statusKindForTone,
  statusPillFor,
} from "../../(admin)/components/status-tone";
import type { StatusKind } from "../../(admin)/components/status-pill";

// ─── The mark ────────────────────────────────────────────────────────────────

/** Which glyph the mark wears; the page maps each to its icon. */
export type SessionGlyph =
  "draft" | "moving" | "paused" | "scheduled" | "done" | "stopped" | "failed";

const GLYPH: Record<SessionStatus, SessionGlyph> = {
  active: "moving",
  forming: "moving",
  paused: "paused",
  stale: "paused",
  scheduled: "scheduled",
  closed: "done",
  cancelled: "stopped",
  failed: "failed",
};

export interface SessionStatusMark {
  kind: StatusKind;
  label: string;
  /** Null for a status this build does not know: the pill keeps its dot. */
  glyph: SessionGlyph | null;
  draft: boolean;
}

/** The fields the mark and the moves read off a `focusSessions.get` row. */
export interface SessionStatusFacts {
  status: string;
  triage?: { pending?: boolean | null } | null;
  /** `owner` | `member` — a member reads, never writes (decision C). */
  viewerRole?: string | null;
}

export function isDraft(s: SessionStatusFacts): boolean {
  return s.triage?.pending === true;
}

/**
 * The header mark. A draft reads "Drafted" in the tone of a `draft` (waiting
 * for a look), with the dashed glyph of something not yet started, so it can
 * never pass for the running session it may become.
 */
export function sessionStatusMark(
  s: SessionStatusFacts
): SessionStatusMark | null {
  if (isDraft(s)) {
    return {
      kind: statusKindForTone(getEnumTone("draft")),
      label: resolveStatusLabel("drafted"),
      glyph: "draft",
      draft: true,
    };
  }
  const pill = statusPillFor(s.status);
  if (!pill) return null;
  return {
    ...pill,
    glyph: Object.hasOwn(GLYPH, s.status)
      ? GLYPH[s.status as SessionStatus]
      : null,
    draft: false,
  };
}

// ─── The moves ───────────────────────────────────────────────────────────────

export type SessionMoveKey =
  "accept" | "discard" | "start" | "pause" | "resume" | "close" | "cancel";

/** The `focusSessions.*` procedure a move goes through. */
export type SessionDoor =
  "acceptFromTriage" | "discardFromTriage" | "update" | "close" | "cancel";

export interface SessionMove {
  key: SessionMoveKey;
  door: SessionDoor;
  /** The vocabulary's imperative ("Accept", "Pause"). */
  label: string;
  /** What the `update` door is asked to write; only on `update` moves. */
  toStatus?: "active" | "paused";
  /** Ends or discards work: asks first, through the shared confirm modal. */
  confirm: boolean;
}

const MOVES: Record<SessionMoveKey, Omit<SessionMove, "key" | "label">> = {
  accept: { door: "acceptFromTriage", confirm: false },
  discard: { door: "discardFromTriage", confirm: true },
  start: { door: "update", toStatus: "active", confirm: false },
  pause: { door: "update", toStatus: "paused", confirm: false },
  resume: { door: "update", toStatus: "active", confirm: false },
  close: { door: "close", confirm: true },
  cancel: { door: "cancel", confirm: true },
};

function move(key: SessionMoveKey): SessionMove {
  return { key, label: resolveActionLabel(key), ...MOVES[key] };
}

/** In motion and not yet ended — a person can pause it. */
export function canPause(status: string): boolean {
  return status === "active" || status === "forming";
}

/** Suspended (by a person or by the reaper) — a person can pick it up. */
export function canResume(status: string): boolean {
  return isSuspendedSessionStatus(status);
}

export interface SessionMoves {
  /** The next move: the header's one primary. */
  primary: SessionMove | null;
  /** Everything else, for the overflow menu. */
  more: SessionMove[];
}

const NONE: SessionMoves = { primary: null, more: [] };

/**
 * The moves from where the session stands:
 *   draft              → Accept · Discard (nothing else until it is decided)
 *   active / forming   → Close · Pause, Cancel
 *   paused / stale     → Resume · Close, Cancel
 *   scheduled          → Start · Cancel
 *   closed / cancelled / failed → none
 * A member of a shared session gets none: only its owner changes it.
 */
export function sessionMoves(s: SessionStatusFacts): SessionMoves {
  if (s.viewerRole !== "owner") return NONE;
  if (isDraft(s)) return { primary: move("accept"), more: [move("discard")] };
  if (isTerminalSessionStatus(s.status)) return NONE;
  if (canPause(s.status))
    return { primary: move("close"), more: [move("pause"), move("cancel")] };
  if (canResume(s.status))
    return { primary: move("resume"), more: [move("close"), move("cancel")] };
  if (s.status === "scheduled")
    return { primary: move("start"), more: [move("cancel")] };
  return NONE;
}

// ─── Who started it ──────────────────────────────────────────────────────────

export type SessionStarter =
  | { by: "agent"; id: string | null; name: string | null }
  | { by: "person"; you: boolean }
  | { by: "automation"; id: string | null }
  | { by: "playbook"; id: string | null };

export interface SessionOriginFacts {
  origin?: string | null;
  agentIds?: readonly string[] | null;
  /** The roster, names resolved by the pod ("Claude Code on devbox"). */
  participants?: ReadonlyArray<{ id: string; name: string }> | null;
  playbookId?: string | null;
  metadata?: unknown;
  viewerRole?: string | null;
}

/**
 * Who opened the session, from the row's typed `origin`. An agent is the
 * FIRST of `agentIds` — the create door puts the agent that starts a session
 * at the head of its roster — named by the roster the pod resolved (which
 * says the computer it runs on). Null when the row predates `origin`: no
 * guess.
 */
export function sessionStarter(s: SessionOriginFacts): SessionStarter | null {
  switch (s.origin) {
    case "agent": {
      const id = s.agentIds?.[0] ?? null;
      const name = id
        ? (s.participants?.find((p) => p.id === id)?.name ?? null)
        : null;
      return { by: "agent", id, name };
    }
    case "human":
      return { by: "person", you: s.viewerRole === "owner" };
    case "automation": {
      const meta = (s.metadata ?? {}) as { automationId?: unknown };
      return {
        by: "automation",
        id: typeof meta.automationId === "string" ? meta.automationId : null,
      };
    }
    case "playbook":
      return { by: "playbook", id: s.playbookId ?? null };
    default:
      return null;
  }
}

/** Whether accepting this draft starts a run an agent held on it (B6). */
export function holdsRun(metadata: unknown): boolean {
  const meta = (metadata ?? {}) as { heldRun?: unknown };
  return meta.heldRun != null;
}

/**
 * The header's sentence for a draft: who made it, and what accepting it
 * does. The mark already says "Drafted"; this says why it matters.
 */
export function draftSummary(
  starter: SessionStarter | null,
  heldRun: boolean
): string {
  const who =
    starter?.by === "agent"
      ? (starter.name ?? `An ${resolveProvenanceLabel("agent")}`)
      : starter?.by === "automation"
        ? "An automation"
        : "Someone else";
  return heldRun
    ? `${who} started this as a draft. Its run waits until you accept it.`
    : `${who} started this as a draft. Accept it to make it a real session, or discard it.`;
}

// ─── What it owes ────────────────────────────────────────────────────────────

export interface DeliverableRow {
  key: string;
  label: string;
  done: boolean;
}

/**
 * The session's declared deliverables (`expectedOutputs`, a JSONB list whose
 * SSOT is `ExpectedOutput` in `@synap/playbooks`). `done` is the pod's own
 * stamp (`status: "done"`); an agent's `claimedDone` is NOT delivery.
 */
export function deliverableRows(raw: unknown): DeliverableRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: DeliverableRow[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as { key?: unknown; label?: unknown; status?: unknown };
    if (typeof o.label !== "string" || !o.label.trim()) return;
    rows.push({
      key: typeof o.key === "string" && o.key ? o.key : `${i}`,
      label: o.label.trim(),
      done: o.status === "done",
    });
  });
  return rows;
}

export type CriterionVerdict = "pass" | "fail" | "unmeasured" | null;

export interface CriterionRow {
  key: string;
  statement: string;
  /** The CURRENT verdict (the pod picks it: a person's wins); null = not checked yet. */
  verdict: CriterionVerdict;
  required: boolean;
}

/** Criteria + the current evaluation per criterion → one row each. */
export function criterionRows(
  criteria: ReadonlyArray<{
    key: string;
    statement: string;
    required?: boolean;
  }>,
  evaluations: ReadonlyArray<{
    criterionKey: string;
    verdict: "pass" | "fail" | "unmeasured";
  }>
): CriterionRow[] {
  const byKey = new Map(evaluations.map((e) => [e.criterionKey, e.verdict]));
  return criteria.map((c) => ({
    key: c.key,
    statement: c.statement,
    verdict: byKey.get(c.key) ?? null,
    required: c.required !== false,
  }));
}

// ─── Its room ────────────────────────────────────────────────────────────────

/** The slice of the continuation packet's `room` section this reads. */
export type RoomSectionLike =
  | {
      status: "ok";
      channelId: string | null;
      items: ReadonlyArray<{
        id: string;
        at: string;
        author: "person" | "agent" | "teammate" | "system";
        agentUserId?: string;
        text: string;
      }>;
      hasMore: boolean;
    }
  | { status: "unavailable"; reason: string };

export type SessionRoom =
  /** No room: a true state (an appointment gets one when work starts). */
  | { state: "none" }
  /** The room could not be read — never drawn as an empty room. */
  | { state: "failed"; channelId: string | null }
  | {
      state: "ok";
      channelId: string;
      /** When the newest message landed; null in a room nobody wrote in. */
      lastAt: string | null;
      latest: { author: string; text: string } | null;
    };

/** Who wrote a room message, in words, for this viewer. */
export function roomAuthorName(
  m: { author: string; agentUserId?: string },
  participants: ReadonlyArray<{ id: string; name: string }>,
  viewerIsOwner: boolean
): string {
  switch (m.author) {
    case "person":
      return viewerIsOwner ? "You" : resolveProvenanceLabel("human");
    case "agent":
      return (
        participants.find((p) => p.id === m.agentUserId)?.name ??
        resolveProvenanceLabel("agent")
      );
    case "teammate":
      return resolveProvenanceLabel("human");
    default:
      return resolveProvenanceLabel("system");
  }
}

/**
 * The room as the session page draws it. The packet's `room` is read with
 * the room's own visibility gate, so a room the viewer cannot see comes back
 * `unavailable` — drawn as a failure, with the room's id kept so its door
 * still opens (the room page answers for itself).
 */
export function sessionRoom(
  room: RoomSectionLike | null | undefined,
  channelId: string | null,
  participants: ReadonlyArray<{ id: string; name: string }>,
  viewerIsOwner: boolean
): SessionRoom {
  if (!room || room.status !== "ok") {
    return channelId ? { state: "failed", channelId } : { state: "none" };
  }
  const id = room.channelId ?? channelId;
  if (!id) return { state: "none" };
  const newest = room.items[0] ?? null;
  return {
    state: "ok",
    channelId: id,
    lastAt: newest?.at ?? null,
    latest: newest
      ? {
          author: roomAuthorName(newest, participants, viewerIsOwner),
          text: newest.text,
        }
      : null,
  };
}

// ─── What a move reports back ────────────────────────────────────────────────

/** A line under the header after a move, when the new mark alone is not the whole story. */
export interface MoveNotice {
  text: string;
  warning: boolean;
}

const ALREADY_DECIDED: MoveNotice = {
  text: "This draft was already decided.",
  warning: false,
};

/**
 * What the door answered, in words — only what the status mark cannot say:
 * a race lost (`not_pending`), a held run that did or did not start, the
 * proposals a discard withdrew, a close's warning.
 */
export function moveNotice(
  door: SessionDoor,
  result: unknown
): MoveNotice | null {
  const r = (result ?? {}) as {
    accepted?: boolean;
    discarded?: boolean;
    heldRun?: { status?: string };
    expiredEphemerals?: number;
    warnings?: unknown;
  };
  switch (door) {
    case "acceptFromTriage":
      if (r.accepted === false) return ALREADY_DECIDED;
      if (r.heldRun?.status === "started")
        return { text: "Accepted. Its run has started.", warning: false };
      if (r.heldRun?.status === "failed")
        return {
          text: "Accepted, but its run could not be started.",
          warning: true,
        };
      return null;
    case "discardFromTriage": {
      if (r.discarded === false) return ALREADY_DECIDED;
      const n = r.expiredEphemerals ?? 0;
      return n > 0
        ? {
            text: `Discarded. ${n} ${n === 1 ? "change it proposed was" : "changes it proposed were"} withdrawn.`,
            warning: false,
          }
        : null;
    }
    case "close":
    case "cancel": {
      const first = Array.isArray(r.warnings) ? r.warnings[0] : undefined;
      return typeof first === "string" && first
        ? { text: first, warning: true }
        : null;
    }
    default:
      return null;
  }
}
