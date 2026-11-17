/**
 * What a `:::synap-ask{sessionId slot}` embed knows about its question, from
 * the viewer's own `focusSessions.get`. PURE: `embed-ask` draws it. A slot is
 * found as the answer door finds it (key first, then trimmed + casefolded
 * label), and the matched slot's KEY is what the card answers with.
 */
import { askSlotStanding } from "@synap-core/types/ask";
import { deriveSlotKeys, normalizeSlotLabel } from "@synap-core/types/units";
import {
  askSlotOf,
  type AskSlot,
  type AskSlotSignal,
} from "../../../(admin)/review/_lib/ask-detail";
import type { AskSettleKind } from "../../../(admin)/review/_lib/ask-answer";
import { HIDDEN_CODES } from "./markdown-model";

export type EmbedAskRead =
  | { state: "unresolved" }
  | { state: "loading" }
  | { state: "failed"; retry?: () => void; retrying: boolean }
  | { state: "hidden" }
  | { state: "closed" }
  | { state: "elsewhere" }
  | {
      state: "open";
      slot: AskSlot;
      /** Only the session's owner answers; a member reads. */
      canAnswer: boolean;
      /** When this read landed: an answer given before it is superseded. */
      readAt: number;
      /** The work the question comes from, named above the card. */
      session: { id: string; title: string | null; status: string | null };
    }
  | { state: "answered"; answer: string | null; attested: boolean };

type StoredSlot = Record<string, unknown>;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

function standingOf(o: StoredSlot) {
  return askSlotStanding({
    owner: o.owner as "human" | "agent" | null | undefined,
    status: str(o.status),
    retiredAt: str(o.retiredAt),
    attestedAt: str(o.attestedAt),
    answer: (o.answer ?? null) as { text?: string | null } | null,
  });
}

/**
 * The door's rule (`findSlotIndex`): a KEY across every slot first, then the
 * LABEL. Several slots sharing a label: the owed one; if that does not settle
 * it the reference is `ambiguous`, never a guess. The slot's key rides along.
 */
export function findAskSlot(
  outputs: unknown,
  ref: string
): { slot: StoredSlot; key: string } | "ambiguous" | null {
  if (!Array.isArray(outputs)) return null;
  const wanted = ref.trim();
  if (!wanted) return null;
  const keys = deriveSlotKeys(outputs);
  const pick = (i: number) => ({
    slot: outputs[i] as StoredSlot,
    key: keys[i]!,
  });
  const byKey = keys.indexOf(wanted);
  if (byKey !== -1) return pick(byKey);
  const label = normalizeSlotLabel(wanted);
  const same = outputs.flatMap((raw, i) =>
    raw &&
    typeof raw === "object" &&
    normalizeSlotLabel(str((raw as StoredSlot).label)) === label
      ? [i]
      : []
  );
  if (same.length <= 1) return same.length ? pick(same[0]!) : null;
  const owed = same.filter(
    (i) => standingOf(outputs[i] as StoredSlot) === "owed"
  );
  return owed.length === 1 ? pick(owed[0]!) : "ambiguous";
}

export function askEmbedRead(
  query: {
    isLoading: boolean;
    isFetching?: boolean;
    error: { data?: { code?: string | null } | null } | null | undefined;
    data: unknown;
    dataUpdatedAt?: number;
    retry?: () => void;
  },
  ref: { sessionId: string; slot: string }
): EmbedAskRead {
  const failed = (): EmbedAskRead => ({
    state: "failed",
    ...(query.retry ? { retry: query.retry } : {}),
    retrying: query.isFetching === true,
  });
  if (query.error) {
    const code = query.error.data?.code;
    // A signed-out reader is not "not visible": that one is a failed read.
    return code && code !== "UNAUTHORIZED" && HIDDEN_CODES.has(code)
      ? { state: "hidden" }
      : failed();
  }
  if (query.isLoading) return { state: "loading" };
  const session = query.data as
    | {
        title?: unknown;
        status?: unknown;
        expectedOutputs?: unknown;
        viewerRole?: unknown;
        participants?: unknown;
      }
    | null
    | undefined;
  // An answer with no readable shape is a broken read, never "no question".
  if (!session || typeof session !== "object") return failed();
  const found = findAskSlot(session.expectedOutputs, ref.slot);
  if (!found || found === "ambiguous") return { state: "hidden" };
  const { slot: stored, key } = found;

  switch (standingOf(stored)) {
    case "attested":
      return { state: "answered", answer: null, attested: true };
    case "answered":
      return {
        state: "answered",
        answer: str((stored.answer as { text?: unknown }).text),
        attested: false,
      };
    case "gone":
      return { state: "closed" };
    case "owed": {
      const asker = (
        Array.isArray(session.participants) ? session.participants : []
      ).find((p: { id?: unknown }) => p?.id === stored.askedBy) as
        { id: string; name: string } | undefined;
      const title = str(session.title);
      const slot = askSlotOf({
        ...stored,
        kind: "owed-slot",
        title: str(stored.label) ?? "",
        slotKind: str(stored.kind),
        occurredAt: str(stored.owedSince),
        target: { kind: "session", id: ref.sessionId },
        sessionTitle: title,
        by: asker ? { id: asker.id, label: asker.name } : null,
      } as unknown as AskSlotSignal);
      // A hand-over (secret, connection, file) keeps its own panel (what
      // became of it, take it back), which resolves the slot by LABEL: it is
      // answered on the work's page, never inline.
      return slot && slot.ask?.mode !== "provide"
        ? {
            state: "open",
            slot: { ...slot, slotKey: key },
            canAnswer: session.viewerRole === "owner",
            readAt: query.dataUpdatedAt ?? 0,
            session: {
              id: ref.sessionId,
              title,
              status: str(session.status),
            },
          }
        : { state: "elsewhere" };
    }
  }
}

/** What the card says it did: the kind of settle, and when. */
export type AskReceipt = { kind: AskSettleKind; at: number };
export type AskCardEvent =
  { type: "settled"; kind: AskSettleKind; at: number } | { type: "moved-on" };

/** The receipt: set by a settle (any kind), untouched by a refusal that moved on. */
export function askCardReceipt(
  receipt: AskReceipt | null,
  event: AskCardEvent
): AskReceipt | null {
  return event.type === "settled"
    ? { kind: event.kind, at: event.at }
    : receipt;
}

/** The handlers the shared card gets: only a settle makes the receipt. */
export function askCardHandlers(dispatch: (event: AskCardEvent) => void) {
  return {
    onSettled: (kind: AskSettleKind) =>
      dispatch({ type: "settled", kind, at: Date.now() }),
    onClose: () => dispatch({ type: "moved-on" }),
  };
}

/**
 * Does the receipt still stand over what the page reads? Yes, unless a read
 * NEWER than the settle says the question is open again (asked again). Any
 * other read (answered, closed after a hand-back, even a failed refresh)
 * leaves the receipt: it is what the person just did.
 */
export function receiptStands(
  read: EmbedAskRead,
  receipt: AskReceipt | null
): boolean {
  if (!receipt) return false;
  return !(read.state === "open" && read.readAt > receipt.at);
}
