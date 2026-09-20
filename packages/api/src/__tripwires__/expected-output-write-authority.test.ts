/**
 * TRIPWIRE — a client may DECLARE a deliverable; only the server may STAMP one.
 *
 * THE BUG THIS EXISTS FOR. `completeOutput` refuses to close a slot the agent
 * itself declared `owner: 'human'`. The WHOLESALE `expectedOutputs` path had no
 * such floor: one `synap_update_session` call carrying
 * `[{kind, label, status: "done"}]` stamped the same slot done with no receipt,
 * and `mergeExpectedOutputs`' rule — "an explicit value wins" — was what let it
 * through. The same hole forged `attestedBy` naming the user, and hid an owed
 * slot behind a `retiredAt`. The `expected-output-done-one-door` tripwire is a
 * proximity scan over the `completeOutput` literal and cannot see this path at
 * all, which is why the hole survived it.
 *
 * WHAT MAKES THIS A GUARD AND NOT A TEST.
 *   - The field set is DERIVED from `expectedOutputWireSchema.shape` — the same
 *     runtime value the type system holds in lock-step with `ExpectedOutput`
 *     (`satisfies z.ZodType<ExpectedOutput, ExpectedOutput>`). A new field joins
 *     this scan BY EXISTING; there is no list here to forget to update.
 *   - Every assertion is BEHAVIOURAL: the field is pushed through the real merge
 *     and the outcome is read off the result. Nothing asserts that a name
 *     appears in a list.
 *   - The non-vacuity floors below fail if the derivation ever yields an empty
 *     or implausibly small set — the failure mode where a scan quietly stops
 *     looking and every assertion after it passes.
 *
 * WHAT IT DOES NOT COVER, measured. It exercises `mergeExpectedOutputs`, which
 * is the one function all four wholesale doors call (tRPC ×2, Hub REST, the
 * approval executor) — verified by grepping the call sites, not assumed. It does
 * NOT prove each door reaches the merge; a door that stopped calling it would
 * pass this file. The CREATE path (`createFocusSession`) is out of its scope
 * entirely: a session may still be created with a slot already stamped, which is
 * a separate, un-closed hole.
 */
import { describe, it, expect } from "vitest";
import {
  expectedOutputWireSchema,
  mergeExpectedOutputs,
  detectServerStampedWrites,
  CLIENT_DECLARABLE_OUTPUT_FIELDS,
  SERVER_STAMPED_OUTPUT_FIELDS,
} from "../services/focus-sessions/update-session.js";
import type { ExpectedOutput } from "@synap/playbooks";

/** Every field the WIRE knows about — derived, never hand-listed. */
const WIRE_FIELDS = Object.keys(expectedOutputWireSchema.shape) as Array<
  keyof ExpectedOutput
>;

/**
 * A STORED value and a DIFFERENT incoming one per server-stamped field. The
 * pair is the point: equal means round-trip (allowed), different means the
 * caller is authoring a receipt (refused). Typed against `ExpectedOutput`, so a
 * new field with an incompatible sample is a compile error and a MISSING one is
 * caught by the completeness floor below rather than silently skipped.
 */
const STORED: Required<
  Pick<ExpectedOutput, (typeof SERVER_STAMPED_OUTPUT_FIELDS)[number]>
> = {
  status: "pending",
  criterionKey: "no-stale",
  claimedDone: false,
  satisfiedByProposalId: "11111111-1111-1111-1111-111111111111",
  delegatedTo: "researcher",
  delegatedAt: "2026-09-01T10:00:00.000Z",
  returnedReason: "Missing the numbers",
  returnedAt: "2026-09-01T11:00:00.000Z",
  owedSince: "2026-09-01T09:00:00.000Z",
  attestedBy: "22222222-2222-2222-2222-222222222222",
  attestedAt: "2026-09-01T12:00:00.000Z",
  retiredAt: "2026-09-01T13:00:00.000Z",
  retiredReason: "session_cancelled",
};

/** The forgery an agent would attempt for each — every one a real attack. */
const FORGED: typeof STORED = {
  status: "done",
  criterionKey: "forged-key",
  claimedDone: true,
  satisfiedByProposalId: "99999999-9999-9999-9999-999999999999",
  delegatedTo: "someone-else",
  delegatedAt: "2026-09-08T10:00:00.000Z",
  returnedReason: "actually fine",
  returnedAt: "2026-09-08T11:00:00.000Z",
  owedSince: "2026-09-08T09:00:00.000Z",
  attestedBy: "antoine",
  attestedAt: "2026-09-08T12:00:00.000Z",
  retiredAt: "2026-09-08T13:00:00.000Z",
  retiredReason: "session_cancelled",
};

const LABEL = "Launch brief";
const storedSlot = (): ExpectedOutput => ({
  kind: "doc",
  label: LABEL,
  owner: "human",
  blockedReason: "credential",
  why: "The Stripe restricted key",
  ...STORED,
});

describe("tripwire: expected-output write authority", () => {
  // ── non-vacuity ───────────────────────────────────────────────────────────
  it("the derivation still sees the fields it hunts", () => {
    // A scan over an empty set passes every assertion after it. These numbers
    // are floors, not exact counts: a NEW field must not fail this test, it
    // must fail the classification test below.
    expect(WIRE_FIELDS.length).toBeGreaterThanOrEqual(15);
    expect(SERVER_STAMPED_OUTPUT_FIELDS.length).toBeGreaterThanOrEqual(12);
    // The sample of what it hunts: the field the bypass actually forged.
    expect(SERVER_STAMPED_OUTPUT_FIELDS).toContain("status");
    expect(SERVER_STAMPED_OUTPUT_FIELDS).toContain("attestedBy");
    expect(SERVER_STAMPED_OUTPUT_FIELDS).toContain("retiredAt");
  });

  it("classifies every wire field exactly once", () => {
    const declarable = new Set<string>(CLIENT_DECLARABLE_OUTPUT_FIELDS);
    const stamped = new Set<string>(SERVER_STAMPED_OUTPUT_FIELDS);
    const unclassified = WIRE_FIELDS.filter(
      (f) => !declarable.has(f) && !stamped.has(f)
    );
    const both = WIRE_FIELDS.filter((f) => declarable.has(f) && stamped.has(f));
    expect(unclassified).toEqual([]);
    expect(both).toEqual([]);
  });

  it("has a stored AND a forged sample for every server-stamped field", () => {
    const missing = SERVER_STAMPED_OUTPUT_FIELDS.filter(
      (f) => STORED[f] === undefined || FORGED[f] === undefined
    );
    expect(missing).toEqual([]);
  });

  // ── the floor itself ──────────────────────────────────────────────────────
  it("REFUSES every server-stamped field a patch tries to STAMP", () => {
    // Stored slot MINUS the field: the caller is minting a receipt that does not
    // exist. Uniform across all twelve, and the shape of the real attacks — a
    // `status: "done"` on an undelivered slot, an `attestedBy` naming the user.
    for (const field of SERVER_STAMPED_OUTPUT_FIELDS) {
      const stored = storedSlot();
      delete stored[field];
      const patch = {
        kind: "doc",
        label: LABEL,
        [field]: FORGED[field],
      } as ExpectedOutput;
      expect(
        () => mergeExpectedOutputs([stored], [patch]),
        `${field} was stampable by a client patch`
      ).toThrow(/server-stamped/i);
    }
  });

  it("REFUSES every server-stamped field a patch tries to OVERWRITE", () => {
    // The other half: a receipt that EXISTS and is being changed to something
    // else. Only fields with two distinct legal values can express this —
    // `retiredReason`'s enum has exactly one member, so for it the stamp case
    // above is the whole of the coverage, which is stated rather than implied.
    const overwritable = SERVER_STAMPED_OUTPUT_FIELDS.filter(
      (f) => STORED[f] !== FORGED[f]
    );
    expect(overwritable.length).toBeGreaterThanOrEqual(
      SERVER_STAMPED_OUTPUT_FIELDS.length - 1
    );
    expect(overwritable).not.toContain("retiredReason");
    for (const field of overwritable) {
      const patch = {
        kind: "doc",
        label: LABEL,
        [field]: FORGED[field],
      } as ExpectedOutput;
      expect(
        () => mergeExpectedOutputs([storedSlot()], [patch]),
        `${field} was overwritable by a client patch`
      ).toThrow(/server-stamped/i);
    }
  });

  it("the refusal NAMES the slot and the field — a silent no-op is the defect", () => {
    expect(() =>
      mergeExpectedOutputs(
        [storedSlot()],
        [{ kind: "doc", label: LABEL, status: "done" }]
      )
    ).toThrow(/"Launch brief"\.status/);
  });

  it("the exact bypass from the review: one call, no receipt, slot done", () => {
    // `expectedOutputs: [{kind, label, status: "done"}]` on a human-owned,
    // blocked slot — the wholesale twin of the `completeOutput` the governance
    // floor already refuses.
    expect(() =>
      mergeExpectedOutputs(
        [
          {
            kind: "doc",
            label: LABEL,
            owner: "human",
            blockedReason: "credential",
            why: "The Stripe restricted key",
            owedSince: "2026-09-01T09:00:00.000Z",
          },
        ],
        [{ kind: "doc", label: LABEL, status: "done" }]
      )
    ).toThrow(/Nothing was changed/);
  });

  it("ALLOWS a round-trip: the same stored values, sent straight back", () => {
    // The shape the browser board and `useDeclareOutput` actually produce. This
    // must never error, or the fix breaks every honest client.
    const slot = storedSlot();
    const [merged] = mergeExpectedOutputs([slot], [{ ...slot }]);
    expect(merged).toEqual(slot);
  });

  it("carries every stamp forward when the patch is SILENT about it", () => {
    // The erasure guarantee the merge already made must survive the new floor.
    const [merged] = mergeExpectedOutputs(
      [storedSlot()],
      [{ kind: "doc", label: LABEL }]
    );
    for (const field of SERVER_STAMPED_OUTPUT_FIELDS) {
      expect(merged[field], `${field} was erased by a silent patch`).toEqual(
        STORED[field]
      );
    }
  });

  it("DROPS a stamp on a slot with no stored twin, instead of refusing", () => {
    // A new label carries no receipts by definition — nothing is being
    // contradicted, so there is nothing to refuse, and refusing would break the
    // legitimate rename (read the array, change one label, send it back).
    const [merged] = mergeExpectedOutputs(
      [],
      [
        {
          kind: "doc",
          label: "Brand new",
          status: "done",
          attestedBy: "antoine",
          satisfiedByProposalId: "33333333-3333-3333-3333-333333333333",
        },
      ]
    );
    expect(merged.status).toBeUndefined();
    expect(merged.attestedBy).toBeUndefined();
    expect(merged.satisfiedByProposalId).toBeUndefined();
    // …and it still lands as a real, declared slot.
    expect(merged.label).toBe("Brand new");
  });

  it("still lets a client DECLARE the fields it owns", () => {
    // The other half of the split: `owner`/`blockedReason`/`why` are the agent's
    // own declaration and must keep working, including handing a slot BACK.
    const [merged] = mergeExpectedOutputs(
      [{ kind: "doc", label: LABEL, owner: "human", blockedReason: "policy" }],
      [
        {
          kind: "doc",
          label: LABEL,
          icon: "key",
          owner: "agent",
          blockedReason: "capability",
          why: "I can take it after all",
        },
      ]
    );
    expect(merged.owner).toBe("agent");
    expect(merged.blockedReason).toBe("capability");
    expect(merged.why).toBe("I can take it after all");
    expect(merged.icon).toBe("key");
  });

  it("reports every violation in one call, not just the first", () => {
    const violations = detectServerStampedWrites(
      [storedSlot()],
      [{ kind: "doc", label: LABEL, status: "done", attestedBy: "antoine" }]
    );
    expect(violations.map((v) => v.field).sort()).toEqual([
      "attestedBy",
      "status",
    ]);
  });
});

/**
 * The MCP door's ADVERTISED schema. A field a model is told about is a field it
 * will try to send — the `status` enum sat directly above the `owner` property
 * that explains blocking, which is as close to an instruction as a schema gets.
 *
 * Read off the real tool definition rather than the source text: a regex over
 * this file would be one JSDoc away from blindness, and the thing that matters
 * is what the model RECEIVES.
 */
describe("tripwire: the MCP door advertises no server-stamped field", () => {
  it("no expectedOutputs item schema exposes a stamp", async () => {
    const { tools } = await import("../routers/mcp/tools/index.js");
    const list = await tools.list();
    const stamped = new Set<string>(SERVER_STAMPED_OUTPUT_FIELDS);

    // Non-vacuity: the scan must actually find the schemas it judges.
    let inspected = 0;
    for (const tool of list) {
      const schema = tool.inputSchema as
        { properties?: Record<string, unknown> } | undefined;
      const outputs = schema?.properties?.expectedOutputs as
        { items?: { properties?: Record<string, unknown> } } | undefined;
      const props = outputs?.items?.properties;
      if (!props) continue;
      inspected += 1;
      const advertised = Object.keys(props).filter((k) => stamped.has(k));
      expect(
        advertised,
        `${tool.name} advertises a server-stamped field`
      ).toEqual([]);
      // And it still advertises what an agent IS meant to send.
      expect(Object.keys(props)).toContain("owner");
    }
    expect(inspected).toBeGreaterThanOrEqual(2);
  });
});
