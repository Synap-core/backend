/**
 * An edge naming a non-existent relation def must be REFUSED AT FILING, not
 * filed as a pending proposal that fails at approve.
 *
 * The defect this pins: `submitCaptureGraph` preflighted every `create_entity`
 * op ("never queue what can't materialize") but never validated
 * `create_relation` slugs, while BOTH the dry run and the revise door did. An
 * agent filed 9 edges typed with a ROLE slug (`grp-interrogation`); the
 * proposal was unapprovable and sat in the queue with nothing recorded.
 *
 * What these tests do NOT cover: granularity is the file. The convergence test
 * proves both doors call the ONE helper; it cannot prove the helper's result is
 * wired into submit's rejection — that is what the `submitProblems` assertion
 * below reads, and it reads SOURCE, not behaviour, because reaching submit's
 * throw needs a live pod.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { validateCaptureRelationTypes } from "./submit-capture-graph.js";
import type { CompositeProposalOperation } from "@synap-core/types/proposals";

const relationDefs = [
  {
    slug: "works_at",
    displayName: "Works at",
    description: null,
    workspaceId: null,
    uiHints: {},
    isDirectional: true,
  },
];

/** `profileKind = 'role'` rows the hint lookup finds. */
function makeDb(roleSlugs: string[]) {
  return {
    query: { relationDefs: { findMany: async () => relationDefs } },
    select: () => ({
      from: () => ({
        where: async () => roleSlugs.map((slug) => ({ slug })),
      }),
    }),
  } as never;
}

const edge = (type: string): CompositeProposalOperation =>
  ({
    op: "create_relation",
    sourceRef: "q1",
    targetRef: "q2",
    type,
  }) as CompositeProposalOperation;

describe("validateCaptureRelationTypes", () => {
  it("passes a known slug and a builtin", async () => {
    const out = await validateCaptureRelationTypes(makeDb([]), null, [
      edge("works_at"),
      edge("same_subject"),
    ]);
    expect(out).toEqual([]);
  });

  it("names the unknown slug, its op index, and the valid vocabulary", async () => {
    const out = await validateCaptureRelationTypes(makeDb([]), null, [
      { op: "create_entity", ref: "q1", profileSlug: "question" } as never,
      edge("no_such_edge"),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].opIndex).toBe(1);
    expect(out[0].op).toBe("create_relation");
    expect(out[0].message).toMatch(/q1 -> q2/);
    expect(out[0].message).toMatch(/no_such_edge/);
    expect(out[0].message).toMatch(/works_at/);
  });

  it("points a ROLE slug at facets[] — the mistake that actually happened", async () => {
    const out = await validateCaptureRelationTypes(
      makeDb(["grp-interrogation"]),
      null,
      [edge("grp-interrogation")]
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/is a ROLE, not a relation/);
    expect(out[0].message).toMatch(/facets\[\]/);
  });

  it("still reports the problem when the role-hint lookup throws", async () => {
    const db = {
      query: { relationDefs: { findMany: async () => relationDefs } },
      select: () => ({
        from: () => ({
          where: async () => {
            throw new Error("pg down");
          },
        }),
      }),
    } as never;
    const out = await validateCaptureRelationTypes(db, null, [edge("nope")]);
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/nope/);
  });
});

describe("one validator, reached by BOTH doors", () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "submit-capture-graph.ts"),
    "utf8"
  );

  it("has exactly one loadRelationTypeValidator call site in the file", () => {
    // Import line excluded: the count is of call sites, `(` included.
    expect(src.match(/loadRelationTypeValidator\(/g) ?? []).toHaveLength(1);
    const helper = src.slice(
      src.indexOf("export async function validateCaptureRelationTypes(")
    );
    expect(helper.slice(0, 2000)).toContain("await loadRelationTypeValidator(");
  });

  it("submit folds the relation problems into its OWN rejection", () => {
    const submitBody = src.slice(
      src.indexOf("export async function submitCaptureGraph(")
    );
    expect(submitBody.length).toBeGreaterThan(1000);
    expect(submitBody).toContain("await validateCaptureRelationTypes(");
    // The thrown error must carry them, not merely compute them.
    const throwLine = submitBody.match(
      /throw new CaptureGraphValidationError\([^)]*\)/
    );
    expect(throwLine?.[0]).toContain("submitProblems");
  });

  it("the validate door reaches the same helper", () => {
    const reviseBody = src.slice(
      src.indexOf("export async function validateCompositeOperations("),
      src.indexOf("export async function dryRunCaptureGraph(")
    );
    expect(reviseBody).toContain("await validateCaptureRelationTypes(");
  });
});
