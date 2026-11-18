/**
 * THE SESSION ROOM MODEL — what every app draws when it shows a session's
 * room (plan efb315a5, contract of session 44c56edc): which questions the
 * session still owes the person, the ONE order of messages and questions,
 * who works the session, and the delivery mark on a person's message.
 *
 * A model, not a widget: the kit (shadcn, every generated app) and the
 * browser (spatial-ui) each render it, so no surface forks the rule. Pure:
 * no import, no I/O, no clock (`now` is a parameter). The kit vendors this
 * file byte-identical until the published package replaces it, which is why
 * it imports nothing, not even from this package.
 */

/** A slot as the pod ships it on focus_sessions.expectedOutputs (only the fields the room reads). */
export interface RoomSlot {
  key?: string;
  label: string;
  /** 'human' = the person owes it. */
  owner?: string | null;
  /** 'done' = met. */
  status?: string | null;
  /** Set (any value, `""` included) = retired. */
  retiredAt?: string | null;
  /** Only a real `true` makes it optional. */
  optional?: boolean | null;
  /** The slot's kind (`criterion` = a grade slot, never decided by an answer). */
  kind?: string | null;
  criterionKey?: string | null;
  /** The decision the person's answer filed. */
  decisionId?: string | null;
  why?: string | null;
  ask?:
    | ({
        mode?: string;
        prompt?: string;
        options?: Array<{
          label: string;
          value?: string;
          recommended?: boolean;
        }>;
      } & Record<string, unknown>)
    | null;
  /** ISO. */
  owedSince?: string | null;
  answer?:
    | ({
        value?: unknown;
        text?: string | null;
        answeredAt?: string | null;
        answeredBy?: string | null;
        messageId?: string | null;
        askSnapshot?: { mode?: string } | null;
      } & Record<string, unknown>)
    | null;
}

/** A room message, as the app already has it, plus what the pod stamps. */
export interface RoomMessageLike {
  id: string;
  /** ISO. */
  createdAt: string;
  /** The session owner / a person wrote it. */
  authorIsPerson: boolean;
  /** `metadata.roomPost`. */
  roomPost?: { kind?: string; slotLabel?: string | null } | null;
  /** The pod stamps it on an owner message the agent consumed. */
  seenByAgentAt?: string | null;
}

/** The ask modes whose answer files a decision (`DECIDING_ASK_MODES`). */
const DECIDING_MODES: readonly string[] = ["confirm", "choose"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Decided by the person's answer: a copy of `isDecidedByAnswer`
 * (`@synap-core/types/units`), kept here so this file imports nothing.
 */
function decidedByAnswer(slot: RoomSlot): boolean {
  if (typeof slot.decisionId !== "string" || slot.decisionId === "") {
    return false;
  }
  if (slot.kind === "criterion") return false;
  if (typeof slot.criterionKey === "string" && slot.criterionKey !== "") {
    return false;
  }
  const answer = slot.answer;
  if (!isRecord(answer)) return false;
  if (isRecord(answer.value) && answer.value.type === "declined") return false;
  const snapshot = answer.askSnapshot;
  return isRecord(snapshot) && DECIDING_MODES.includes(snapshot.mode as string);
}

/** Still owed at all: a copy of `isDeliverableOutstanding`. */
function outstanding(slot: RoomSlot): boolean {
  return (
    slot.status !== "done" &&
    !decidedByAnswer(slot) &&
    !slot.retiredAt &&
    slot.optional !== true
  );
}

const labelled = (slot: RoomSlot): boolean =>
  typeof slot.label === "string" && slot.label.trim() !== "";

/**
 * "This question is still open for the person": the pod's owed rule,
 * `deliverableOwedBy(slot) === "you"` (`@synap-core/types/units`), on a slot
 * with a label. Copied rather than imported (the kit vendors this file); the
 * parity test in `index.test.ts` holds the copy to the original.
 */
export function isOpenQuestion(slot: RoomSlot): boolean {
  return slot.owner === "human" && outstanding(slot) && labelled(slot);
}

/** A slot the person answered (its answer stamp), not open any more. */
function isAnsweredQuestion(slot: RoomSlot): boolean {
  return (
    !isOpenQuestion(slot) &&
    slot.retiredAt == null &&
    slot.optional !== true &&
    labelled(slot) &&
    !!(slot.answer && slot.answer.answeredAt)
  );
}

/**
 * Questions to draw: open + answered (answered ones fold to a line), retired
 * and optional ones left out. In the slots' own order.
 */
export function roomQuestions(
  slots: readonly RoomSlot[]
): Array<{ slot: RoomSlot; state: "open" | "answered" }> {
  const out: Array<{ slot: RoomSlot; state: "open" | "answered" }> = [];
  for (const slot of slots) {
    if (!slot || typeof slot !== "object") continue;
    if (isOpenQuestion(slot)) out.push({ slot, state: "open" });
    else if (isAnsweredQuestion(slot)) out.push({ slot, state: "answered" });
  }
  return out;
}

export type RoomItem<M extends RoomMessageLike> =
  | { kind: "message"; at: string; message: M }
  | {
      kind: "question";
      at: string;
      slot: RoomSlot;
      state: "open" | "answered";
      anchorMessageId: string | null;
    };

/** Is this message the room question filed on `label`? */
function asksAbout(message: RoomMessageLike, label: string): boolean {
  return (
    message.roomPost?.kind === "question" &&
    typeof message.roomPost.slotLabel === "string" &&
    message.roomPost.slotLabel === label
  );
}

/**
 * Messages and questions in ONE order.
 *  - A question whose room question message exists (roomPost.kind ===
 *    'question' && roomPost.slotLabel === slot.label) is drawn AT that
 *    message: the message item is replaced by the question item
 *    (anchorMessageId = its id, at = its createdAt). When the agent asked
 *    the same slot more than once, the NEWEST such message anchors it (the
 *    ask that stands); the older ones stay messages.
 *  - Otherwise at slot.owedSince; with no owedSince (or one that is not a
 *    time), after every message (`at` = the last message's time, or '' in an
 *    empty room).
 *  - Sort by `at` ascending; equal `at`: a question before a message;
 *    otherwise input order (stable).
 */
export function roomTimeline<M extends RoomMessageLike>(
  messages: readonly M[],
  slots: readonly RoomSlot[]
): RoomItem<M>[] {
  type Keyed = { item: RoomItem<M>; t: number; order: number };
  const keyed: Keyed[] = [];
  const anchored = new Map<string, Keyed["item"]>();
  let order = 0;

  const questions = roomQuestions(slots);
  for (const q of questions) {
    let anchor: M | null = null;
    for (const m of messages) {
      if (asksAbout(m, q.slot.label)) anchor = m;
    }
    if (anchor && !anchored.has(anchor.id)) {
      anchored.set(anchor.id, {
        kind: "question",
        at: anchor.createdAt,
        slot: q.slot,
        state: q.state,
        anchorMessageId: anchor.id,
      });
    }
  }

  let lastAt = "";
  let lastT = Number.NEGATIVE_INFINITY;
  for (const m of messages) {
    const t = Date.parse(m.createdAt);
    if (Number.isFinite(t) && t >= lastT) {
      lastT = t;
      lastAt = m.createdAt;
    }
    const replaced = anchored.get(m.id);
    keyed.push({
      item: replaced ?? { kind: "message", at: m.createdAt, message: m },
      t: Number.isFinite(t) ? t : Number.POSITIVE_INFINITY,
      order: order++,
    });
  }

  const placed = new Set<RoomSlot>(
    [...anchored.values()].flatMap((i) =>
      i.kind === "question" ? [i.slot] : []
    )
  );
  for (const q of questions) {
    if (placed.has(q.slot)) continue;
    const owed = q.slot.owedSince ? Date.parse(q.slot.owedSince) : NaN;
    const timed = Number.isFinite(owed);
    keyed.push({
      item: {
        kind: "question",
        at: timed ? q.slot.owedSince! : lastAt,
        slot: q.slot,
        state: q.state,
        anchorMessageId: null,
      },
      t: timed ? owed : Number.POSITIVE_INFINITY,
      order: order++,
    });
  }

  keyed.sort((a, b) => {
    if (a.t !== b.t) return a.t < b.t ? -1 : 1;
    const qa = a.item.kind === "question" ? 0 : 1;
    const qb = b.item.kind === "question" ? 0 : 1;
    if (qa !== qb) return qa - qb;
    return a.order - b.order;
  });
  return keyed.map((k) => k.item);
}

/** Who works the session, from GET /focus-sessions/:id `holder` (SessionHolder) and `runners`. */
export type AgentLine =
  /** A live runner busy / a pod agent mid-turn. */
  | {
      state: "working";
      name: string;
      computer: string | null;
      since: string | null;
    }
  /** Live, idle: it will get messages. */
  | {
      state: "reachable";
      name: string;
      computer: string | null;
      lastSeenAt: string | null;
    }
  /** A known agent, not live (e.g. Claude Code closed). */
  | {
      state: "unreachable";
      name: string;
      computer: string | null;
      lastSeenAt: string | null;
    }
  /** Nothing runs it: messages wait. */
  | { state: "nobody"; name: null; computer: null }
  /** The read did not say (never folded into 'nobody'). */
  | { state: "unknown" };

/** A runner counts live within this long of its `lastSeenAt`. */
export const ROOM_RUNNER_LIVE_MS = 150_000;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v : null;

/** The SessionHolder itself, from a bare holder or its `{status:'ok', holder}` section. */
function holderOf(holder: unknown): Obj | null {
  const h = obj(holder);
  if (!h) return null;
  if (typeof h.status === "string") {
    return h.status === "ok" ? obj(h.holder) : null;
  }
  return typeof h.kind === "string" ? h : null;
}

/** The runner items, from a bare list or an `{status:'ok', items}` section; `null` = unread. */
function runnerItems(runners: unknown): Obj[] | null {
  const objs = (list: unknown[]): Obj[] =>
    list.map(obj).filter((o): o is Obj => o !== null);
  if (Array.isArray(runners)) return objs(runners);
  const r = obj(runners);
  if (r && r.status === "ok" && Array.isArray(r.items)) return objs(r.items);
  return null;
}

function runnerLive(runner: Obj, now: Date): boolean {
  if (runner.state === "ended") return false;
  const seen = str(runner.lastSeenAt);
  if (!seen) return false;
  const t = Date.parse(seen);
  return Number.isFinite(t) && now.getTime() - t <= ROOM_RUNNER_LIVE_MS;
}

const newest = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
};

/**
 * Who works the session. Reads the SessionHolder / session_runners fields
 * defensively (unknown in, typed out):
 *  - no readable holder → 'unknown';
 *  - the holder says nobody, or names no agent → 'nobody';
 *  - the holder's word is `agent_work`, or a live runner of its agent is
 *    `busy` → 'working';
 *  - a live runner of its agent (within ROOM_RUNNER_LIVE_MS) → 'reachable';
 *  - a pod-run or dispatched agent something serves (the pod wakes it on a
 *    message) → 'reachable';
 *  - else (an agent on a computer nothing runs now) → 'unreachable'.
 */
export function agentLineOf(
  holder: unknown,
  runners: unknown,
  now: Date
): AgentLine {
  const h = holderOf(holder);
  if (!h) return { state: "unknown" };
  const agent = obj(h.agent);
  if (h.kind === "nobody" || !agent) {
    return { state: "nobody", name: null, computer: null };
  }
  const agentUserId = str(agent.agentUserId);
  const name =
    str(agent.name) ??
    str(agent.displayName) ??
    str(agent.agentType) ??
    "Agent";
  const computer = str(obj(agent.computer)?.name);

  const own = (runnerItems(runners) ?? []).filter(
    (r) => !agentUserId || !str(r.agentUserId) || r.agentUserId === agentUserId
  );
  const holderRunner = obj(h.runner);
  const candidates = holderRunner ? [holderRunner, ...own] : own;
  const live = candidates
    .filter((r) => runnerLive(r, now))
    .sort(
      (a, b) =>
        Date.parse(str(b.lastSeenAt) ?? "") -
        Date.parse(str(a.lastSeenAt) ?? "")
    );
  const busy = live.find((r) => r.state === "busy");

  if (h.waitKind === "agent_work" || busy) {
    return {
      state: "working",
      name,
      computer,
      since: str(busy?.stateSince) ?? str(h.since),
    };
  }
  if (live[0]) {
    return {
      state: "reachable",
      name,
      computer,
      lastSeenAt: str(live[0].lastSeenAt),
    };
  }
  const servedAt = str(agent.servedAt);
  if (
    agent.nobodyRuns !== true &&
    (agent.reach === "pod" || agent.reach === "dispatch")
  ) {
    return { state: "reachable", name, computer, lastSeenAt: servedAt };
  }
  let lastSeenAt: string | null = servedAt;
  for (const r of candidates)
    lastSeenAt = newest(lastSeenAt, str(r.lastSeenAt));
  return { state: "unreachable", name, computer, lastSeenAt };
}

/** A person's message's delivery mark. null = not a person's message. */
export type Delivery = "sent" | "seen" | "waiting";

export function deliveryOf(
  message: RoomMessageLike,
  agent: AgentLine
): Delivery | null {
  if (!message.authorIsPerson) return null;
  if (message.seenByAgentAt) return "seen";
  if (agent.state === "unreachable" || agent.state === "nobody") {
    return "waiting";
  }
  return "sent";
}
