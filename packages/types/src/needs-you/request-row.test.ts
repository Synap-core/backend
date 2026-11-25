/**
 * The request row: three lines of marks and doors from THE shared lens row,
 * never a joined " · " string.
 */
import { describe, expect, it } from "vitest";
import { lensItemsOfClass } from "../lens/page-model.js";
import type { LensNeedsYouSignal } from "../lens/rows.js";
import { requestRow } from "./request-row.js";

const S = "11111111-1111-4111-8111-111111111111";

const owed = (over: Partial<LensNeedsYouSignal> = {}): LensNeedsYouSignal =>
  ({
    id: `slot:${S}:token`,
    kind: "owed-slot",
    title: "GitHub merge token",
    count: 1,
    repeatCount: 1,
    category: "ai",
    groupKey: `session:${S}`,
    ageBucket: "recent",
    occurredAt: "2026-11-13T09:00:00.000Z",
    sessionTitle: "Pod-run delivery",
    target: { kind: "session", id: S },
    by: { kind: "agent", id: "a1", label: "Claude Code" },
    ...over,
  }) as LensNeedsYouSignal;

const rowOf = (s: LensNeedsYouSignal) =>
  lensItemsOfClass([s], "blocking")[0]!.row;

describe("requestRow — what · what it holds · who and where", () => {
  it("line 1: the state mark, the kind tile, the ask, its age", () => {
    const row = rowOf(owed());
    const view = requestRow(row);
    expect(view.what.map((p) => p.kind)).toEqual([
      "state",
      "tile",
      "text",
      "age",
    ]);
    expect(view.what[0]).toEqual({ kind: "state", state: row.state });
    expect(view.what[1]).toMatchObject({
      kind: "tile",
      objectKind: row.objectKind,
    });
    expect(view.what[2]).toEqual({
      kind: "text",
      role: "title",
      text: row.title,
    });
    expect(view.what[3]).toEqual({
      kind: "age",
      at: "2026-11-13T09:00:00.000Z",
    });
  });

  it("line 2: the thing it holds, as a door, with its status now and next", () => {
    const view = requestRow(
      rowOf(
        owed({
          unblocks: "Merging the delivery PR",
          blocks: {
            thing: { id: "t1", name: "Pod-run delivery" },
            statusNow: { key: "ready", label: "Ready" },
            statusNext: { key: "shipped", label: "Shipped" },
          },
        })
      )
    );
    expect(view.holds).toEqual([
      { kind: "label", text: "Holds" },
      {
        kind: "door",
        role: "thing",
        label: "Pod-run delivery",
        door: { kind: "entity", id: "t1" },
      },
      {
        kind: "status",
        now: { key: "ready", label: "Ready" },
        next: { key: "shipped", label: "Shipped" },
      },
    ]);
  });

  it("line 2 without a thing: what the answer unblocks, in the agent's words", () => {
    const view = requestRow(
      rowOf(owed({ unblocks: "Merging the delivery PR" }))
    );
    expect(view.holds).toEqual([
      { kind: "label", text: "Holds" },
      { kind: "text", role: "unblocks", text: "Merging the delivery PR" },
    ]);
  });

  it("line 3: who asked and where from, as doors; the source hides on its own page", () => {
    const row = rowOf(owed());
    // An owed ask's asker opens the session it asked in (the lens row's rule).
    expect(requestRow(row).who).toEqual([
      {
        kind: "door",
        role: "by",
        label: "Claude Code",
        door: { kind: "session", id: S },
      },
      {
        kind: "door",
        role: "source",
        label: "Pod-run delivery",
        door: { kind: "session", id: S },
      },
    ]);
    const onItsSession = requestRow(row, {
      scope: { kind: "session", sessionId: S },
    });
    expect(onItsSession.who.map((p) => p.kind === "door" && p.role)).toEqual([
      "by",
    ]);
  });

  it("no part is a joined sentence", () => {
    const view = requestRow(
      rowOf(owed({ unblocks: "Merging the delivery PR" }))
    );
    for (const part of [...view.what, ...view.holds, ...view.who]) {
      if (part.kind === "text" || part.kind === "label")
        expect(part.text).not.toContain(" · ");
    }
    expect(view.door).toEqual({ kind: "session", id: S });
  });
});
