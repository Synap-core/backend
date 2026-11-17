/**
 * What a `:::synap-ask{sessionId slot}` embed knows about its question. The
 * read, the slot resolution, the hidden-codes rule and the receipt rules are
 * the shared model (`@synap-core/types/ask`, `embed.ts`); what stays here is
 * pod admin's own: the console's `AskSlot` the answer card draws, built from
 * the shared read's `source`, and the React handlers.
 */
import {
  askEmbedRead as sharedAskEmbedRead,
  type AskCardEvent,
  type AskSettleKind,
  type EmbedAskRead as SharedEmbedAskRead,
} from "@synap-core/types/ask";
import {
  askSlotOf,
  type AskSlot,
  type AskSlotSignal,
} from "../../../(admin)/review/_lib/ask-detail";

export {
  askCardReceipt,
  findAskSlot,
  receiptStands,
  type AskCardEvent,
} from "@synap-core/types/ask";

export type EmbedAskRead =
  | Exclude<SharedEmbedAskRead, { state: "open" }>
  | {
      state: "open";
      slot: AskSlot;
      /** Only the session's owner answers; a member reads. */
      canAnswer: boolean;
      /** When this read landed: an answer given before it is superseded. */
      readAt: number;
      /** The work the question comes from, named above the card. */
      session: { id: string; title: string | null; status: string | null };
    };

export function askEmbedRead(
  query: Parameters<typeof sharedAskEmbedRead>[0],
  ref: { sessionId: string; slot: string }
): EmbedAskRead {
  const read = sharedAskEmbedRead(query, ref);
  if (read.state !== "open") return read;
  const slot = askSlotOf(read.source as unknown as AskSlotSignal);
  // The shared read already sends a slot this console cannot draw elsewhere.
  if (!slot) return { state: "elsewhere" };
  return {
    state: "open",
    slot: { ...slot, slotKey: read.key },
    canAnswer: read.canAnswer,
    readAt: read.readAt,
    session: read.session,
  };
}

/** The handlers the shared card gets: only a settle makes the receipt. */
export function askCardHandlers(dispatch: (event: AskCardEvent) => void) {
  return {
    onSettled: (kind: AskSettleKind) =>
      dispatch({ type: "settled", kind, at: Date.now() }),
    onClose: () => dispatch({ type: "moved-on" }),
  };
}
