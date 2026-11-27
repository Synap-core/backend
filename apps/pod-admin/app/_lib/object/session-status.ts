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
  closedNotDoneRecorded,
  isPlannedSessionStatus,
  isSuspendedSessionStatus,
  isTerminalSessionStatus,
} from "@synap-core/types/focus-sessions";
import { getEnumTone } from "@synap-core/types/property-render";
import {
  deriveSlotKeys,
  isDeliverableDelivered,
  statusMark,
  type DeliverableFacts,
  type StatusGlyph,
} from "@synap-core/types/units";
import {
  humanizeToken,
  resolveActionLabel,
  resolveProvenanceLabel,
  resolveStatusLabel,
} from "@synap-core/types/vocabulary";
import {
  machinePill,
  statusKindForTone,
  statusMarkPill,
} from "../../(admin)/components/status-tone";
import type { StatusKind } from "../../(admin)/components/status-pill";

// ─── The mark ────────────────────────────────────────────────────────────────

/** Which glyph the mark wears (`statusMark`'s, or a draft's); the page maps each to its icon. */
export type SessionGlyph = StatusGlyph | "draft";

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
  /** Holds the close door's not-done record when it closed with work open. */
  verificationReport?: unknown;
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
  const mark = statusMark("session", s.status, {
    closedNotDone: closedNotDoneRecorded(s.verificationReport),
  });
  if (!mark) return null;
  return {
    ...statusMarkPill(mark),
    // An undeclared word keeps the pill's dot.
    glyph: mark.category ? mark.glyph : null,
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

/**
 * In motion and not yet ended — a person can pause it. A planned step
 * (`forming`) has not started: it is started, like an appointment (P1).
 */
export function canPause(status: string): boolean {
  return status === "active";
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
 *   active             → Close · Pause, Cancel
 *   paused / stale     → Resume · Close, Cancel
 *   scheduled / forming → Start · Cancel (not started: an appointment, a
 *                        planned step)
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
  if (s.status === "scheduled" || isPlannedSessionStatus(s.status))
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

/**
 * Where a deliverable lives — its declared `ref` (`OutputRef` in
 * `@synap/playbooks`: ONE union, two arms): a page outside the pod (a pull
 * request, a deploy) or an object in it. The page draws the first through
 * `publisherExit` (https only) and the second through `objectPage`.
 */
export type DeliverableDoor = { url: string } | { kind: string; id: string };

export interface DeliverableRow {
  key: string;
  label: string;
  done: boolean;
  /** Its `ref`, a door; null when it declares none. */
  door: DeliverableDoor | null;
}

function deliverableDoor(ref: unknown): DeliverableDoor | null {
  if (!ref || typeof ref !== "object") return null;
  const r = ref as { url?: unknown; kind?: unknown; id?: unknown };
  if (typeof r.url === "string" && r.url.trim()) return { url: r.url.trim() };
  if (typeof r.kind === "string" && r.kind && typeof r.id === "string" && r.id)
    return { kind: r.kind, id: r.id };
  return null;
}

/**
 * The session's declared deliverables (`expectedOutputs`, a JSONB list whose
 * SSOT is `ExpectedOutput` in `@synap/playbooks`). `done` is THE delivered
 * rule (`isDeliverableDelivered`): the pod's own stamp (`status: "done"`), or a
 * confirm / choose the person answered whose decision the pod filed. An
 * agent's `claimedDone` is NOT delivery. `key` is THE slot key
 * (`deriveSlotKeys`: the stored one, else the one the pod would stamp), so a
 * lane's `forOutput` and a criterion's `outputKey` find their row by it.
 */
export function deliverableRows(raw: unknown): DeliverableRow[] {
  if (!Array.isArray(raw)) return [];
  const keys = deriveSlotKeys(raw);
  const rows: DeliverableRow[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== "object") return;
    const o = item as DeliverableFacts & {
      key?: unknown;
      label?: unknown;
      ref?: unknown;
    };
    if (typeof o.label !== "string" || !o.label.trim()) return;
    rows.push({
      key: keys[i] ?? `${i}`,
      label: o.label.trim(),
      done: isDeliverableDelivered(o),
      door: deliverableDoor(o.ref),
    });
  });
  return rows;
}

/**
 * Which lanes deliver which output (W7): each child spawned FOR one of this
 * session's outputs (`forOutput`, from the packet's `children`), grouped by
 * that output's key. The packet carries the first few children only; a lane
 * past that cut is named on its own page, not here.
 */
export function outputLanes(
  children: SessionChildren
): ReadonlyMap<string, LineageRow[]> {
  const byKey = new Map<string, LineageRow[]>();
  if (children.state !== "ok") return byKey;
  for (const row of children.rows) {
    if (!row.forOutput) continue;
    const list = byKey.get(row.forOutput) ?? [];
    list.push(row);
    byKey.set(row.forOutput, list);
  }
  return byKey;
}

/**
 * The name of the parent output a lane fills: the label the pod named on the
 * packet (`forOutputLabel`), else the deliverable's own label (a row read
 * without it), else its key in words (an output since withdrawn) — never the
 * raw key. Null for a child spawned for no output.
 */
export function fillsOutputLabel(
  row: Pick<LineageRow, "forOutput" | "forOutputLabel">,
  deliverables: ReadonlyArray<Pick<DeliverableRow, "key" | "label">>
): string | null {
  if (!row.forOutput) return null;
  return (
    row.forOutputLabel ??
    deliverables.find((d) => d.key === row.forOutput)?.label ??
    (humanizeToken(row.forOutput) || null)
  );
}

/**
 * What the session made (`focusSessions.outputs`), as the page draws it:
 * nothing yet and a failed read are two facts. A failed read is a section
 * with its retry, never an omitted one (an EMPTY result and a FAILED read are
 * different facts). Still loading draws nothing, as before.
 */
export type MadeSection<T> =
  { state: "none" } | { state: "failed" } | { state: "ok"; items: T[] };

export function madeSection<T>(read: {
  error: unknown;
  data?: { outputs: T[] } | null;
}): MadeSection<T> {
  if (read.error) return { state: "failed" };
  const items = read.data?.outputs ?? [];
  return items.length > 0 ? { state: "ok", items } : { state: "none" };
}

/** The fields of the pod's session verdict (`SessionVerdict`) a mark reads. */
export interface SessionVerdictLike {
  passed: number;
  total: number;
  state: string;
}

/**
 * A session's criteria verdict as ONE mark — the review's session strip, the
 * Sessions list and the session page all draw it from here. Three copies had
 * drifted ("Criteria failing" · "2 of 3 met" · "2 of 3 criteria met", amber
 * vs red for the same state). The tone is the status palette (met → healthy,
 * a required criterion failed → down, some not checked yet → stale); the count
 * is the pod's own verdict, never recounted; `state` is the vocabulary's word
 * for the whole grade ("Not yet met"), carried as the mark's accessible name.
 * Null when the session declares no criteria.
 */
export function criteriaVerdictMark(
  v: SessionVerdictLike | null | undefined
): { kind: StatusKind; label: string; state: string } | null {
  if (!v || v.total === 0 || v.state === "none") return null;
  return {
    kind:
      v.state === "passing"
        ? "healthy"
        : v.state === "failing"
          ? "down"
          : "stale",
    label: `${v.passed} of ${v.total} ${v.total === 1 ? "criterion" : "criteria"} met`,
    state: resolveStatusLabel(v.state),
  };
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

/**
 * The criteria a session page's rail grades in place (layout A, founder
 * 2026-10-28): the ones its capped list shows before "Show all". Needs you
 * leaves exactly these out, so a criterion past the cap keeps its grade where
 * the reader sees it, and none is drawn twice.
 */
export function railGradedKeys(
  rows: ReadonlyArray<Pick<CriterionRow, "key">>,
  shown: number
): ReadonlySet<string> {
  return new Set(rows.slice(0, shown).map((r) => r.key));
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

// ─── Where it came from and what it spawned ──────────────────────────────────

/** One linked session, as the continuation packet names it (`PacketChildItem`). */
interface LinkedSessionLike {
  id: string;
  title: string;
  status: string;
  statusLabel?: string;
  /** How it ended (`sessionClosedAs`), when the packet says. */
  closedAs?: string | null;
  /** The parent output it was spawned to deliver (W7), on a child. */
  forOutput?: string | null;
  /** That output's label on the parent, as the pod named it. */
  forOutputLabel?: string | null;
}

/** A linked session as a row: its name, its status mark, its id for the door. */
export interface LineageRow {
  key: string;
  id: string;
  title: string;
  mark: { kind: StatusKind; label: string } | null;
  /** The parent output key it delivers (a lane, W7); null otherwise. */
  forOutput: string | null;
  /** That output's label as the pod named it; null when it did not. */
  forOutputLabel: string | null;
}

export type SessionParent =
  { state: "none" } | { state: "failed" } | { state: "ok"; row: LineageRow };

export type SessionChildren =
  | { state: "none" }
  | { state: "failed" }
  /** `rows` are the packet's first few; `total` counts every child. */
  | { state: "ok"; rows: LineageRow[]; total: number };

export function lineageRow(s: LinkedSessionLike): LineageRow {
  return {
    key: s.id,
    id: s.id,
    title: s.title.trim() || "Untitled session",
    mark: machinePill("session", s.status, {
      closedNotDone: s.closedAs === "not_done",
    }),
    forOutput: s.forOutput?.trim() || null,
    forOutputLabel: s.forOutputLabel?.trim() || null,
  };
}

/**
 * The session it was spawned from (`this --spawned_from--> parent`). No parent
 * and a failed read are two facts: the first draws nothing, the second says so.
 */
export function sessionParent(
  section:
    | { status: "ok"; session: LinkedSessionLike | null }
    | { status: "unavailable"; reason?: string }
    | null
    | undefined
): SessionParent {
  if (!section) return { state: "none" };
  if (section.status !== "ok") return { state: "failed" };
  return section.session
    ? { state: "ok", row: lineageRow(section.session) }
    : { state: "none" };
}

/**
 * The sessions it spawned (`child --spawned_from--> this`). The packet sends
 * the first few and the exact `total`; the rest are read on "Show all"
 * (`focusSessions.browse` with `parentSessionId`). None is OMITTED; a failed
 * read is drawn as one, never as "no sub-sessions".
 */
export function sessionChildren(
  section:
    | { status: "ok"; total: number; items: LinkedSessionLike[] }
    | { status: "unavailable"; reason?: string }
    | null
    | undefined
): SessionChildren {
  if (!section) return { state: "none" };
  if (section.status !== "ok") return { state: "failed" };
  if (section.total === 0 && section.items.length === 0)
    return { state: "none" };
  return {
    state: "ok",
    rows: section.items.map(lineageRow),
    total: Math.max(section.total, section.items.length),
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
