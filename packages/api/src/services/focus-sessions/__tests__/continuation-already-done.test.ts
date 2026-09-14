/**
 * `deriveAlreadyDone` — the "do not redo" rule behind `continuation.alreadyDone`.
 * Pure, so driven with the real `SessionOutput` / `ExpectedOutput` shapes.
 *
 * What it pins: in-progress and swept outputs are NOT done; a done slot an
 * output already stands for is listed once; the total is exact across the
 * three ledgers even when the item list is cut.
 */

import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  deriveAlreadyDone,
  PACKET_TOP_N,
  type PacketDoneItem,
} from "../continuation-packet.js";
import type { SessionOutput } from "../session-outputs.js";

const out = (
  title: string,
  at: string,
  over: Partial<SessionOutput> = {}
): SessionOutput => ({
  id: `document:${title}`,
  kind: "document",
  refId: `ref-${title}`,
  title,
  producedAt: new Date(at),
  source: ["artifact"],
  ...over,
});

const none = { total: 0, items: [] as PacketDoneItem[] };

describe("deriveAlreadyDone", () => {
  it("kept and state-less outputs are done; working and swept ones are not", () => {
    const r = deriveAlreadyDone({
      outputs: [
        out("Kept", "2026-09-01T00:00:00.000Z", { state: "kept" }),
        out("Edge", "2026-09-02T00:00:00.000Z", { source: ["produced_edge"] }),
        out("WIP", "2026-09-03T00:00:00.000Z", { state: "working" }),
        out("Tossed", "2026-09-04T00:00:00.000Z", { state: "swept" }),
      ],
      expectedOutputs: [],
      appliedProposals: none,
    });
    expect(r).toEqual({
      status: "ok",
      total: 2,
      items: [
        expect.objectContaining({ source: "output", title: "Edge" }),
        expect.objectContaining({ source: "output", title: "Kept" }),
      ],
    });
  });

  it("a done slot an output stands for is listed once, as the output", () => {
    const brief = {
      kind: "document",
      label: "Brief",
      status: "done",
    } as ExpectedOutput;
    const r = deriveAlreadyDone({
      outputs: [
        out("Brief v2", "2026-09-01T00:00:00.000Z", {
          state: "kept",
          expected: brief,
        }),
      ],
      expectedOutputs: [brief],
      appliedProposals: none,
    });
    expect(r).toMatchObject({ total: 1, items: [{ source: "output" }] });
  });

  it("done and attested slots count; pending, claimed-only and retired ones do not", () => {
    const r = deriveAlreadyDone({
      outputs: [],
      expectedOutputs: [
        {
          kind: "document",
          label: "Brief",
          status: "done",
          satisfiedByProposalId: "p-1",
        },
        {
          kind: "credential",
          label: "Stripe key",
          owner: "human",
          attestedBy: "user-1",
          attestedAt: "2026-09-10T00:00:00.000Z",
        },
        { kind: "document", label: "Pending" },
        { kind: "document", label: "Claimed", claimedDone: true },
        {
          kind: "document",
          label: "Dropped",
          status: "done",
          retiredAt: "2026-09-11T00:00:00.000Z",
        },
      ] as ExpectedOutput[],
      appliedProposals: none,
    });
    expect(r).toEqual({
      status: "ok",
      total: 2,
      items: [
        {
          source: "deliverable",
          kind: "credential",
          title: "Stripe key",
          at: "2026-09-10T00:00:00.000Z",
          sourceId: null,
        },
        {
          source: "deliverable",
          kind: "document",
          title: "Brief",
          at: null,
          sourceId: "p-1",
        },
      ],
    });
  });

  it("the total spans all ledgers while items stop at PACKET_TOP_N, newest first", () => {
    const proposal = (n: number): PacketDoneItem => ({
      source: "proposal",
      kind: "company",
      title: `Created company ${n}`,
      at: `2026-09-2${n}T00:00:00.000Z`,
      sourceId: `p-${n}`,
    });
    const r = deriveAlreadyDone({
      outputs: [out("Old", "2026-09-01T00:00:00.000Z", { state: "kept" })],
      expectedOutputs: [
        { kind: "document", label: "Undated", status: "done" },
      ] as ExpectedOutput[],
      // 9 applied proposals in the ledger, its top 5 read.
      appliedProposals: {
        total: 9,
        items: [5, 4, 3, 2, 1].map(proposal),
      },
    });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.total).toBe(11);
    expect(r.items).toHaveLength(PACKET_TOP_N);
    expect(r.items.map((i) => i.sourceId)).toEqual([
      "p-5",
      "p-4",
      "p-3",
      "p-2",
      "p-1",
    ]);
  });
});
