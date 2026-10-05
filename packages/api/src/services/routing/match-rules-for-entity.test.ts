/**
 * Capture suggestions ask the TRIGGER MATCHER'S OWN predicate which propose
 * rules a capture fires — no second predicate.
 *
 * The discriminating fixtures are the ones the removed SQL predicate
 * (`eventPattern = ANY([...])` + `filters.profileSlug` equality) got WRONG:
 *   - an operator filter (`{ $in: [...] }`) — the SQL equality never matched it;
 *   - a rule scoped to ANOTHER entity — the SQL could not see rule scope;
 *   - an AUTO rule on the same trigger — it already fired; suggesting it is a
 *     double, so it must not be returned.
 * Real `automationTriggerMatches` from @synap/jobs; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  selectProposeRuleMatches,
  type RuleCandidateRow,
} from "./match-rules-for-entity.js";

const E1 = "11111111-1111-4111-8111-111111111111";
const E2 = "22222222-2222-4222-8222-222222222222";
const PB = "33333333-3333-4333-8333-333333333333";

const flow = (mode?: "propose" | "run", playbookId = PB) => ({
  nodes: [
    { id: "t", type: "trigger", data: {} },
    {
      id: "p",
      type: "playbook_run",
      data: { label: "x", playbookId, ...(mode ? { mode } : {}) },
    },
  ],
  edges: [],
});

const row = (
  id: string,
  triggerConfig: Record<string, unknown>,
  // `null` = a node with NO mode (every pre-existing rule: it runs).
  mode: "propose" | "run" | null = "propose"
): RuleCandidateRow => ({
  id,
  name: id,
  description: null,
  triggerConfig,
  flowDefinition: flow(mode ?? undefined),
});

const pick = (rows: RuleCandidateRow[], profileSlug: string, entityId = E1) =>
  selectProposeRuleMatches({
    rows,
    entityId,
    profileSlug,
    projectIds: null,
  }).matches.map((m) => m.id);

describe("selectProposeRuleMatches — the matcher's predicate, propose rules only", () => {
  it("a propose rule on deal creation matches a captured deal, not a company", () => {
    const rows = [
      row("deal", {
        eventPattern: "entity.create.completed",
        filters: { profileSlug: "deal" },
      }),
    ];
    expect(pick(rows, "deal")).toEqual(["deal"]);
    expect(pick(rows, "company")).toEqual([]);
  });

  it("an operator filter matches (the removed SQL equality could not)", () => {
    const rows = [
      row("in", {
        eventPattern: "entity.create.completed",
        filters: { profileSlug: { $in: ["deal", "lead"] } },
      }),
    ];
    expect(pick(rows, "lead")).toEqual(["in"]);
    expect(pick(rows, "note")).toEqual([]);
  });

  it("rule scope is honoured: a rule about ANOTHER entity does not match", () => {
    const rows = [
      row("scoped", {
        eventPattern: "entity.create.completed",
        entityId: E2,
      }),
    ];
    expect(pick(rows, "deal", E1)).toEqual([]);
    expect(pick(rows, "deal", E2)).toEqual(["scoped"]);
  });

  it("AUTO rules are never suggested — they already ran on the capture", () => {
    const rows = [
      row("auto", { eventPattern: "entity.create.completed" }, null),
      row("run", { eventPattern: "entity.*" }, "run"),
      row("prop", { eventPattern: "entity.*" }),
    ];
    expect(pick(rows, "deal")).toEqual(["prop"]);
  });

  it("a rule on another event never matches a capture's entity creation", () => {
    expect(
      pick(
        [row("other", { eventPattern: "proposal.approved.completed" })],
        "deal"
      )
    ).toEqual([]);
  });

  it("reports the rule's own kind filter, and the playbooks propose rules already target", () => {
    const res = selectProposeRuleMatches({
      rows: [
        row("deal", {
          eventPattern: "entity.create.completed",
          filters: { profileSlug: "deal" },
        }),
        // Not fired by this capture, but it IS a standing propose rule for PB.
        row("cron-ish", { eventPattern: "proposal.approved.completed" }),
      ],
      entityId: E1,
      profileSlug: "deal",
      projectIds: null,
    });
    expect(res.matches).toEqual([
      {
        id: "deal",
        name: "deal",
        description: null,
        filterProfileSlug: "deal",
      },
    ]);
    expect([...res.proposedPlaybookIds]).toEqual([PB]);
  });
});
