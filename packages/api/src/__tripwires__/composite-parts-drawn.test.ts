/**
 * NOBODY APPROVES A PART THEY CANNOT SEE — the pod's review projection of a
 * mixed ("capture graph") proposal, driven through pod-admin's proposal page
 * model.
 *
 * THE DEFECT: the server listed a graph's skills, automations and rules
 * (`buildConfigReviewItems`, `routers/proposals/display.ts`) and NO client drew
 * them. pod-admin's proposal page drew one card per `create_entity` op; an
 * agent's capture carrying an instruction skill, an automation and a rule was
 * approved with those three unseen (they sat only in the raw request under
 * Advanced). Neither half of that was wrong on its own: the projection was
 * right, the page simply never read it.
 *
 * HOW THIS IS DERIVED, not hand-listed:
 *   - the input carries ONE op of EVERY composite op kind: `ONE_OF_EACH` is
 *     typed over `CompositeProposalOperation["op"]`, so an op kind added to the
 *     union does not compile here until it has a row;
 *   - the keys checked are the ones the REAL projection (`buildProposalGraph`)
 *     EMITS for that input (every non-empty array key), not a list;
 *   - each emitted key must yield at least one drawn item in pod-admin's
 *     model (`compositeItems`) tagged with that key, so a key the model reads
 *     none of fails by name.
 * pod-admin's `DRAWERS` is additionally typed over every array key of
 * `ProposalReviewGraph` (a compile-time floor on the page side).
 *
 * NOT covered (measured by what the test can see): that the page MOUNTS the
 * model's items. `ProposalReviewCard.tsx` maps every record item to a
 * `ProposedRecordCard` and every edge to `PartEdgeList`; a renderer that
 * dropped them after the model would pass here. Visual: NEEDS-DOGFOOD.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import type {
  CompositeProposalData,
  CompositeProposalOperation,
  ProposalReviewGraph,
} from "@synap-core/types/proposals";
import { buildProposalGraph } from "../routers/proposals/display.js";

/**
 * pod-admin's model, loaded at RUN time: a static import would pull a file
 * outside this package's `rootDir` into its `tsc` program. Its shape is
 * restated below as the slice this test reads.
 */
type DrawnItem =
  | {
      source: string;
      shape: "record";
      record: {
        title: string | null;
        fields: Array<{ key: string; after: unknown }>;
      };
    }
  | { source: string; shape: "edge" };
const MODEL = fileURLToPath(
  new URL(
    "../../../../apps/pod-admin/app/proposal/[id]/composite-parts-model.ts",
    import.meta.url
  )
);
const { compositeItems } = (await import(/* @vite-ignore */ MODEL)) as {
  compositeItems: (
    graph: ProposalReviewGraph,
    payload: unknown,
    definitionsFor: (kind: string) => undefined
  ) => DrawnItem[];
};

type OpKind = CompositeProposalOperation["op"];

const UUID = "7d4f6c0e-6a1b-4a8e-9a53-3f2b1c0d9e11";
/** Longer than the projection's 280-char excerpt, on several lines. */
const LONG_BODY = Array.from(
  { length: 60 },
  (_, i) => `Line ${i + 1}: look in the Builder space first, then ask.`
).join("\n");

const ONE_OF_EACH = {
  create_entity: {
    op: "create_entity",
    ref: "acme",
    profileSlug: "company",
    title: "Acme",
    facets: [{ profileSlug: "client" }],
  },
  create_relation: {
    op: "create_relation",
    type: "works_at",
    sourceRef: "acme",
    targetRef: UUID,
  },
  create_skill: {
    op: "create_skill",
    ref: "fact1",
    name: "Where the work is",
    slug: "team/where-the-work-is",
    body: LONG_BODY,
    scope: "workspace",
  },
  create_automation: {
    op: "create_automation",
    ref: "beh1",
    name: "Brief a new client",
    triggerType: "event",
    flowDefinition: {
      triggerConfig: { eventPattern: "entity.create.completed" },
      nodes: [
        { id: "n1", type: "skill", data: { skillName: "Where the work is" } },
      ],
      edges: [],
    },
    enabled: true,
  },
  create_rule: {
    op: "create_rule",
    ref: "rule1",
    intent: "When a client arrives, brief it from the Builder space",
    scope: { kind: "workspace" },
    factRef: "fact1",
    behaviourRefs: ["beh1"],
  },
  create_playbook: {
    op: "create_playbook",
    ref: "pb1",
    name: "Onboard a client",
    goalTemplate: "Onboard {name}",
    subjectProfile: { profileSlug: "company" },
  },
  create_view: {
    op: "create_view",
    ref: "v1",
    name: "New clients",
    viewType: "list",
    entityRefs: ["acme"],
  },
  create_project: {
    op: "create_project",
    ref: "p1",
    name: "Acme onboarding",
    subjectRef: "acme",
  },
  create_session: {
    op: "create_session",
    ref: "s1",
    goal: "Acme live",
    projectRef: "p1",
  },
  create_document: {
    op: "create_document",
    ref: "doc1",
    title: "Spec",
    content: "# Spec",
    sessionRef: "s1",
  },
  create_link: {
    op: "create_link",
    type: "blocked_by",
    fromRef: "s1",
    toSessionId: UUID,
  },
  update_skill: {
    op: "update_skill",
    ref: "u-skill",
    skillId: UUID,
    patch: { body: LONG_BODY },
  },
  update_automation: {
    op: "update_automation",
    ref: "u-auto",
    automationId: UUID,
    patch: { name: "Renamed" },
  },
  update_rule: {
    op: "update_rule",
    ref: "u-rule",
    ruleId: UUID,
    patch: { intent: "Always brief" },
  },
  update_playbook: {
    op: "update_playbook",
    ref: "u-pb",
    playbookId: UUID,
    patch: { name: "Onboard" },
  },
  update_view: {
    op: "update_view",
    ref: "u-view",
    viewId: UUID,
    patch: { name: "Clients" },
  },
  update_entity: {
    op: "update_entity",
    ref: "u-entity",
    entityId: UUID,
    patch: { title: "Acme Corp" },
  },
} satisfies { [K in OpKind]: Extract<CompositeProposalOperation, { op: K }> };

/**
 * A record the graph only LINKS, which gains a role: it is not created, but
 * approving changes it (the facet attaches, or moves forward).
 */
const LINKED_GAINS_ROLE = {
  op: "create_entity",
  ref: "bob",
  profileSlug: "person",
  title: "Bob",
  existingEntityId: "2b6e1a9c-0f3d-4c51-8e7a-5d9b4f2a1c33",
  facets: [{ profileSlug: "lead", status: "qualified", advanceExisting: true }],
} satisfies Extract<CompositeProposalOperation, { op: "create_entity" }>;

const data: CompositeProposalData = {
  operations: [
    ...(Object.values(ONE_OF_EACH) as CompositeProposalOperation[]),
    LINKED_GAINS_ROLE,
  ],
};

/** Every key the projection filled for this input. */
function emittedKeys(graph: ProposalReviewGraph): string[] {
  return Object.entries(graph)
    .filter(([, value]) => Array.isArray(value) && value.length > 0)
    .map(([key]) => key);
}

describe("every part the pod projects is drawn on pod-admin's proposal page", () => {
  const graph = buildProposalGraph(data);
  const items = compositeItems(graph, data, () => undefined);
  const keys = emittedKeys(graph);

  it("the projection lists the parts of a graph of every op kind (non-vacuity)", () => {
    // 12 today: entities, relations, skills, automations, rules, playbooks,
    // views, updates, projects, sessions, documents, links.
    expect(keys.length).toBeGreaterThanOrEqual(12);
    expect(keys).toEqual(
      expect.arrayContaining(["skills", "automations", "rules"])
    );
  });

  it("each emitted key yields a drawn part", () => {
    const drawn = new Set(items.map((item) => item.source));
    expect(keys.filter((key) => !drawn.has(key))).toEqual([]);
  });

  it("a skill's instructions are drawn WHOLE, as code (never the excerpt)", () => {
    const skill = items.find(
      (i) => i.source === "skills" && i.shape === "record"
    );
    expect(skill?.shape === "record" && skill.record.title).toBe(
      "Where the work is"
    );
    const body =
      skill?.shape === "record"
        ? skill.record.fields.find((f) => f.key === "body")?.after
        : undefined;
    expect(body).toEqual({
      kind: "code",
      text: LONG_BODY,
      lines: LONG_BODY.split("\n").length,
    });
    // The input really is longer than the projection's excerpt.
    expect(graph.skills?.[0]?.bodyTruncated).toBe(true);
  });

  it("an automation says when it fires, what it runs, and that it is born off", () => {
    const auto = items.find((i) => i.source === "automations");
    const fields =
      auto?.shape === "record"
        ? Object.fromEntries(auto.record.fields.map((f) => [f.key, f.after]))
        : {};
    expect(fields.status).toEqual(
      expect.objectContaining({ kind: "status", raw: "draft" })
    );
    expect(fields.trigger).toEqual(expect.objectContaining({ kind: "text" }));
    expect(fields.runs).toEqual(
      expect.objectContaining({
        kind: "tags",
        items: [expect.stringContaining("Where the work is")],
      })
    );
  });

  it("a role the graph attaches is drawn, on a new record and on a linked one", () => {
    const rolesOf = (title: string) => {
      const item = items.find(
        (i) =>
          i.source === "entities" &&
          i.shape === "record" &&
          i.record.title === title
      );
      return item?.shape === "record"
        ? item.record.fields.find((f) => f.key === "roles")?.after
        : undefined;
    };
    expect(rolesOf("Acme")).toEqual(
      expect.objectContaining({ kind: "tags", items: [expect.any(String)] })
    );
    // Bob is not created, yet approving makes him a qualified lead.
    expect(rolesOf("Bob")).toEqual(
      expect.objectContaining({ kind: "tags", items: [expect.any(String)] })
    );
  });

  it("a rule reads as its sentence and names what it knows and does", () => {
    const rule = items.find((i) => i.source === "rules");
    expect(rule?.shape === "record" && rule.record.title).toBe(
      "When a client arrives, brief it from the Builder space"
    );
    const fields =
      rule?.shape === "record"
        ? Object.fromEntries(rule.record.fields.map((f) => [f.key, f.after]))
        : {};
    expect(fields.knows).toEqual(
      expect.objectContaining({ text: "Where the work is" })
    );
    expect(fields.does).toEqual(
      expect.objectContaining({ items: ["Brief a new client"] })
    );
  });
});
