/**
 * The reactions registry and its guards, pure: which rules match a move, in
 * which order, and what the guards make of their planned writes — chaining and
 * its depth cap, conflicts, D3's proposal into done or lost, a paused rule.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILT_IN_REACTIONS,
  MAX_REACTION_DEPTH,
  OUTCOME_MET_REACTION_ID,
  bornReceiptTransition,
  decideReactionWrites,
  declaredSubjectTypes,
  isReactionEnabled,
  listReactions,
  nextCause,
  reactionMatches,
  reactionReason,
  registerReactionSource,
  registerReactionStateSource,
  resetReactionRegistryForTests,
  type PlannedWrite,
  type ReactionDeclaration,
} from "./reactions.js";

const rule = (
  id: string,
  over: Partial<ReactionDeclaration> = {}
): ReactionDeclaration => ({
  id,
  title: `Rule ${id}`,
  when: { subjectType: "entity", category: ["done"] },
  via: { link: "run_session" },
  do: { effect: "pause_session" },
  order: 50,
  source: "declared",
  enabled: true,
  ...over,
});

const write = (
  subjectId: string,
  to: string,
  toCategory: PlannedWrite["toCategory"] = "active"
): PlannedWrite => ({
  target: { subjectType: "entity", subjectId },
  to,
  toCategory,
  expectedFrom: "open",
  ownerUserId: "u1",
  detail: {},
  say: { name: `Thing ${subjectId}`, applied: `Changed Thing ${subjectId}.` },
});

const SOURCE = { transitionId: "t-1" };

afterEach(() => resetReactionRegistryForTests());

describe("the built-in rules", () => {
  it("declares defaults 3 and 4 with stable ids, plain titles and a fixed order", () => {
    expect(BUILT_IN_REACTIONS.map((r) => [r.id, r.title, r.order])).toEqual([
      [OUTCOME_MET_REACTION_ID, "An outcome is met wherever it was filed", 10],
      [
        "builtin:stopped-run-needs-you",
        "A run that stops early goes to Needs you",
        20,
      ],
    ]);
  });

  it("default 3 opts out of D3 and says why; default 4 never moves into done or lost", () => {
    const [met, stopped] = BUILT_IN_REACTIONS;
    expect(met!.terminal).toBe("apply");
    expect(met!.terminalWhy).toMatch(/approval/);
    expect(stopped!.terminal).toBeUndefined();
  });

  it("the built-ins listen to proposals and runs only", () => {
    expect(
      [...new Set(BUILT_IN_REACTIONS.map((r) => r.when.subjectType))].sort()
    ).toEqual(["playbook_run", "proposal"]);
  });
});

describe("matching", () => {
  it("matches the subject type and one of its statuses or categories", () => {
    const met = BUILT_IN_REACTIONS[0]!;
    const t = { subjectType: "proposal" as const, category: "done" as const };
    expect(reactionMatches(met, { ...t, to: "approved" })).toBe(true);
    expect(reactionMatches(met, { ...t, to: "auto_approved" })).toBe(true);
    expect(
      reactionMatches(met, { ...t, to: "rejected", category: "lost" })
    ).toBe(false);
    expect(
      reactionMatches(met, {
        subjectType: "slot",
        to: "approved",
        category: "done",
      })
    ).toBe(false);
    const any = rule("any", { when: { subjectType: "entity" } });
    expect(
      reactionMatches(any, { subjectType: "entity", to: "x", category: "open" })
    ).toBe(true);
    const byCategory = rule("cat");
    expect(
      reactionMatches(byCategory, {
        subjectType: "entity",
        to: "shipped",
        category: "done",
      })
    ).toBe(true);
  });

  it("a rule naming kinds matches only those kinds' own moves, never a role's", () => {
    const posts = rule("posts", {
      when: {
        subjectType: "entity",
        category: ["done", "lost"],
        profileSlug: ["post"],
      },
    });
    const move = {
      subjectType: "entity" as const,
      to: "published",
      category: "done" as const,
    };
    expect(
      reactionMatches(posts, { ...move, profileSlug: "post", role: null })
    ).toBe(true);
    expect(
      reactionMatches(posts, { ...move, profileSlug: "campaign", role: null })
    ).toBe(false);
    // A role's status moved on its facet: not the post's own lifecycle.
    expect(
      reactionMatches(posts, { ...move, profileSlug: "post", role: "lead" })
    ).toBe(false);
    // A move that names no kind cannot be one of them.
    expect(reactionMatches(posts, move)).toBe(false);
  });
});

describe("the one list", () => {
  it("joins declared rules from a source, in order, and the person's pause", async () => {
    registerReactionSource({
      id: "lane-e",
      subjectTypes: ["entity"],
      list: async () => [
        rule("declared:b", { order: 5 }),
        rule("declared:a", { order: 5 }),
      ],
    });
    registerReactionStateSource(
      async () => new Map([[OUTCOME_MET_REACTION_ID, false]])
    );
    const all = await listReactions();
    expect(all.map((r) => r.id)).toEqual([
      "declared:a",
      "declared:b",
      OUTCOME_MET_REACTION_ID,
      "builtin:stopped-run-needs-you",
    ]);
    expect(all.find((r) => r.id === OUTCOME_MET_REACTION_ID)!.enabled).toBe(
      false
    );
    expect(await isReactionEnabled(OUTCOME_MET_REACTION_ID)).toBe(false);
    expect(await isReactionEnabled("builtin:stopped-run-needs-you")).toBe(true);
    expect(await isReactionEnabled("nope")).toBe(false);
    expect(declaredSubjectTypes().has("entity")).toBe(true);
  });
});

describe("the guards", () => {
  it("carries the cause one link deeper, in the chain of the move that fired it", () => {
    expect(nextCause("r", { transitionId: "t-1" })).toEqual({
      reactionId: "r",
      transitionId: "t-1",
      chainId: "t-1",
      depth: 1,
    });
    expect(
      nextCause("r", {
        transitionId: "t-2",
        cause: { reactionId: "q", transitionId: "t-1", chainId: "c", depth: 2 },
      })
    ).toEqual({ reactionId: "r", transitionId: "t-2", chainId: "c", depth: 3 });
  });

  it("applies a plain write with its cause", () => {
    const r = rule("a");
    const out = decideReactionWrites({
      source: SOURCE,
      planned: [{ reaction: r, writes: [write("e1", "next")] }],
      causedBy: null,
    });
    expect(out.skipped).toEqual([]);
    expect(out.decided).toEqual([
      expect.objectContaining({
        mode: "apply",
        cause: {
          reactionId: "a",
          transitionId: "t-1",
          chainId: "t-1",
          depth: 1,
        },
      }),
    ]);
  });

  it("runs in one fixed order: by order, then id, whatever order they were planned in", () => {
    const out = decideReactionWrites({
      source: SOURCE,
      planned: [
        { reaction: rule("z", { order: 1 }), writes: [write("e3", "x")] },
        { reaction: rule("b", { order: 2 }), writes: [write("e2", "x")] },
        { reaction: rule("a", { order: 2 }), writes: [write("e1", "x")] },
      ],
      causedBy: null,
    });
    expect(out.decided.map((d) => d.reaction.id)).toEqual(["z", "a", "b"]);
  });

  it("a paused rule is skipped with its reason", () => {
    const out = decideReactionWrites({
      source: SOURCE,
      planned: [
        { reaction: rule("a", { enabled: false }), writes: [write("e1", "x")] },
      ],
      causedBy: null,
    });
    expect(out.decided).toEqual([]);
    expect(out.skipped).toEqual([
      expect.objectContaining({
        code: "paused",
        reason: "Left \u201cThing e1\u201d as it was: this rule is paused.",
      }),
    ]);
  });

  it("a move a rule made fires no other rule unless that rule chains", () => {
    const made = rule("maker");
    const caused = {
      transitionId: "t-2",
      cause: {
        reactionId: "maker",
        transitionId: "t-1",
        chainId: "t-1",
        depth: 1,
      },
    };
    const planned = [{ reaction: rule("next"), writes: [write("e9", "x")] }];
    const off = decideReactionWrites({
      source: caused,
      planned,
      causedBy: made,
    });
    expect(off.decided).toEqual([]);
    expect(off.skipped[0]).toMatchObject({ code: "not_chained" });
    expect(off.skipped[0]).toMatchObject({
      reason:
        "Left \u201cThing e9\u201d as it was: another rule made the change, and rules do not set each other off.",
      detail: "caused by maker, which does not chain",
    });

    const on = decideReactionWrites({
      source: caused,
      planned,
      causedBy: { ...made, chains: true },
    });
    expect(on.skipped).toEqual([]);
    expect(on.decided[0]!.cause).toEqual({
      reactionId: "next",
      transitionId: "t-2",
      chainId: "t-1",
      depth: 2,
    });

    // The rule that made it is gone: not chained.
    expect(
      decideReactionWrites({ source: caused, planned, causedBy: null })
        .skipped[0]
    ).toMatchObject({ code: "not_chained" });
  });

  it(`stops a chain deeper than ${MAX_REACTION_DEPTH}, even one that chains`, () => {
    const chaining = rule("roll", { chains: true });
    const at = (depth: number) =>
      decideReactionWrites({
        source: {
          transitionId: `t-${depth}`,
          cause: {
            reactionId: "roll",
            transitionId: "t-0",
            chainId: "c",
            depth,
          },
        },
        planned: [{ reaction: chaining, writes: [write("e1", "x")] }],
        causedBy: chaining,
      });
    expect(at(MAX_REACTION_DEPTH - 1).decided).toHaveLength(1);
    const deep = at(MAX_REACTION_DEPTH);
    expect(deep.decided).toEqual([]);
    expect(deep.skipped[0]).toMatchObject({
      code: "chain_depth",
      cause: { depth: MAX_REACTION_DEPTH + 1, chainId: "c" },
    });
  });

  it("two rules writing one target with different values: a logged conflict, nothing applied there", () => {
    const out = decideReactionWrites({
      source: SOURCE,
      planned: [
        {
          reaction: rule("a"),
          writes: [write("e1", "shipped"), write("e2", "x")],
        },
        { reaction: rule("b"), writes: [write("e1", "archived")] },
      ],
      causedBy: null,
    });
    expect(out.decided.map((d) => d.write.target.subjectId)).toEqual(["e2"]);
    expect(out.skipped.map((s) => [s.reaction.id, s.code])).toEqual([
      ["a", "conflict"],
      ["b", "conflict"],
    ]);
    expect(out.skipped[0]).toMatchObject({
      reason:
        "Left \u201cThing e1\u201d as it was: \u201cRule a\u201d and \u201cRule b\u201d would change it in different ways.",
      detail: "a=shipped, b=archived",
    });
  });

  it("two rules writing the same value: applied once, the second logged", () => {
    const out = decideReactionWrites({
      source: SOURCE,
      planned: [
        { reaction: rule("a"), writes: [write("e1", "shipped")] },
        { reaction: rule("b"), writes: [write("e1", "shipped")] },
      ],
      causedBy: null,
    });
    expect(out.decided.map((d) => d.reaction.id)).toEqual(["a"]);
    expect(out.skipped).toEqual([
      expect.objectContaining({ code: "same_write" }),
    ]);
  });

  it("D3: a move into done or lost is proposed, unless the rule opts out", () => {
    const decide = (r: ReactionDeclaration, cat: PlannedWrite["toCategory"]) =>
      decideReactionWrites({
        source: SOURCE,
        planned: [{ reaction: r, writes: [write("e1", "x", cat)] }],
        causedBy: null,
      }).decided[0]!.mode;
    expect(decide(rule("a"), "done")).toBe("propose");
    expect(decide(rule("a"), "lost")).toBe("propose");
    expect(decide(rule("a"), "paused")).toBe("apply");
    expect(decide(rule("a", { terminal: "apply" }), "done")).toBe("apply");
  });
});

describe("the words the person reads (the Rules list)", () => {
  it("name the thing by its own name, and never an id, a type or an internal word", () => {
    const codes = [
      "proposed",
      "paused",
      "not_chained",
      "chain_depth",
      "conflict",
      "same_write",
      "moved_meanwhile",
      "needs_proposal",
      "effect_unavailable",
      "refused",
      "failed",
    ] as const;
    for (const code of codes) {
      const words = reactionReason(code, "Brief for the launch", {
        others: ["Rule A"],
      });
      expect(words, code).not.toMatch(
        /door|transition|reaction|process|_|[0-9a-f]{8}-[0-9a-f]{4}/i
      );
      if (code !== "effect_unavailable") {
        expect(words, code).toContain("\u201cBrief for the launch\u201d");
      }
    }
  });
});

describe("a receipt born decided (pod default 3's other trigger)", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    status: "auto_approved",
    proposalType: "update",
    targetType: "playbook",
    targetId: "p-1",
    sessionId: null,
    workspaceId: "w-1",
    subjectUserId: "u1",
    createdBy: "agent-1",
    agentUserId: "agent-1",
    createdAt: "2026-11-17T10:00:00.000Z",
  };

  it("reads as the approval it stands for, its own id standing for the move", () => {
    const t = bornReceiptTransition(row)!;
    expect(t).toMatchObject({
      transitionId: row.id,
      subjectType: "proposal",
      subjectId: row.id,
      from: null,
      to: "auto_approved",
      category: "done",
      actorKind: "system",
      userId: "u1",
      targetType: "playbook",
      targetId: "p-1",
    });
    expect(reactionMatches(BUILT_IN_REACTIONS[0]!, t)).toBe(true);
    expect(nextCause(OUTCOME_MET_REACTION_ID, t)).toEqual({
      reactionId: OUTCOME_MET_REACTION_ID,
      transitionId: row.id,
      chainId: row.id,
      depth: 1,
    });
  });

  it("is nothing once it no longer stands auto_approved (its write failed, it was reverted)", () => {
    for (const status of ["approval_failed", "reverted", "pending"]) {
      expect(bornReceiptTransition({ ...row, status })).toBeNull();
    }
  });
});
