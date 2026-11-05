import { describe, expect, it } from "vitest";
import { proposalPageT } from "./copy";
import {
  graphBeingResolved,
  resolveRows,
  resolvedToast,
} from "./resolve-item-model";

/**
 * `proposals.resolveOptions` as the pod answers it for the live case of
 * proposal e8fc00d6: the Trend waits (its kind lives in Ecosystem), its three
 * links follow it.
 *
 * Rows that rule out a wrong card:
 *  - the pod lists "skip" BEFORE the recommended choice here, and the card
 *    still puts "File it in Ecosystem" first and "Skip" last (rules out
 *    drawing the wire order blindly);
 *  - "create a kind" is unavailable and is not drawn (rules out a dead
 *    button);
 *  - the three links are not rows: they are filed with the item.
 */
const ANSWER = {
  resolvable: true,
  opCount: 8,
  items: [
    {
      itemRef: "t",
      opIndex: 4,
      op: "create_entity",
      title: "Agent-memory users now demand deletion",
      state: "failed",
      errorClass: "kind_missing",
      kindMissing: {
        profileSlug: "trend",
        kindName: "Trend",
        workspaceId: "ws-f",
        workspaceName: "Foundation",
        foundIn: [{ workspaceId: "ws-e", name: "Ecosystem" }],
      },
      dependents: ["t->p1:relates_to", "t->p2:relates_to", "t->p3:relates_to"],
      options: [
        {
          kind: "skip",
          action: { type: "skip" },
          recommended: false,
          available: true,
        },
        {
          kind: "file_in_workspace",
          action: { type: "file_in_workspace", workspaceId: "ws-e" },
          workspaceName: "Ecosystem",
          kindName: "Trend",
          recommended: true,
          available: true,
        },
        {
          kind: "widen_kind_scope",
          action: { type: "widen_kind_scope", profileId: "prof-trend" },
          kindName: "Trend",
          fromWorkspaceName: "Ecosystem",
          intoWorkspaceName: "Foundation",
          recommended: false,
          available: true,
        },
        {
          kind: "use_kind",
          action: { type: "use_kind", profileSlug: "research" },
          kindName: "Research",
          recommended: false,
          available: true,
        },
        {
          kind: "create_kind",
          action: { type: "create_kind" },
          draft: { slug: "trend", displayName: "Trend", fields: [] },
          recommended: false,
          available: false,
          unavailableReason: "not_yet",
        },
      ],
    },
    ...[1, 2, 3].map((n) => ({
      itemRef: `t->p${n}:relates_to`,
      opIndex: 4 + n,
      op: "create_relation",
      state: "not_run",
      dependents: [],
      options: [
        {
          kind: "skip",
          action: { type: "skip" },
          recommended: false,
          available: true,
        },
      ],
    })),
  ],
};

describe("resolveRows", () => {
  const t = proposalPageT();

  it("draws the waiting item with its choices, recommended first", () => {
    const rows = resolveRows(ANSWER, t);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.itemRef).toBe("t");
    expect(row!.title).toBe("Agent-memory users now demand deletion");
    expect(row!.dependentsNote).toBe("Its 3 links are filed with it.");
    expect(row!.choices.map((c) => c.label)).toEqual([
      "File it in Ecosystem",
      "Make Trend available in Foundation",
      "File it as Research",
      "Skip this item",
    ]);
    expect(row!.choices[0]).toMatchObject({
      recommended: true,
      hint: "Same kind, Trend: nothing new is created",
      action: { type: "file_in_workspace", workspaceId: "ws-e" },
    });
    expect(row!.choices.filter((c) => c.recommended)).toHaveLength(1);
    expect(row!.choices.some((c) => c.action.type === "create_kind")).toBe(
      false
    );
  });

  it("says what a held item waits for, and offers to file it once its kind is here", () => {
    const rows = resolveRows(
      {
        resolvable: true,
        items: [
          {
            ...ANSWER.items[0],
            state: "held",
            reviewProposalId: "rev-1",
            options: [
              {
                kind: "file_here_now",
                action: { type: "use_kind", profileSlug: "trend" },
                kindName: "Trend",
                recommended: true,
                available: true,
              },
              {
                kind: "widen_kind_scope",
                action: { type: "widen_kind_scope", profileId: "prof-trend" },
                kindName: "Trend",
                intoWorkspaceName: "Foundation",
                recommended: false,
                available: false,
                unavailableReason: "review_pending",
              },
            ],
          },
        ],
      },
      t
    );
    expect(rows[0]!.heldNote).toBe(
      "Waits for the review that makes Trend available in Foundation."
    );
    expect(rows[0]!.choices.map((c) => c.label)).toEqual([
      "File it now: Trend is available here",
    ]);
  });

  it("draws nothing for an answer that is not resolvable or not a graph", () => {
    expect(resolveRows({ resolvable: false, items: [] }, t)).toEqual([]);
    expect(resolveRows(undefined, t)).toEqual([]);
    expect(resolveRows({ resolvable: true, items: "x" }, t)).toEqual([]);
  });

  it("drops a choice whose action it cannot send back", () => {
    const rows = resolveRows(
      {
        resolvable: true,
        items: [
          {
            itemRef: "t",
            state: "failed",
            options: [
              {
                kind: "file_in_workspace",
                action: { type: "file_in_workspace" },
                available: true,
              },
              { kind: "skip", action: { type: "skip" }, available: true },
            ],
          },
        ],
      },
      t
    );
    expect(rows[0]!.choices.map((c) => c.key)).toEqual(["skip"]);
  });
});

describe("resolvedToast", () => {
  const t = proposalPageT();
  it("says what happened, in plain words", () => {
    expect(resolvedToast({ complete: true, waiting: 0 }, t).title).toBe(
      "Every item is filed"
    );
    expect(
      resolvedToast({ complete: false, outcome: "filed", waiting: 2 }, t)
    ).toEqual({ title: "Filed · 2 still wait", color: "warning" });
    expect(
      resolvedToast({ complete: false, outcome: "skipped", waiting: 1 }, t)
        .title
    ).toBe("Item skipped · 1 still waits");
    expect(
      resolvedToast({ complete: false, outcome: "held", waiting: 1 }, t).title
    ).toBe("Waiting for the review: the rest is filed");
    expect(
      resolvedToast({ complete: false, outcome: "failed", waiting: 4 }, t)
    ).toEqual({ title: "It still couldn’t be filed", color: "warning" });
  });
});

describe("graphBeingResolved", () => {
  it("is true once an item was resolved or a resolution is under way", () => {
    expect(graphBeingResolved({ materialized: { opCount: 5 } })).toBe(false);
    expect(
      graphBeingResolved({
        materialized: { opCount: 5, resolutions: { t: { outcome: "held" } } },
      })
    ).toBe(true);
    expect(
      graphBeingResolved({
        materialized: {
          opCount: 5,
          resolving: { key: "t", by: "u", token: "x", at: "now" },
        },
      })
    ).toBe(true);
    expect(graphBeingResolved(null)).toBe(false);
  });
});

describe("a run that stopped between two steps", () => {
  it("offers to file the first record it never reached as proposed", () => {
    const rows = resolveRows(
      {
        resolvable: true,
        items: [
          {
            itemRef: "p3",
            op: "create_entity",
            state: "not_run",
            options: [
              {
                kind: "file_as_proposed",
                action: { type: "use_kind", profileSlug: "pain-point" },
                recommended: true,
                available: true,
              },
              { kind: "skip", action: { type: "skip" }, available: true },
            ],
          },
        ],
      },
      proposalPageT()
    );
    expect(rows[0]!.choices.map((c) => c.label)).toEqual([
      "File it as proposed",
      "Skip this item",
    ]);
  });
});
