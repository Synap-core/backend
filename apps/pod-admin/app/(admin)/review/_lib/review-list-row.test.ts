/**
 * What a Review row draws: the shared request row's three lines
 * (`requestRow`) as marks and doors, never one " · " sentence (the row the
 * founder could not read: "Questions · Owed · Claude Code on MacBook ·
 * Pod-run delivery · Credential missing · 3d ago", plan d717d6ac §0). Under
 * "Group by Work" it also names the decision the row asks, once.
 */
import { describe, expect, it } from "vitest";
import type { RequestRowPart } from "@synap-core/types/needs-you";
import { reviewRows, type ReviewSignal } from "./review-rows";
import { reviewRowView } from "./review-row-view";

function sig(
  over: Partial<ReviewSignal> & { id: string; kind: string }
): ReviewSignal {
  return {
    title: over.id,
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    occurredAt: "2026-10-12T10:00:00.000Z",
    category: "ai",
    target: null,
    ...over,
  };
}

/** The founder's row: a credential ask held by a delivery, from an agent. */
const owed = sig({
  id: "slot:s1:token",
  kind: "owed-slot",
  title: "GitHub token",
  target: { kind: "session", id: "s1" },
  source: { kind: "session", id: "s1", label: "Pod-run delivery" },
  by: { id: "agent-1", label: "Claude Code on MacBook" },
  blockedReason: "credential",
  unblocks: "Merging the delivery PR",
  ask: { mode: "provide", provide: { kind: "secret", name: "GITHUB_TOKEN" } },
} as Partial<ReviewSignal> & { id: string; kind: string });

function rowOf(s: ReviewSignal) {
  const [row] = reviewRows([s], new Map());
  return row!;
}

const kinds = (parts: readonly RequestRowPart[]) => parts.map((p) => p.kind);

describe("reviewRowView — three lines of marks and doors", () => {
  it("line 1: the kind tile, the question, its age — no state mark (everything here waits on you)", () => {
    const view = reviewRowView(rowOf(owed));
    expect(kinds(view.what)).toEqual(["tile", "text", "age"]);
    expect(kinds(view.what)).not.toContain("state");
    const title = view.what.find((p) => p.kind === "text");
    expect(title).toMatchObject({ role: "title" });
  });

  it("line 2: what answering unblocks, in the agent's words", () => {
    const view = reviewRowView(rowOf(owed));
    expect(view.holds).toEqual([
      { kind: "label", text: "Holds" },
      { kind: "text", role: "unblocks", text: "Merging the delivery PR" },
    ]);
  });

  it("line 2: a thing it holds up wins, with its status now and next", () => {
    const view = reviewRowView(
      rowOf(
        sig({
          ...owed,
          id: "slot:s1:token2",
          blocks: {
            thing: { id: "e1", name: "Delivery PR" },
            statusNow: { key: "in_progress", label: "In progress" },
            statusNext: { key: "done", label: "Done" },
          },
        } as Partial<ReviewSignal> & { id: string; kind: string })
      )
    );
    expect(kinds(view.holds)).toEqual(["label", "door", "status"]);
    expect(view.holds[1]).toMatchObject({
      role: "thing",
      label: "Delivery PR",
      door: { kind: "entity", id: "e1" },
    });
  });

  it("line 3: who asked and where, each a door — never a joined string", () => {
    const view = reviewRowView(rowOf(owed));
    expect(view.who.map((p) => p.kind)).toEqual(["door", "door"]);
    expect(view.who[0]).toMatchObject({
      role: "by",
      label: "Claude Code on MacBook",
    });
    expect(view.who[1]).toMatchObject({
      role: "source",
      label: "Pod-run delivery",
      door: { kind: "session", id: "s1" },
    });
    // No part carries the old sentence's separator.
    for (const part of [...view.what, ...view.holds, ...view.who]) {
      if ("text" in part) expect(part.text).not.toContain(" · ");
      if ("label" in part && typeof part.label === "string")
        expect(part.label).not.toContain(" · ");
    }
  });

  it("an ask answers here; its verb is Answer, never inline approve", () => {
    const view = reviewRowView(rowOf(owed));
    expect(view.action).toEqual({ kind: "answer" });
    expect(view.inlineApprove).toBe(false);
  });

  it("names the package outside Group by Package, and says a kind that reads the same word once", () => {
    const knowledge = sig({
      id: "c1",
      kind: "proposal-cluster",
      class: "objectWork",
      package: "knowledge",
      target: { kind: "proposal", id: "p1" },
      proposalIds: ["p1"],
    });
    const row = { ...rowOf(knowledge), nounKind: "knowledge" };
    expect(reviewRowView(row).packageLabel).toBeNull();
    expect(reviewRowView(row, { showPackage: true }).packageLabel).toBeNull();
    const books = { ...row, package: "bookkeeping" as const };
    expect(reviewRowView(books, { showPackage: true }).packageLabel).toBe(
      "Bookkeeping"
    );
    // A proposal's tile is the kind of thing it changes.
    expect(
      reviewRowView(row).what.find((p) => p.kind === "tile")
    ).toMatchObject({
      kind: "tile",
      objectKind: "knowledge",
    });
  });
});
