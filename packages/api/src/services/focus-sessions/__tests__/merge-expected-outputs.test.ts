/**
 * `mergeExpectedOutputs` — what a wholesale `expectedOutputs` patch may destroy.
 *
 * THE DEFECT. Three doors (tRPC `focusSessions.update`, the Hub REST PATCH, and
 * the MCP service) accept the whole array and assigned it verbatim, while the
 * surfaces that call them — the browser session board above all — read the list,
 * edit one slot, and send everything back. Every field those clients did not
 * know about was therefore erased on the next edit: a slot's DELEGATION, the
 * reviewer's RETURN note, and the `satisfiedByProposalId` lineage behind its
 * `done` all disappeared because somebody renamed a sibling. The wire schema
 * made it worse — zod STRIPPED those keys at the parse, so even a client that
 * did echo them back lost them before any merge could see them.
 *
 * The rule these pin: silence is not an instruction to delete. An incoming item
 * that says nothing about a server-owned field keeps the stored one; an item
 * that carries the field explicitly wins. Deleting a slot still means OMITTING
 * it — that is the deliberate semantic of a wholesale assignment and the merge
 * does not change it.
 */
import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  mergeExpectedOutputs,
  expectedOutputWireSchema,
} from "../update-session.js";

const stored = (): ExpectedOutput[] => [
  {
    kind: "document",
    label: "Spec",
    delegatedTo: "workspace-builder",
    delegatedAt: "2026-09-01T00:00:00.000Z",
  },
  {
    kind: "document",
    label: "Summary",
    status: "done",
    satisfiedByProposalId: "prop-1",
    claimedDone: true,
  },
  {
    kind: "entity",
    label: "Client record",
    returnedReason: "wrong company",
    returnedAt: "2026-09-02T00:00:00.000Z",
  },
];

/** What a client written against the OLD four-field shape sends back. */
const narrow = (o: ExpectedOutput) => ({
  kind: o.kind,
  label: o.label,
  ...(o.icon ? { icon: o.icon } : {}),
  ...(o.status ? { status: o.status } : {}),
});

describe("mergeExpectedOutputs", () => {
  it("carries the server-owned fields a narrow client never sent", () => {
    const next = mergeExpectedOutputs(stored(), stored().map(narrow));

    expect(next[0]).toMatchObject({
      label: "Spec",
      delegatedTo: "workspace-builder",
      delegatedAt: "2026-09-01T00:00:00.000Z",
    });
    expect(next[1]).toMatchObject({
      label: "Summary",
      status: "done",
      satisfiedByProposalId: "prop-1",
      claimedDone: true,
    });
    expect(next[2]).toMatchObject({
      label: "Client record",
      returnedReason: "wrong company",
      returnedAt: "2026-09-02T00:00:00.000Z",
    });
  });

  it("still applies the client's own edits to the fields it DOES own", () => {
    const incoming = stored().map(narrow);
    incoming[0] = { ...incoming[0]!, kind: "view" };
    const next = mergeExpectedOutputs(stored(), incoming);
    expect(next[0]).toMatchObject({
      kind: "view",
      delegatedTo: "workspace-builder",
    });
  });

  it("a ROUND-TRIP of the stored value is accepted, not treated as a write", () => {
    const incoming: ExpectedOutput[] = [
      { kind: "document", label: "Spec", delegatedTo: "workspace-builder" },
    ];
    expect(mergeExpectedOutputs(stored(), incoming)[0]).toMatchObject({
      delegatedTo: "workspace-builder",
    });
  });

  it("but an explicit CHANGE to a server stamp is REFUSED", () => {
    // CORRECTED 2026-09-08. This case asserted the opposite — "an explicit value
    // wins" — which was the wholesale bypass in one line: the rule that let a
    // patch reassign `delegatedTo` equally let it write `status: "done"` on a
    // slot the agent had declared blocked on the human, with no receipt and no
    // proposal. `owner`/`blockedReason`/`why` still work this way (see below);
    // the receipts do not.
    const incoming: ExpectedOutput[] = [
      { kind: "document", label: "Spec", delegatedTo: "researcher" },
    ];
    expect(() => mergeExpectedOutputs(stored(), incoming)).toThrow(
      /server-stamped/i
    );
  });

  it("matches by the ONE label comparison — trimmed and case-insensitive", () => {
    const incoming = [{ kind: "document", label: "  spec " }];
    expect(mergeExpectedOutputs(stored(), incoming)[0]).toMatchObject({
      // The incoming casing is the caller's edit and stands; the server-owned
      // fields are what get carried.
      label: "  spec ",
      delegatedTo: "workspace-builder",
    });
  });

  it("OMITTING a slot still deletes it — a wholesale patch is still wholesale", () => {
    const next = mergeExpectedOutputs(stored(), [
      { kind: "document", label: "Spec" },
    ]);
    expect(next).toHaveLength(1);
    expect(next.map((o) => o.label)).toEqual(["Spec"]);
  });

  it("a label the stored array never had is a NEW slot, verbatim", () => {
    const next = mergeExpectedOutputs(stored(), [
      { kind: "view", label: "Pipeline board" },
    ]);
    expect(next).toEqual([{ kind: "view", label: "Pipeline board" }]);
  });

  it("is a no-op on an empty stored array", () => {
    const incoming = [{ kind: "document", label: "Spec" }];
    expect(mergeExpectedOutputs([], incoming)).toEqual(incoming);
  });
});

describe("expectedOutputWireSchema", () => {
  it("PARSES the server-owned fields instead of stripping them", () => {
    // The half of the defect that lived in the schema: zod drops what it does
    // not declare, so a client echoing a full slot lost these before any merge.
    const slot = {
      kind: "document",
      label: "Spec",
      icon: "file",
      status: "done" as const,
      claimedDone: true,
      satisfiedByProposalId: "prop-1",
      delegatedTo: "workspace-builder",
      delegatedAt: "2026-09-01T00:00:00.000Z",
      returnedReason: "too long",
      returnedAt: "2026-09-02T00:00:00.000Z",
    };
    expect(expectedOutputWireSchema.parse(slot)).toEqual(slot);
  });

  it("still requires kind + label, and still rejects an unknown status", () => {
    expect(() => expectedOutputWireSchema.parse({ label: "Spec" })).toThrow();
    expect(() =>
      expectedOutputWireSchema.parse({
        kind: "document",
        label: "Spec",
        status: "in_progress",
      })
    ).toThrow();
  });
});
