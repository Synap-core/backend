/**
 * What a `:::synap-ask{sessionId slot}` embed knows about its question, from
 * the viewer's own `focusSessions.get`. PURE and shared: pod admin, the
 * browser, web and relay all read the embed through this one model, so no
 * surface re-derives slot resolution, the read states or the receipt rules.
 * A slot is found as the answer door finds it (key first across every slot,
 * then trimmed + casefolded label), and the matched slot's KEY is what the
 * card answers with (`expectedLabel`).
 *
 * No direct bare imports, no React, no Intl, no regex lookbehind (relay runs
 * on Hermes).
 * What a surface still owns is its own arrangement of the card: it builds the
 * card with `askCardView(askCardSlotOf(open.source), { sessionId, now })`.
 */
import { deriveSlotKeys, normalizeSlotLabel } from "../units/outcome.js";
import {
  CRITERION_SLOT_KIND,
  isCriterionGradeAsk,
} from "../focus-sessions/criterion-slot.js";
import { askSlotStanding, type AskCardSlotSource } from "./card.js";
import type { Ask } from "./index.js";

/**
 * The read errors that mean "this question is not yours to see": hidden, not
 * failed. UNAUTHORIZED is deliberately absent: a signed-out reader is a failed
 * read (re-auth), never "not available".
 */
export const ASK_EMBED_HIDDEN_CODES: ReadonlySet<string> = new Set([
  "NOT_FOUND",
  "FORBIDDEN",
  "BAD_REQUEST",
]);

/** The embed's reference, or null when it names nothing. */
export function askEmbedRef(
  ref: Record<string, string | undefined>
): { sessionId: string; slot: string } | null {
  const sessionId = ref.sessionId?.trim();
  const slot = ref.slot?.trim();
  return sessionId && slot ? { sessionId, slot } : null;
}

/** How a card settled: the receipt a host may draw. */
export type AskSettleKind = "answered" | "attested" | "handed-back" | "refused";

export type StoredAskSlot = Record<string, unknown>;

/** The owed slot, named the way `askCardSlotOf` reads a needs-you signal. */
export type AskEmbedSource = AskCardSlotSource & {
  kind: "owed-slot";
  title: string;
  slotKind: string | null;
  occurredAt: string | null;
  target: { kind: "session"; id: string };
  sessionTitle: string | null;
  by: { id: string; label: string } | null;
  ask?: Ask | null;
};

export type EmbedAskRead =
  | { state: "unresolved" }
  | { state: "loading" }
  | { state: "failed"; retry?: () => void; retrying: boolean }
  | { state: "hidden" }
  | { state: "closed" }
  | { state: "elsewhere" }
  | {
      state: "open";
      /** The matched slot's KEY: what an answer is sent as `expectedLabel`. */
      key: string;
      /** The slot as the session stores it. */
      stored: StoredAskSlot;
      /** The slot as `askCardSlotOf` reads it (see {@link AskEmbedSource}). */
      source: AskEmbedSource;
      /** The asking agent, named from the session's participants. */
      asker: { id: string; name: string } | null;
      /** Only the session's owner answers; a member reads. */
      canAnswer: boolean;
      /** When this read landed: an answer given before it is superseded. */
      readAt: number;
      /** The work the question comes from, named above the card. */
      session: { id: string; title: string | null; status: string | null };
    }
  | { state: "answered"; answer: string | null; attested: boolean };

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v : null;

function standingOf(o: StoredAskSlot) {
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
): { slot: StoredAskSlot; key: string } | "ambiguous" | null {
  if (!Array.isArray(outputs)) return null;
  const wanted = ref.trim();
  if (!wanted) return null;
  const keys = deriveSlotKeys(outputs);
  const pick = (i: number) => ({
    slot: outputs[i] as StoredAskSlot,
    key: keys[i]!,
  });
  const byKey = keys.indexOf(wanted);
  if (byKey !== -1) return pick(byKey);
  const label = normalizeSlotLabel(wanted);
  const same = outputs.flatMap((raw, i) =>
    raw &&
    typeof raw === "object" &&
    normalizeSlotLabel(str((raw as StoredAskSlot).label)) === label
      ? [i]
      : []
  );
  if (same.length <= 1) return same.length ? pick(same[0]!) : null;
  const owed = same.filter(
    (i) => standingOf(outputs[i] as StoredAskSlot) === "owed"
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
    return code && ASK_EMBED_HIDDEN_CODES.has(code)
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
      const ask = (stored.ask ?? null) as Ask | null;
      // A hand-over (secret, connection, file) keeps its own panel (what
      // became of it, take it back), which resolves the slot by LABEL: it is
      // answered on the work's page, never inline. A criterion slot is drawn
      // in place only when its ask IS the Pass / Fail grade.
      if (
        ask?.mode === "provide" ||
        (str(stored.kind) === CRITERION_SLOT_KIND && !isCriterionGradeAsk(ask))
      ) {
        return { state: "elsewhere" };
      }
      const asker = (
        Array.isArray(session.participants) ? session.participants : []
      ).find((p: { id?: unknown }) => p?.id === stored.askedBy) as
        { id: string; name: string } | undefined;
      const title = str(session.title);
      return {
        state: "open",
        key,
        stored,
        source: {
          ...stored,
          kind: "owed-slot",
          title: str(stored.label) ?? "",
          slotKind: str(stored.kind),
          occurredAt: str(stored.owedSince),
          target: { kind: "session", id: ref.sessionId },
          sessionTitle: title,
          by: asker ? { id: asker.id, label: asker.name } : null,
        } as AskEmbedSource,
        asker: asker ? { id: asker.id, name: asker.name } : null,
        canAnswer: session.viewerRole === "owner",
        readAt: query.dataUpdatedAt ?? 0,
        session: { id: ref.sessionId, title, status: str(session.status) },
      };
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

/**
 * Does the receipt still stand over what the page reads? Yes, unless a read
 * NEWER than the settle says the question is open again (asked again). Any
 * other read (answered, closed after a hand-back, even a failed refresh)
 * leaves the receipt: it is what the person just did.
 */
export function receiptStands(
  read: { state: string; readAt?: number },
  receipt: AskReceipt | null
): boolean {
  if (!receipt) return false;
  return !(read.state === "open" && (read.readAt ?? 0) > receipt.at);
}
