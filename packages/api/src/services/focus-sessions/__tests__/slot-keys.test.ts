/**
 * Slot keys (A2) — stamped by the server, carried across every rebuild, and
 * preferred over the label by every join that names a slot.
 *
 * Each block names the rival rule it rules out:
 *   R1 "re-derive keys on every write" — a reworded sibling would shift a key
 *   R2 "a rebuilt slot is a new slot"   — the merge would mint over a stored key
 *   R3 "label first"                    — a claim naming B's key would land on
 *      A when A's label is what it also carries
 *   R4 "trust the client's key"         — an agent could re-point a slot
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import { projectSessionOutcomes } from "@synap-core/types/units";
import {
  carrySlotKeys,
  findSlotIndex,
  readProposalExpectedKey,
} from "../slot-keys.js";
import {
  applyOutputMutations,
  mergeExpectedOutputs,
} from "../update-session.js";
import { selectOutputToSatisfy } from "../satisfy-expected-output.js";
import {
  joinSessionOutputs,
  type JoinArtifactRow,
} from "../session-outputs.js";
import { resolveArtifactSlotClaim } from "../record-session-artifact.js";

const keyOf = (o: unknown) => (o as { key?: string }).key;
const DOC_A = "22222222-2222-4222-8222-222222222222";

describe("carrySlotKeys", () => {
  it("freezes a legacy slot's DERIVED key on its first write — the key a reader already saw", () => {
    const legacy = [
      { kind: "doc", label: "Report" },
      { kind: "doc", label: "Report" },
    ];
    const readKeys = projectSessionOutcomes({
      expectedOutputs: legacy,
      sessionTerminal: false,
    }).outcomes.map((o) => o.key);
    const written = carrySlotKeys(
      legacy,
      legacy.map((s) => ({ ...s }))
    );
    expect(written.map(keyOf)).toEqual(readKeys);
    expect(readKeys).toEqual(["report", "report-2"]);
  });

  it("carries a stored key onto the slot that replaces it, even when a sibling before it is gone (rules out R1)", () => {
    const prior = [
      { kind: "doc", label: "Intro", key: "intro" },
      { kind: "doc", label: "Body", key: "custom-body" },
    ];
    // The client dropped "Intro" and echoed "Body" WITHOUT its key.
    const next = carrySlotKeys(prior, [{ kind: "doc", label: "body" }]);
    expect(next.map(keyOf)).toEqual(["custom-body"]);
  });

  it("mints a fresh, collision-free key for a NEW slot", () => {
    const prior = [{ kind: "doc", label: "Report", key: "report" }];
    const next = carrySlotKeys(prior, [
      { ...prior[0]! },
      { kind: "doc", label: "Report " },
    ]);
    // "Report " matches the stored label, but its key is already held by the
    // first slot — the second is a NEW slot and gets its own.
    expect(next.map(keyOf)).toEqual(["report", "report-2"]);
  });
});

describe("the wholesale merge + addOutput keep identity", () => {
  it("mergeExpectedOutputs carries the stored key when the client echoes the slot without it (rules out R2)", () => {
    const current = [
      { kind: "doc", label: "Spec", key: "spec-v1", status: "pending" },
    ] as unknown as ExpectedOutput[];
    const merged = mergeExpectedOutputs(current, [
      { kind: "doc", label: "Spec" } as ExpectedOutput,
    ]);
    expect(merged.map(keyOf)).toEqual(["spec-v1"]);
  });

  it("an incoming key is never authored by the client (rules out R4)", () => {
    const current = [
      { kind: "doc", label: "Spec", key: "spec" },
    ] as unknown as ExpectedOutput[];
    const merged = mergeExpectedOutputs(current, [
      {
        kind: "doc",
        label: "Brand new",
        key: "spec",
      } as unknown as ExpectedOutput,
    ]);
    // The wire schema strips `key` before the merge ever sees it; called
    // directly, a client key on a NEW slot still cannot steal a stored one.
    expect(merged.map(keyOf)).not.toContain(undefined);
    expect(new Set(merged.map(keyOf)).size).toBe(merged.length);
  });

  it("addOutput is born keyed; completeOutput names a slot by key as well as by label", () => {
    const current = [
      { kind: "doc", label: "Spec", key: "spec" },
    ] as unknown as ExpectedOutput[];
    const added = applyOutputMutations(current, {
      addOutput: { kind: "doc", label: "Deck" },
    });
    expect(added.outputs.map(keyOf)).toEqual(["spec", "deck"]);

    const byKey = applyOutputMutations(added.outputs, {
      completeOutput: "deck",
    });
    expect(byKey.completeOutput?.completed).toBe(1);
    const byLabel = applyOutputMutations(added.outputs, {
      completeOutput: "Spec",
    });
    expect(byLabel.completeOutput?.completed).toBe(1);
  });
});

describe("joins prefer the key, label is the alias (rules out R3)", () => {
  const slots = [
    { kind: "document", label: "Brief", key: "brief" },
    { kind: "document", label: "Deck", key: "deck" },
  ] as unknown as ExpectedOutput[];

  it("findSlotIndex: key first, then label, through the predicate", () => {
    expect(findSlotIndex(slots, { key: "deck", label: "Brief" })).toBe(1);
    expect(findSlotIndex(slots, { label: " brief " })).toBe(0);
    expect(findSlotIndex(slots, "deck")).toBe(1);
    expect(findSlotIndex(slots, "Deck")).toBe(1);
    expect(findSlotIndex(slots, { key: "deck" }, (_, i) => i !== 1)).toBe(-1);
    // A legacy slot has no stored key — its DERIVED key still names it.
    expect(findSlotIndex([{ kind: "doc", label: "Old one" }], "old-one")).toBe(
      0
    );
  });

  it("selectOutputToSatisfy: a key claim beats a label claim naming another slot", () => {
    expect(
      selectOutputToSatisfy(slots, "document", "Brief", null, "deck")
    ).toBe(1);
    // A proposal filed before keys existed: the label still resolves.
    expect(selectOutputToSatisfy(slots, "document", "Deck", null, null)).toBe(
      1
    );
  });

  it("the three-ledger join honours an artifact's key claim over its label claim, and keys `expected`", () => {
    const artifact: JoinArtifactRow = {
      id: "row",
      kind: "document",
      refId: DOC_A,
      cellKey: null,
      title: "Doc",
      originKind: "user",
      state: "working",
      createdAt: new Date(0),
      expectedLabel: "Brief",
      expectedKey: "deck",
    };
    const { outputs, pendingExpected } = joinSessionOutputs({
      artifacts: [artifact],
      produced: [],
      expectedOutputs: slots,
      proposals: [],
      titles: new Map(),
    });
    expect(outputs[0]!.expected?.label).toBe("Deck");
    expect(outputs[0]!.expected?.key).toBe("deck");
    expect(pendingExpected.map((e) => e.label)).toEqual(["Brief"]);
  });

  it("an artifact claim resolves to the slot's own key and label", () => {
    expect(resolveArtifactSlotClaim(slots, { label: "deck" })).toEqual({
      key: "deck",
      label: "Deck",
    });
    expect(resolveArtifactSlotClaim(slots, { key: "brief" })).toEqual({
      key: "brief",
      label: "Brief",
    });
    expect(resolveArtifactSlotClaim(slots, { label: "Nope" })).toEqual({
      label: "Nope",
    });
    expect(resolveArtifactSlotClaim(slots, {})).toEqual({});
  });

  it("readProposalExpectedKey reads only a non-empty string", () => {
    expect(readProposalExpectedKey({ expectedKey: "deck" })).toBe("deck");
    expect(readProposalExpectedKey({ expectedKey: "  " })).toBeUndefined();
    expect(readProposalExpectedKey({ expectedKey: 4 })).toBeUndefined();
    expect(readProposalExpectedKey(null)).toBeUndefined();
  });
});
