/**
 * The ask card's face says no ENGINE word (plan c727854c W1b; founder G1,
 * 2026-10-30): a session is a "job", a proposal a "request", a track a
 * "goal", through the vocabulary door. Engine words belong on rung 3 only.
 *
 * Behavioural, not a source scan: every `ASK_COPY` entry is EVALUATED (each
 * function called on every branch it has), plus the cause lines a card draws
 * (`askCause` over every `ASK_CAUSE_KINDS`, `effectiveSlotUnblocks` over the
 * same) and the fate words it borrows (`FATE_COPY`). What it cannot see: a
 * literal a surface writes beside these (relay `app/owed/[sessionId].tsx`),
 * and a word built from a token this file does not list.
 */
import { describe, expect, it } from "vitest";
import { ASK_CAUSE_KINDS } from "./index.js";
import { ASK_COPY, effectiveSlotUnblocks, type AskCardSlot } from "./card.js";
import { FATE_COPY } from "../proposals/fate.js";
import { resolveObjectNoun } from "../vocabulary/index.js";

const ENGINE_WORDS = /\b(sessions?|proposals?|tracks?|slots?|stages?)\b/i;

/** Every string a copy table yields, functions called on every branch. */
function wordsOf(table: Record<string, unknown>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const sample = ["Researcher", 60];
  for (const [key, value] of Object.entries(table)) {
    if (typeof value === "string") out.push([key, value]);
    else if (value && typeof value === "object")
      for (const [k, v] of wordsOf(value as Record<string, unknown>))
        out.push([`${key}.${k}`, v]);
    else if (typeof value === "function") {
      if (key === "askCause") {
        for (const kind of ASK_CAUSE_KINDS) {
          out.push([`${key}(${kind})`, value(kind, null)]);
          out.push([`${key}(${kind}, at)`, value(kind, "29 Sep")]);
        }
        // A kind a newer pod sends: the fallback head.
        out.push([`${key}(unknown)`, value("future_kind", null)]);
      } else if (key === "provideConnectUnavailable") {
        for (const reason of ["no_broker", "not_offered", "check_failed"])
          out.push([`${key}(${reason})`, value(reason, "Google")]);
      } else if (key === "relayedWords") {
        out.push([key, String(value({ quote: "ship it" }))]);
      } else {
        const v = value(...sample);
        if (typeof v === "string") out.push([key, v]);
        // The unnamed branch ("An agent", "relayed"), where the copy has one.
        let unnamed: unknown = null;
        try {
          unnamed = value(null);
        } catch {
          // This entry has no unnamed branch (it trims its argument).
        }
        if (typeof unnamed === "string") out.push([`${key}(null)`, unnamed]);
      }
    }
  }
  return out;
}

describe("the ask card speaks the person's words, never the engine's", () => {
  const words = [
    ...wordsOf(ASK_COPY as unknown as Record<string, unknown>),
    ...wordsOf(FATE_COPY as unknown as Record<string, unknown>),
    ...ASK_CAUSE_KINDS.map(
      (kind) =>
        [
          `unblocks(${kind})`,
          String(effectiveSlotUnblocks({ askCause: { kind } } as AskCardSlot)),
        ] as [string, string]
    ),
  ];

  it("scans what it claims (non-vacuity + a literal sample it must catch)", () => {
    expect(words.length).toBeGreaterThan(60);
    expect(words.some(([k]) => k === "closedSessionEnded")).toBe(true);
    expect(ENGINE_WORDS.test("Closed · the session ended")).toBe(true);
    expect(ENGINE_WORDS.test("From the session's checks")).toBe(true);
  });

  for (const [key, text] of words) {
    it(`${key}: "${text}"`, () => {
      expect(text).not.toMatch(ENGINE_WORDS);
    });
  }

  it("the job word comes from the vocabulary door, not a literal", () => {
    const job = resolveObjectNoun("session").toLowerCase();
    expect(ASK_COPY.closedSessionEnded).toBe(`Closed · the ${job} ended`);
    expect(FATE_COPY.endsWithSession).toBe(`Ends with the ${job}`);
  });
});
