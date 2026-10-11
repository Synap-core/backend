/**
 * Next steps before filing (D6): both match doors, asked once per kind, merged
 * into one bounded ranked list.
 */

import { describe, it, expect, vi } from "vitest";
import {
  findCaptureSuggestions,
  mergeCaptureSuggestions,
} from "../capture-suggestions.js";

describe("mergeCaptureSuggestions", () => {
  it("ranks playbooks and rules together by score, naming the row each needs filed", () => {
    const merged = mergeCaptureSuggestions([
      {
        tempId: "t1",
        playbooks: [
          {
            id: "pb-produce",
            name: "Produce Content",
            score: 5,
            reason: "about a post",
            subjectProfileSlug: "post",
          },
          {
            id: "pb-plan",
            name: "Plan Next Content",
            score: 3,
            subjectProfileSlug: null,
          },
        ],
        rules: [{ id: "r-1", name: "Tag new posts", score: 4 }],
      },
    ]);
    expect(merged).toEqual([
      {
        kind: "playbook",
        id: "pb-produce",
        title: "Produce Content",
        forTempId: "t1",
        reason: "about a post",
      },
      { kind: "rule", id: "r-1", title: "Tag new posts", forTempId: "t1" },
      // A subject-less playbook needs nothing filed first.
      {
        kind: "playbook",
        id: "pb-plan",
        title: "Plan Next Content",
        forTempId: null,
      },
    ]);
  });

  it("one entry per step across rows, and never more than six", () => {
    const step = (i: number) => ({
      id: `pb-${i}`,
      name: `Step ${i}`,
      score: i,
    });
    const merged = mergeCaptureSuggestions([
      {
        tempId: "t1",
        playbooks: [step(1), step(2), step(3), step(4)],
        rules: [],
      },
      {
        tempId: "t2",
        playbooks: [step(4), step(5), step(6), step(7)],
        rules: [],
      },
    ]);
    expect(merged).toHaveLength(6);
    expect(new Set(merged.map((s) => s.id)).size).toBe(6);
    expect(merged.find((s) => s.id === "pb-4")?.forTempId).toBe("t1");
  });
});

describe("findCaptureSuggestions", () => {
  it("asks each door once per distinct kind, with the note as intent", async () => {
    const matchPlaybooks = vi.fn(
      async (_input: Record<string, unknown>): Promise<never[]> => []
    );
    const matchRules = vi.fn(async () => []);
    const out = await findCaptureSuggestions({
      rows: [
        { tempId: "t1", profileSlug: "post" },
        { tempId: "t2", profileSlug: "post" },
        { tempId: "t3", profileSlug: "task" },
      ],
      workspaceId: "ws-1",
      intentText: "idea of content for synap",
      doors: { matchPlaybooks, matchRules },
    });
    expect(out).toEqual([]);
    expect(matchPlaybooks.mock.calls.map((c) => c[0])).toEqual([
      {
        profileSlug: "post",
        workspaceId: "ws-1",
        intentText: "idea of content for synap",
      },
      {
        profileSlug: "task",
        workspaceId: "ws-1",
        intentText: "idea of content for synap",
      },
    ]);
    expect(matchRules).toHaveBeenCalledTimes(2);
  });

  it("a failing door THROWS — the caller stores no suggestions, never an empty list", async () => {
    await expect(
      findCaptureSuggestions({
        rows: [{ tempId: "t1", profileSlug: "post" }],
        workspaceId: "ws-1",
        intentText: "x",
        doors: {
          matchPlaybooks: async () => {
            throw new Error("down");
          },
          matchRules: async () => [],
        },
      })
    ).rejects.toThrow("down");
  });
});
