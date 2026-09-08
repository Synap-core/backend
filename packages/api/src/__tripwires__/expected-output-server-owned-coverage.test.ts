/**
 * TRIPWIRE — every non-client-authored `ExpectedOutput` field must be carried
 * forward by `mergeExpectedOutputs`.
 *
 * THE BUG THIS EXISTS FOR. `expectedOutputs` is patched WHOLESALE by three
 * doors, and the surfaces that patch it read the list, edit one label and send
 * the whole array back. A field they have never heard of is therefore ERASED on
 * the next edit unless the merge carries it. `SERVER_OWNED_OUTPUT_FIELDS` is
 * what makes it survive — and its `satisfies ReadonlyArray<keyof ExpectedOutput>`
 * PERMITS OMISSION, so a new field can be added to the interface, declared on
 * the wire, and still be silently destroyed.
 *
 * WHY THIS IS NOT A SOURCE REGEX. This repo has already shipped a tripwire
 * blinded by the JSDoc of the very field it existed to catch. So the field set
 * here is DERIVED from a runtime value that the type system already keeps in
 * lock-step with the interface — `expectedOutputWireSchema.shape`, which is
 * declared `satisfies z.ZodType<ExpectedOutput, ExpectedOutput>` and so cannot
 * silently miss a field — and the assertion is BEHAVIOURAL: each field is
 * actually round-tripped through the merge.
 *
 * A new `ExpectedOutput` field fails this test at three points until it is
 * handled: it is missing from the derived set's classification, it has no
 * sample value, and it is not carried by the merge.
 */
import { describe, it, expect } from "vitest";
import {
  expectedOutputWireSchema,
  mergeExpectedOutputs,
  SERVER_OWNED_OUTPUT_FIELDS,
  CLIENT_AUTHORED_OUTPUT_FIELDS,
} from "../services/focus-sessions/update-session.js";
import type { ExpectedOutput } from "@synap/playbooks";

/** Every field the WIRE knows about — derived, never hand-listed. */
const WIRE_FIELDS = Object.keys(expectedOutputWireSchema.shape) as Array<
  keyof ExpectedOutput
>;

/**
 * A distinguishable stored value per server-owned field. Typed against
 * `ExpectedOutput`, so a new field with an incompatible sample is a compile
 * error, and the completeness check below turns a MISSING sample into a
 * failure rather than a skipped field.
 */
const SAMPLE: Required<
  Pick<ExpectedOutput, (typeof SERVER_OWNED_OUTPUT_FIELDS)[number]>
> = {
  status: "done",
  claimedDone: true,
  satisfiedByProposalId: "11111111-1111-1111-1111-111111111111",
  delegatedTo: "researcher",
  delegatedAt: "2026-09-08T10:00:00.000Z",
  returnedReason: "Missing the numbers",
  returnedAt: "2026-09-08T11:00:00.000Z",
  owner: "human",
  blockedReason: "credential",
  why: "The Stripe restricted key for the live account",
  owedSince: "2026-09-08T09:00:00.000Z",
  attestedBy: "22222222-2222-2222-2222-222222222222",
  attestedAt: "2026-09-08T12:00:00.000Z",
  retiredAt: "2026-09-08T13:00:00.000Z",
  retiredReason: "session_cancelled",
};

describe("ExpectedOutput server-owned coverage", () => {
  it("classifies every wire field as client-authored or server-owned", () => {
    const classified = new Set<string>([
      ...CLIENT_AUTHORED_OUTPUT_FIELDS,
      ...SERVER_OWNED_OUTPUT_FIELDS,
    ]);
    const unclassified = WIRE_FIELDS.filter((f) => !classified.has(f));
    expect(unclassified).toEqual([]);
  });

  it("lists no field the wire does not know about", () => {
    const wire = new Set<string>(WIRE_FIELDS);
    const phantom = [
      ...CLIENT_AUTHORED_OUTPUT_FIELDS,
      ...SERVER_OWNED_OUTPUT_FIELDS,
    ].filter((f) => !wire.has(f));
    expect(phantom).toEqual([]);
  });

  it("has a sample value for every server-owned field", () => {
    const missing = SERVER_OWNED_OUTPUT_FIELDS.filter(
      (f) => SAMPLE[f] === undefined
    );
    expect(missing).toEqual([]);
  });

  it("carries EVERY server-owned field through a patch that is silent about it", () => {
    // The real-world shape of the bug: a client that knows only kind+label
    // sends the whole array back after renaming nothing.
    const stored: ExpectedOutput = {
      kind: "doc",
      label: "Launch brief",
      ...SAMPLE,
    };
    const naivePatch: ExpectedOutput = { kind: "doc", label: "Launch brief" };

    const [merged] = mergeExpectedOutputs([stored], [naivePatch]);

    for (const field of SERVER_OWNED_OUTPUT_FIELDS) {
      expect(merged[field], `${field} was erased by a silent patch`).toEqual(
        SAMPLE[field]
      );
    }
  });

  it("lets an explicit incoming value win over the stored one", () => {
    const stored: ExpectedOutput = {
      kind: "doc",
      label: "Launch brief",
      owner: "human",
      blockedReason: "credential",
      why: "The Stripe restricted key",
    };
    const [merged] = mergeExpectedOutputs(
      [stored],
      [
        {
          kind: "doc",
          label: "Launch brief",
          owner: "agent",
          blockedReason: "policy",
          why: "Retention rule forbids the export",
        },
      ]
    );
    expect(merged.owner).toBe("agent");
    expect(merged.blockedReason).toBe("policy");
    expect(merged.why).toBe("Retention rule forbids the export");
  });

  it("keeps `owedSince` present IFF the slot is owned by the human", () => {
    // Handing a slot TO the human stamps the clock the owed feed ages rows by.
    const [owed] = mergeExpectedOutputs(
      [{ kind: "doc", label: "Brief" }],
      [{ kind: "doc", label: "Brief", owner: "human" }]
    );
    expect(owed.owedSince).toEqual(expect.any(String));

    // Re-declaring the SAME blocker must not reset it — otherwise every patch
    // makes the oldest owed slot look brand new.
    const [again] = mergeExpectedOutputs(
      [owed],
      [{ kind: "doc", label: "Brief", owner: "human" }]
    );
    expect(again.owedSince).toBe(owed.owedSince);

    // The agent taking it back clears the stamp with the ownership.
    const [reclaimed] = mergeExpectedOutputs(
      [owed],
      [{ kind: "doc", label: "Brief", owner: "agent" }]
    );
    expect(reclaimed.owedSince).toBeUndefined();

    // And a client cannot author one on a slot it is not handing over.
    const [fabricated] = mergeExpectedOutputs(
      [{ kind: "doc", label: "Brief" }],
      [{ kind: "doc", label: "Brief", owedSince: "1999-01-01T00:00:00.000Z" }]
    );
    expect(fabricated.owedSince).toBeUndefined();
  });

  it("survives the wire PARSE — the erasure that happens before any merge", () => {
    const slot: ExpectedOutput = {
      kind: "doc",
      label: "Launch brief",
      ...SAMPLE,
    };
    expect(expectedOutputWireSchema.parse(slot)).toEqual(slot);
  });

  it("rejects a blockedReason outside the closed set", () => {
    expect(() =>
      expectedOutputWireSchema.parse({
        kind: "doc",
        label: "Launch brief",
        owner: "human",
        blockedReason: "vibes",
      })
    ).toThrow();
  });
});
