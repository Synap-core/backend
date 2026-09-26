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
});
