/**
 * planPlaybookReconcile — how an installed package playbook converges to its
 * template. Pure (no DB): the rows here are shaped as `db.select()` returns a
 * `playbooks` row (column defaults for anything never written).
 *
 * The discriminating rows (guards-and-tests: a fixture row must rule a wrong
 * rule OUT):
 *  - the grants repair — an UNSTAMPED row installed by the old stripping doors
 *    (stages [] / scope null) must ADOPT the template's 6 steps + project scope,
 *    while an owner-edited goal stays untouched (rules out "adopt = overwrite");
 *  - a STAMPED row whose owner edited stages must keep them when the template
 *    changes (rules out "reconcile = overwrite");
 *  - a STAMPED row whose baseline predates `scope` gets `scope` via the
 *    newly-managed branch (rules out "only baseline keys are managed").
 */

import { describe, it, expect } from "vitest";
import {
  planPlaybookReconcile,
  projectPlaybookDefinition,
  PLAYBOOK_MANAGED_FIELDS,
} from "./playbook-market-source.js";
import { packagePlaybookDefinitionSchema } from "../../schemas/playbook-definition.js";

const STAGES = [
  { key: "identify", name: "Identify", category: "planned" },
  { key: "draft", name: "Draft", category: "started" },
];
const TEMPLATE = {
  name: "Grant Process",
  goalTemplate: "Advance the engagement.",
  scope: "project",
  stages: STAGES,
};

/** A `playbooks` row as the DB holds it (defaults for unwritten columns). */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "pb-1",
    name: "Grant Process",
    description: null,
    goalTemplate: "Advance the engagement.",
    params: [],
    inputStrategy: { kind: "none" },
    channelSpec: {},
    expectedOutputs: [],
    stages: [],
    criteria: [],
    subjectProfile: null,
    schedule: null,
    executor: "is-agent",
    status: "active",
    scope: null,
    metadata: {},
    ...over,
  };
}
const plan = (r: Record<string, unknown>, tpl: unknown = TEMPLATE) =>
  planPlaybookReconcile({
    row: r,
    templateElement: tpl,
    packageSlug: "grants",
    packageVersion: "h-2",
    installedAt: "2026-09-25T00:00:00.000Z",
  });
const baselineOf = (tpl: unknown) =>
  projectPlaybookDefinition(packagePlaybookDefinitionSchema.parse(tpl));

describe("planPlaybookReconcile", () => {
  it("ADOPTS an unstamped stageless row: fills scope + stages, stamps the link", () => {
    const p = plan(row());
    expect(p.kind).toBe("adopted");
    expect(p.patch).toEqual({ scope: "project", stages: STAGES });
    expect(p.ownerOwned).toEqual([]);
    const ms = p.metadata!.marketSource as {
      packageSlug: string;
      baseline: Record<string, unknown>;
    };
    expect(ms.packageSlug).toBe("grants");
    expect(ms.baseline.stages).toEqual(STAGES);
  });

  it("ADOPT never overwrites an owner-authored value (reported instead)", () => {
    const p = plan(row({ goalTemplate: "My own goal." }));
    expect(p.patch.goalTemplate).toBeUndefined();
    expect(p.ownerOwned).toEqual(["goalTemplate"]);
    expect(p.patch.stages).toEqual(STAGES);
  });

  it("a stamped, untouched row advances to a changed template", () => {
    const stamped = row({
      scope: "project",
      stages: STAGES,
      metadata: {
        governance: { forceProposeWrites: true },
        marketSource: {
          packageSlug: "grants",
          packageVersion: "h-1",
          installedAt: "x",
          baseline: baselineOf(TEMPLATE),
        },
      },
    });
    const next = {
      ...TEMPLATE,
      stages: [
        ...STAGES,
        { key: "submit", name: "Submit", category: "started" },
      ],
    };
    const p = plan(stamped, next);
    expect(p.kind).toBe("updated");
    expect(p.applied).toEqual(["stages"]);
    expect(p.patch.stages).toHaveLength(3);
    // Other metadata keys survive; the baseline advances.
    expect(
      (p.metadata!.governance as { forceProposeWrites: boolean })
        .forceProposeWrites
    ).toBe(true);
    const ms = p.metadata!.marketSource as {
      packageVersion: string;
      baseline: { stages: unknown[] };
    };
    expect(ms.baseline.stages).toHaveLength(3);
    expect(ms.packageVersion).toBe("h-2");
  });

  it("owner-edited stages are NEVER overwritten by a template change", () => {
    const edited = [{ key: "mine", name: "Mine", category: "started" }];
    const p = plan(
      row({
        scope: "project",
        stages: edited,
        metadata: {
          marketSource: {
            packageSlug: "grants",
            packageVersion: "h-1",
            installedAt: "x",
            baseline: baselineOf(TEMPLATE),
          },
        },
      }),
      { ...TEMPLATE, goalTemplate: "Changed goal." }
    );
    expect(p.patch.stages).toBeUndefined();
    expect(p.ownerOwned).toContain("stages");
    expect(p.patch.goalTemplate).toBe("Changed goal.");
  });

  // A stage's `lessons` are the pod's (the lessons scanner writes them on the
  // live row), never an owner edit: one learned lesson must not freeze every
  // template change to the stages ("Draft a first message", 6 Nov 2026).
  const LESSONS = ["Name the decider in the next action."];
  const stampedAt = (baseline: unknown) => ({
    marketSource: {
      packageSlug: "grants",
      packageVersion: "h-1",
      installedAt: "x",
      baseline,
    },
  });
  const withLessons = (stages: typeof STAGES) =>
    stages.map((s) => (s.key === "draft" ? { ...s, lessons: LESSONS } : s));

  it("a stage that learned lessons still advances to a changed template, and keeps its lessons", () => {
    const next = {
      ...TEMPLATE,
      stages: STAGES.map((s) =>
        s.key === "draft" ? { ...s, goal: "Draft through the send door." } : s
      ),
    };
    const p = plan(
      row({
        scope: "project",
        stages: withLessons(STAGES),
        metadata: stampedAt(baselineOf(TEMPLATE)),
      }),
      next
    );
    expect(p.ownerOwned).not.toContain("stages");
    expect(p.applied).toEqual(["stages"]);
    expect(p.patch.stages).toEqual([
      STAGES[0],
      { ...STAGES[1], goal: "Draft through the send door.", lessons: LESSONS },
    ]);
    // The baseline records the template, never the pod's lessons.
    const ms = p.metadata!.marketSource as { baseline: { stages: unknown[] } };
    expect(ms.baseline.stages).toEqual(next.stages);
  });

  it("a stage with lessons whose text the owner edited stays owner-owned", () => {
    const edited = withLessons(STAGES).map((s) =>
      s.key === "draft" ? { ...s, name: "My draft" } : s
    );
    const p = plan(
      row({
        scope: "project",
        stages: edited,
        metadata: stampedAt(baselineOf(TEMPLATE)),
      }),
      {
        ...TEMPLATE,
        stages: [
          ...STAGES,
          { key: "send", name: "Send", category: "completed" },
        ],
      }
    );
    expect(p.ownerOwned).toContain("stages");
    expect(p.patch.stages).toBeUndefined();
  });

  it("a converged row with lessons is up to date: no write", () => {
    const p = plan(
      row({
        scope: "project",
        stages: withLessons(STAGES),
        metadata: {
          marketSource: {
            packageSlug: "grants",
            packageVersion: "h-2",
            installedAt: "x",
            baseline: baselineOf(TEMPLATE),
          },
        },
      })
    );
    expect(p.kind).toBe("up-to-date");
    expect(p.patch).toEqual({});
    expect(p.ownerOwned).toEqual([]);
  });

  it("ADOPT reads lessons as the pod's: stages equal to the template but for lessons are not owner-owned", () => {
    const p = plan(row({ scope: "project", stages: withLessons(STAGES) }));
    expect(p.kind).toBe("adopted");
    expect(p.ownerOwned).toEqual([]);
    expect(p.patch.stages).toBeUndefined();
  });

  it("a baseline that predates `scope` still gets it (newly-managed field)", () => {
    const oldBaseline = baselineOf({ ...TEMPLATE, scope: undefined });
    delete (oldBaseline as Record<string, unknown>).scope;
    const p = plan(
      row({
        stages: STAGES,
        metadata: {
          marketSource: {
            packageSlug: "grants",
            packageVersion: "h-1",
            installedAt: "x",
            baseline: oldBaseline,
          },
        },
      })
    );
    expect(p.patch).toEqual({ scope: "project" });
  });

  it("a row linked to ANOTHER package is left alone", () => {
    const p = plan(
      row({
        metadata: {
          marketSource: {
            packageSlug: "other",
            packageVersion: null,
            installedAt: "x",
            baseline: {},
          },
        },
      })
    );
    expect(p.kind).toBe("foreign");
    expect(p.patch).toEqual({});
    expect(p.metadata).toBeNull();
  });

  it("up to date ⇒ no write at all", () => {
    const p = plan(
      row({
        scope: "project",
        stages: STAGES,
        metadata: {
          marketSource: {
            packageSlug: "grants",
            packageVersion: "h-2",
            installedAt: "x",
            baseline: baselineOf(TEMPLATE),
          },
        },
      })
    );
    expect(p.kind).toBe("up-to-date");
    expect(p.patch).toEqual({});
    expect(p.metadata).toBeNull();
  });

  it("the managed set never includes the owner's lifecycle or the match key", () => {
    expect(PLAYBOOK_MANAGED_FIELDS).not.toContain("status");
    expect(PLAYBOOK_MANAGED_FIELDS).not.toContain("name");
    expect(PLAYBOOK_MANAGED_FIELDS).not.toContain("metadata");
  });

  const PIN = "11111111-1111-4111-8111-111111111111";
  const PINNED = {
    kind: "pinned",
    fallback: {
      filter: { "post-status": "Idea" },
      orderBy: "createdAt",
      orderDir: "asc",
    },
  };

  it("adopts a pinned strategy onto a default row and keeps the owner's pin ids", () => {
    const p = plan(
      row({
        scope: "project",
        stages: STAGES,
        metadata: {
          pinnedEntityIds: [PIN],
          marketSource: {
            packageSlug: "grants",
            packageVersion: "h-1",
            installedAt: "x",
            baseline: baselineOf(TEMPLATE),
          },
        },
      }),
      { ...TEMPLATE, inputStrategy: PINNED }
    );
    expect(p.applied).toContain("inputStrategy");
    expect(p.patch.inputStrategy).toMatchObject({ kind: "pinned" });
    expect(p.metadata).toMatchObject({ pinnedEntityIds: [PIN] });
  });

  it("an unstamped row that already chose a strategy keeps it", () => {
    const p = plan(row({ inputStrategy: { kind: "static", items: [1] } }), {
      ...TEMPLATE,
      inputStrategy: PINNED,
    });
    expect(p.ownerOwned).toContain("inputStrategy");
    expect(p.patch.inputStrategy).toBeUndefined();
  });
});

/**
 * WHO RUNS IT is the pod's (founder via the lead, 9 Nov 2026): a template
 * installs its runners once; a later template change to a playbook's or a
 * step's `runner` is HELD (a keep-or-drop line), never written over the pod's
 * choice. `requires` and `uses` stay the template's (what the step IS).
 * Discriminating rows: a pod-set runner + a template that changes the runner
 * AND other stage fields (rules out "runner held by freezing all of stages");
 * an untouched pod (live = old template) still held (rules out "only an edited
 * runner is protected"); a step the template ADDS takes its runner (rules out
 * "every stage runner is the pod's, even a new one").
 */
describe("planPlaybookReconcile — runners are the pod's", () => {
  const V1 = {
    name: "Edit a video",
    goalTemplate: "Edit the take.",
    runner: { engine: "claude-code" },
    requires: ["media-ffmpeg"],
    stages: [
      {
        key: "render",
        name: "Render",
        category: "started",
        runner: { role: "video-render" },
        requires: ["media-ffmpeg"],
      },
    ],
  };
  const V2 = {
    ...V1,
    runner: { engine: "hermes" },
    requires: ["media-ffmpeg", "media-transcribe"],
    stages: [
      {
        key: "render",
        name: "Render the cut",
        category: "started",
        runner: { role: "colorist" },
        requires: ["media-ffmpeg", "media-color"],
      },
      {
        key: "sound",
        name: "Sound",
        category: "started",
        runner: { role: "sound-mix" },
      },
    ],
  };
  const stampedAt = (
    tpl: unknown,
    over: Record<string, unknown>
  ): Record<string, unknown> => {
    const base = baselineOf(tpl) as Record<string, unknown>;
    return row({
      ...base,
      metadata: {
        marketSource: {
          packageSlug: "grants",
          packageVersion: "h-1",
          installedAt: "x",
          baseline: base,
        },
      },
      ...over,
    });
  };
  const POD_MAC = { role: "video-render", computer: "mac" };

  it("a runner the pod set survives a catalog update; the change is a held line", () => {
    const p = plan(
      stampedAt(V1, {
        runner: { agentId: "agent-mac" },
        stages: [{ ...V1.stages[0], runner: POD_MAC }],
      }),
      V2
    );
    expect(p.patch).not.toHaveProperty("runner");
    expect(p.held.sort()).toEqual(["runner", "stages.render.runner"]);
    // The template's other changes still reach the pod…
    expect(p.patch.requires).toEqual(["media-ffmpeg", "media-transcribe"]);
    const stages = p.patch.stages as Array<Record<string, unknown>>;
    expect(stages.map((s) => s.key)).toEqual(["render", "sound"]);
    expect(stages[0]).toMatchObject({
      name: "Render the cut",
      requires: ["media-ffmpeg", "media-color"],
      // …and the pod's runner stays on its step.
      runner: POD_MAC,
    });
    // A step the template added takes the template's runner.
    expect(stages[1]!.runner).toEqual({ role: "sound-mix" });
    // The baseline keeps the template's OLD runners, so the line stays offered.
    const ms = p.metadata!.marketSource as {
      baseline: Record<string, unknown>;
    };
    expect(ms.baseline.runner).toEqual({ engine: "claude-code" });
    expect(
      (ms.baseline.stages as Array<Record<string, unknown>>)[0]!.runner
    ).toEqual({ role: "video-render" });
  });

  it("a pod that kept the template's runner is not overwritten either: held, not applied", () => {
    const p = plan(stampedAt(V1, {}), V2);
    expect(p.patch).not.toHaveProperty("runner");
    expect(p.held.sort()).toEqual(["runner", "stages.render.runner"]);
    const stages = p.patch.stages as Array<Record<string, unknown>>;
    expect(stages[0]!.runner).toEqual({ role: "video-render" });
  });

  it("the next pass offers the same lines again until a person applies them", () => {
    const first = plan(stampedAt(V1, {}), V2);
    const after = row({
      ...(stampedAt(V1, {}) as Record<string, unknown>),
      ...first.patch,
      metadata: first.metadata,
    });
    const again = plan(after, V2);
    expect(again.held.sort()).toEqual(["runner", "stages.render.runner"]);
    expect(again.patch).toEqual({});
  });

  it("a runner the template did not change is no line", () => {
    const p = plan(stampedAt(V1, { runner: { agentId: "agent-mac" } }), {
      ...V1,
      goalTemplate: "Edit the take, then export.",
    });
    expect(p.held).toEqual([]);
    expect(p.patch).toEqual({ goalTemplate: "Edit the take, then export." });
  });

  it("adoption fills an empty runner from the template, and holds one the pod set", () => {
    expect(plan(row({ stages: V1.stages }), V1).patch.runner).toEqual({
      engine: "claude-code",
    });
    const held = plan(row({ runner: "synap_ai", stages: V1.stages }), V1);
    expect(held.patch).not.toHaveProperty("runner");
    expect(held.held).toEqual(["runner"]);
  });
});

describe("planPlaybookReconcile — a row stamped before 0419 (the one tools field)", () => {
  // The baseline as a pre-0419 install stamped it: `requiredIntents`, a
  // stage's `grants`, and no `tools` (the field did not exist).
  const OLD_STAGES = [
    {
      key: "research",
      name: "Research",
      category: "started",
      grants: [{ kind: "skill", id: "source-triage" }],
    },
  ];
  const oldBaseline = {
    ...baselineOf({ ...TEMPLATE, scope: undefined, stages: [] }),
    stages: OLD_STAGES,
    requiredIntents: ["search_external"],
  };
  delete (oldBaseline as Record<string, unknown>).tools;
  // What 0419 wrote on the live row: the folded list plus a short run's writes,
  // and the stage's grants turned into its tools.
  const MIGRATED_STAGES = [
    {
      key: "research",
      name: "Research",
      category: "started",
      tools: ["source-triage", "update_document"],
    },
  ];
  const migratedRow = (over: Record<string, unknown> = {}) =>
    row({
      stages: MIGRATED_STAGES,
      tools: [
        "search_external",
        "source-triage",
        "update_document",
        "create_entity",
      ],
      metadata: {
        marketSource: {
          packageSlug: "grants",
          packageVersion: "h-1",
          installedAt: "x",
          baseline: oldBaseline,
        },
      },
      ...over,
    });
  const LEAN = {
    ...TEMPLATE,
    scope: undefined,
    tools: ["update_document", "search_external", "source-triage"],
    stages: [
      {
        key: "research",
        name: "Research",
        category: "started",
        tools: ["source-triage"],
      },
    ],
  };

  it("the template's lean tools and stage tools replace what 0419 wrote", () => {
    const p = plan(migratedRow(), LEAN);
    expect(p.kind).toBe("updated");
    expect(p.patch.tools).toEqual([
      "update_document",
      "search_external",
      "source-triage",
    ]);
    expect(p.patch.stages).toEqual(LEAN.stages);
    expect(p.ownerOwned).toEqual([]);
    const ms = p.metadata!.marketSource as {
      baseline: Record<string, unknown>;
    };
    // From here on the baseline has `tools`: a later owner edit is an edit.
    expect(ms.baseline.tools).toEqual(LEAN.tools);
  });

  it("an owner's real edit (the goal, a stage renamed) is kept", () => {
    const p = plan(
      migratedRow({
        goalTemplate: "My own goal.",
        stages: [{ ...MIGRATED_STAGES[0]!, name: "My research" }],
      }),
      LEAN
    );
    expect(p.patch.goalTemplate).toBeUndefined();
    expect(p.patch.stages).toBeUndefined();
    expect(p.ownerOwned).toContain("stages");
    expect(p.patch.tools).toEqual(LEAN.tools);
  });

  it("a baseline that has tools (stamped since 0419) still protects an owner's tools edit", () => {
    const p = plan(
      migratedRow({
        tools: ["web_search"],
        metadata: {
          marketSource: {
            packageSlug: "grants",
            packageVersion: "h-1",
            installedAt: "x",
            baseline: baselineOf({
              ...TEMPLATE,
              scope: undefined,
              stages: MIGRATED_STAGES,
            }),
          },
        },
      }),
      LEAN
    );
    expect(p.patch.tools).toBeUndefined();
    expect(p.ownerOwned).toContain("tools");
  });
});
