/**
 * `fileableExpectedOutputs` — what a session-update door may FILE (finding
 * 68a89ded, proposal a6a39fcd).
 *
 * The incident, replayed: an agent's update carried a person-owned slot with
 * its stored `owedSince` / `askedBy` (an `outcomes` update copies the whole
 * stored list). At filing that was a round-trip and passed. The person then
 * answered the slot, which clears both stamps; at approval the frozen copy
 * read as the agent authoring them, and the approval was refused every time.
 *
 * Pure: the real detector, the real merge and the real `applyOutputMutations`
 * the approval executor runs. The doors that call this are driven in
 * `governance-seams.pglite.test.ts` (M5b) and the Hub
 * `focus-sessions.patch-stamps.test.ts`.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  applyOutputMutations,
  fileableExpectedOutputs,
  mergeExpectedOutputs,
} from "../update-session.js";

const AGENT = "c340f738-7c2f-494a-ab66-de1c775fef7d";
const PERSON = "e418d146-e495-4b8a-8e8b-985f9f885431";

/** The slot as stored when the agent filed (owed to the person). */
const OWED: ExpectedOutput = {
  key: "approve-win-a-deal-onend",
  kind: "output",
  label: "Approve onEnd on 'Win a deal'",
  owner: "human",
  blockedReason: "permission",
  why: "Approve it on the proposal page.",
  unblocks: "The demo on a '[test]' deal",
  ask: { mode: "confirm", prompt: "Did you approve proposal b8305ffb?" },
  owedSince: "2026-11-06T15:01:52.792Z",
  askedBy: AGENT,
} as ExpectedOutput;

/** The same slot once the person answered it: the stamps of the ask are gone. */
const ANSWERED: ExpectedOutput = {
  key: OWED.key,
  kind: "output",
  label: OWED.label,
  answer: {
    text: "Yes",
    value: { type: "confirm", confirmed: true },
    answeredAt: "2026-11-06T17:52:57.434Z",
    answeredBy: PERSON,
  },
} as ExpectedOutput;

const OWN: ExpectedOutput = {
  key: "draft",
  kind: "document",
  label: "Draft",
  status: "pending",
};

describe("fileableExpectedOutputs", () => {
  it("files an echo of the stored slots WITHOUT their stamps (key kept)", () => {
    const res = fileableExpectedOutputs(
      [OWED, OWN],
      JSON.parse(JSON.stringify([OWED, OWN]))
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [owed, own] = res.expectedOutputs;
    expect(owed).not.toHaveProperty("owedSince");
    expect(owed).not.toHaveProperty("askedBy");
    expect(own).not.toHaveProperty("status");
    expect(owed!.key).toBe(OWED.key);
    // The client's own words travel.
    expect(owed).toMatchObject({
      owner: "human",
      ask: OWED.ask,
      why: OWED.why,
    });
  });

  it("the incident: the filed echo still APPLIES after the person answered", () => {
    const echo = JSON.parse(JSON.stringify([OWED]));
    const res = fileableExpectedOutputs([OWED], echo);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // What the approval executor runs, against the row as it is THEN.
    const apply = () =>
      applyOutputMutations(
        [ANSWERED],
        { expectedOutputs: res.expectedOutputs },
        {
          keepUnlisted: true,
          askedBy: AGENT,
        }
      );
    expect(apply).not.toThrow();
    // CONTROL: the list as it was sent is the proposal a6a39fcd carried.
    expect(() =>
      applyOutputMutations(
        [ANSWERED],
        { expectedOutputs: echo },
        {
          keepUnlisted: true,
          askedBy: AGENT,
        }
      )
    ).toThrow(/server-stamped receipts/);
  });

  it("REFUSES a list that changes a stamp, naming the slot and the field", () => {
    const res = fileableExpectedOutputs(
      [OWED],
      [{ ...OWED, owedSince: "2026-11-07T00:00:00.000Z" }]
    );
    expect(res).toEqual({
      ok: false,
      reason: expect.stringMatching(
        /"Approve onEnd on 'Win a deal'"\.owedSince.*server-stamped receipts/
      ),
    });
  });

  it("dropping round-trips changes nothing the merge writes now", () => {
    const echo = JSON.parse(JSON.stringify([OWED, OWN]));
    const res = fileableExpectedOutputs([OWED, OWN], echo);
    if (!res.ok) throw new Error(res.reason);
    expect(
      mergeExpectedOutputs([OWED, OWN], res.expectedOutputs, {
        keepUnlisted: true,
      })
    ).toEqual(mergeExpectedOutputs([OWED, OWN], echo, { keepUnlisted: true }));
  });

  it("leaves a NEW slot as sent (the merge drops a new slot's stamps)", () => {
    const born = { kind: "document", label: "New", owedSince: "x" };
    const res = fileableExpectedOutputs([OWED], [born as ExpectedOutput]);
    expect(res).toEqual({ ok: true, expectedOutputs: [born] });
  });
});
