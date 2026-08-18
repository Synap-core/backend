/**
 * PlaybookStage WRITE-boundary schema tests.
 *
 * The half that makes the rollup category TRUSTWORTHY: nothing NEW lands
 * without a category, and stage keys stay unique. The legacy-read half
 * (`resolveStageCategory`) is tested in @synap/playbooks, next to the type.
 */

import { describe, it, expect } from "vitest";
import {
  PLAYBOOK_STAGE_CATEGORIES,
  resolveStageCategory,
  type PlaybookStage,
} from "@synap/playbooks";
import { playbookStageSchema, playbookStagesSchema } from "./playbook-stage.js";

const validStage = { key: "qualify", name: "Qualify", category: "started" };

describe("playbookStageSchema — the write boundary", () => {
  it("REJECTS a new stage with no category", () => {
    const result = playbookStageSchema.safeParse({
      key: "qualify",
      name: "Qualify",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all six categories and rejects any other", () => {
    for (const category of PLAYBOOK_STAGE_CATEGORIES) {
      expect(
        playbookStageSchema.safeParse({ ...validStage, category }).success
      ).toBe(true);
    }
    for (const bad of ["in-progress", "done", "STARTED", "", null]) {
      expect(
        playbookStageSchema.safeParse({ ...validStage, category: bad }).success
      ).toBe(false);
    }
  });

  it("rejects an empty or whitespace-padded key (it is an id, not prose)", () => {
    expect(
      playbookStageSchema.safeParse({ ...validStage, key: "" }).success
    ).toBe(false);
    expect(
      playbookStageSchema.safeParse({ ...validStage, key: " qualify" }).success
    ).toBe(false);
    expect(
      playbookStageSchema.safeParse({ ...validStage, key: "qualify " }).success
    ).toBe(false);
    expect(
      playbookStageSchema.safeParse({ ...validStage, key: "x".repeat(121) })
        .success
    ).toBe(false);
  });

  it("PRESERVES unknown keys — stages are jsonb; a strict object would drop data", () => {
    const parsed = playbookStageSchema.parse({
      ...validStage,
      somethingAFutureWaveAdded: { nested: true },
    });
    expect(parsed.somethingAFutureWaveAdded).toEqual({ nested: true });
  });

  it("carries the optional stage fields through", () => {
    const parsed = playbookStageSchema.parse({
      ...validStage,
      description: "Decide if this lead is real",
      goal: "A qualified/disqualified verdict",
      grants: [{ kind: "tool", id: "crm" }],
      expectedOutputs: [{ kind: "note", label: "Qualification note" }],
      suggestedTasks: ["Check the company size"],
      position: 2,
      indefinite: false,
    });
    expect(parsed.position).toBe(2);
    expect(parsed.indefinite).toBe(false);
    expect(parsed.grants).toEqual([{ kind: "tool", id: "crm" }]);
  });
});

describe("playbookStagesSchema — the list", () => {
  it("REJECTS duplicate keys within one playbook", () => {
    // focus_sessions.currentStage stores the bare key, so a duplicate makes the
    // active stage ambiguous.
    const result = playbookStagesSchema.safeParse([
      validStage,
      { key: "close", name: "Close", category: "completed" },
      { key: "qualify", name: "Qualify again", category: "paused" },
    ]);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([2, "key"]);
      expect(result.error.issues[0]?.message).toContain("qualify");
    }
  });

  it("accepts a distinct-key list and an empty list", () => {
    expect(
      playbookStagesSchema.safeParse([
        validStage,
        { key: "close", name: "Close", category: "completed" },
      ]).success
    ).toBe(true);
    expect(playbookStagesSchema.safeParse([]).success).toBe(true);
  });

  it("rejects the whole list when ONE stage is missing a category", () => {
    expect(
      playbookStagesSchema.safeParse([
        validStage,
        { key: "close", name: "Close" },
      ]).success
    ).toBe(false);
  });
});

describe("position — orders WITHIN a category group, not globally", () => {
  it("groups on category, then orders by position inside each group", () => {
    // Deliberately authored so a GLOBAL sort by position would interleave the
    // groups — proving the two axes are independent.
    const stages = playbookStagesSchema.parse([
      { key: "won", name: "Won", category: "completed", position: 0 },
      { key: "new", name: "New", category: "backlog", position: 1 },
      { key: "lost", name: "Lost", category: "completed", position: 1 },
      { key: "raw", name: "Raw", category: "backlog", position: 0 },
    ]);

    const byCategory = new Map<string, typeof stages>();
    for (const stage of stages) {
      const category = resolveStageCategory(stage);
      byCategory.set(category, [...(byCategory.get(category) ?? []), stage]);
    }
    for (const group of byCategory.values()) {
      group.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }

    expect(byCategory.get("backlog")?.map((s) => s.key)).toEqual([
      "raw",
      "new",
    ]);
    expect(byCategory.get("completed")?.map((s) => s.key)).toEqual([
      "won",
      "lost",
    ]);
  });
});

describe("schema ↔ PlaybookStage interface", () => {
  it("a schema-parsed stage satisfies the contract type", () => {
    const stage: PlaybookStage = playbookStageSchema.parse(validStage);
    expect(stage.category).toBe("started");
  });
});
