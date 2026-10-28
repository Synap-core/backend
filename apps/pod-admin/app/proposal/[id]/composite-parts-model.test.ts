/**
 * A composite's update of a skill names the skill it rewrites and shows what
 * each field holds now (`graph.updates[].targetName`, `fields[].before`, read
 * by the pod while the proposal is pending). Rows that rule out a wrong rule:
 * an excerpted before is never diffed against a whole after (the cut would
 * read as removed text); a graph from an older pod, with neither, still draws.
 */
import { describe, expect, it } from "vitest";
import {
  CAN_REACH_LABEL,
  type ProposalReviewGraph,
} from "@synap-core/types/proposals";
import { compositeItems, turnOnRecords } from "./composite-parts-model";

const SKILL_ID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
const NEW_BODY = "## Creative director\n\nWrite the new way.";

type Update = NonNullable<ProposalReviewGraph["updates"]>[number];

function graphWith(update: Partial<Update>): ProposalReviewGraph {
  return {
    entities: [],
    relations: [],
    entityCount: 0,
    relationCount: 0,
    facetCount: 0,
    updates: [
      {
        ref: "u1",
        op: "update_skill",
        kind: "skill",
        targetId: SKILL_ID,
        fields: [{ key: "body", value: NEW_BODY, truncated: false }],
        ...update,
      },
    ],
  };
}

const payload = {
  operations: [
    {
      op: "update_skill",
      ref: "u1",
      skillId: SKILL_ID,
      patch: { body: NEW_BODY },
    },
  ],
};

function updateRecord(graph: ProposalReviewGraph) {
  const [item] = compositeItems(graph, payload, () => undefined);
  if (item?.shape !== "record") throw new Error("no record drawn");
  return item.record;
}

describe("compositeItems — an update to a skill", () => {
  it("names the skill in its heading and its door", () => {
    const record = updateRecord(graphWith({ targetName: "creative-director" }));
    expect(record.title).toContain("creative-director");
    const target = record.fields.find((f) => f.key === "target");
    expect(target?.after).toMatchObject({
      kind: "ref",
      name: "creative-director",
    });
  });

  it("a whole before: the body reads as what changes", () => {
    const record = updateRecord(
      graphWith({
        fields: [
          {
            key: "body",
            value: NEW_BODY,
            truncated: false,
            before: "## Creative director\n\nWrite the old way.",
            beforeTruncated: false,
          },
        ],
      })
    );
    const body = record.fields.find((f) => f.key === "body");
    expect(body?.after?.kind).toBe("changes");
    expect(body?.before).toBeUndefined();
  });

  it("an excerpted before is shown as it was, beside the whole new body", () => {
    const record = updateRecord(
      graphWith({
        fields: [
          {
            key: "body",
            value: NEW_BODY,
            truncated: false,
            before: "Write the old",
            beforeTruncated: true,
          },
        ],
      })
    );
    const body = record.fields.find((f) => f.key === "body");
    expect(body?.op).toBe("change");
    expect(body?.before).toMatchObject({
      kind: "text",
      text: "Write the old…",
    });
    expect(body?.after).toMatchObject({ kind: "code", text: NEW_BODY });
  });

  it("from a pod that read neither: the noun, and the new body whole", () => {
    const record = updateRecord(graphWith({}));
    const target = record.fields.find((f) => f.key === "target");
    expect(target?.after).toMatchObject({ kind: "ref", id: SKILL_ID });
    const body = record.fields.find((f) => f.key === "body");
    expect(body?.before).toBeUndefined();
    expect(body?.after).toMatchObject({ kind: "code", text: NEW_BODY });
  });
});

describe("compositeItems — what an acting part can reach", () => {
  const automationGraph = (
    reach?: NonNullable<ProposalReviewGraph["automations"]>[number]["reach"]
  ): ProposalReviewGraph => ({
    entities: [],
    relations: [],
    entityCount: 0,
    relationCount: 0,
    facetCount: 0,
    automations: [
      {
        ref: "beh1",
        name: "Scrape new leads",
        triggerType: "cron",
        bornEnabled: false,
        ...(reach ? { reach } : {}),
      },
    ],
  });
  const automationPayload = {
    operations: [
      {
        op: "create_automation",
        ref: "beh1",
        name: "Scrape new leads",
        triggerType: "cron",
        flowDefinition: {
          nodes: [
            { id: "t", type: "trigger", data: {} },
            {
              id: "n1",
              type: "capability",
              data: { verbId: "apify.run_actor" },
            },
          ],
          edges: [],
        },
      },
    ],
  };
  const automationRecord = (graph: ProposalReviewGraph) => {
    const [item] = compositeItems(graph, automationPayload, () => undefined);
    if (item?.shape !== "record") throw new Error("no record drawn");
    return item.record;
  };

  it("an automation says the hosts and connections its steps reach", () => {
    const record = automationRecord(
      automationGraph({
        hosts: ["api.apify.com"],
        connections: ["Apify"],
        unreadSteps: 0,
      })
    );
    const reach = record.fields.find((f) => f.key === "canReach");
    expect(reach?.label).toBe(CAN_REACH_LABEL);
    expect(reach?.after).toMatchObject({
      kind: "text",
      text: "api.apify.com, your existing Apify connection",
    });
  });

  it("a step the pod could not read is 'not known', never 'nothing'", () => {
    const record = automationRecord(
      automationGraph({ hosts: [], connections: [], unreadSteps: 1 })
    );
    const reach = record.fields.find((f) => f.key === "canReach");
    expect(reach?.after).toMatchObject({ text: "Not known for 1 step" });
  });

  it("not measured (an older pod): no reach fact at all", () => {
    const record = automationRecord(automationGraph());
    expect(record.fields.find((f) => f.key === "canReach")).toBeUndefined();
  });

  it("its step reads as words, never the raw verb id", () => {
    const record = automationRecord(automationGraph());
    const runs = record.fields.find((f) => f.key === "runs");
    expect(JSON.stringify(runs?.after)).toContain("Run actor (Apify)");
    expect(JSON.stringify(runs?.after)).not.toContain("apify.run_actor");
  });

  it("an update says what the skill it rewrites can reach", () => {
    const record = updateRecord(
      graphWith({
        reach: { hosts: ["api.old.example"], connections: [], unreadSteps: 0 },
      })
    );
    const reach = record.fields.find((f) => f.key === "canReach");
    expect(reach?.after).toMatchObject({ text: "api.old.example" });
  });
});

describe("turnOnRecords — what a turn-on request switches on", () => {
  it("an instruction reads as its whole instructions, with no reach", () => {
    const [record] = turnOnRecords({
      skills: [
        {
          id: SKILL_ID,
          name: "Creative director",
          kind: "instruction",
          executionMode: "sandbox",
          body: NEW_BODY,
        },
      ],
      unreadSkills: 0,
    });
    expect(record?.fields.map((f) => f.key)).toEqual(["instructions"]);
    expect(record?.fields[0]?.after).toMatchObject({
      kind: "code",
      text: NEW_BODY,
    });
  });

  it("a box script shows its declaration, not a sandbox reach", () => {
    const [record] = turnOnRecords({
      skills: [
        {
          id: SKILL_ID,
          name: "local_backup",
          kind: "code",
          executionMode: "box",
          code: "console.log(1)",
          box: { hosts: ["backup.example.test"] },
        },
      ],
      unreadSkills: 0,
    });
    expect(record?.fields.map((f) => f.key)).toEqual(["code", "declaration"]);
    expect(record?.fields[1]?.after).toMatchObject({ kind: "code" });
    expect(JSON.stringify(record?.fields[1]?.after)).toContain(
      "backup.example.test"
    );
  });
});
