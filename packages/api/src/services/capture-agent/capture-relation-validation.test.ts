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
 * What these tests do NOT cover, and it matters:
 *  - Granularity is the file. The convergence test proves both doors call the
 *    ONE helper; the `submitProblems` assertion reads SOURCE, not behaviour,
 *    because reaching submit's throw needs a live pod.
 *  - The ROLE HINT is MOCKED here and a mock cannot prove it fires in
 *    production. It already failed to: the first implementation used a raw
 *    `db.select` on `profiles`, passed this file green, and returned zero rows
 *    for every real role against the live pod (`grp-interrogation`, `client`,
 *    2026-09-22). It now goes through `ProfileResolutionService` — the door
 *    this file already uses — and the hint is verified LIVE, not here.
 *  - The load-bearing half is the REFUSAL, which needs no profile lookup.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
const { resolveProfile } = vi.hoisted(() => ({
  resolveProfile: vi.fn(
    async (_slug: string) => null as { profileKind: string } | null
  ),
}));
vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/database")>()),
  ProfileResolutionService: class {
    resolveProfile = resolveProfile;
  },
}));

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

function makeDb(roleSlugs: string[] = []) {
  resolveProfile.mockImplementation(async (slug: string) =>
    roleSlugs.includes(slug) ? { profileKind: "role" } : null
  );
  return {
    query: { relationDefs: { findMany: async () => relationDefs } },
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
    const out = await validateCaptureRelationTypes(
      makeDb([]),
      null,
      [edge("works_at"), edge("same_subject")],
      "u1"
    );
    expect(out).toEqual([]);
  });

  it("names the unknown slug, its op index, and the valid vocabulary", async () => {
    const out = await validateCaptureRelationTypes(
      makeDb([]),
      null,
      [
        { op: "create_entity", ref: "q1", profileSlug: "question" } as never,
        edge("no_such_edge"),
      ],
      "u1"
    );
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
      [edge("grp-interrogation")],
      "u1"
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/is a ROLE, not a relation/);
    expect(out[0].message).toMatch(/facets\[\]/);
  });

  it("says the role check DID NOT RUN when the lookup throws (failed != empty)", async () => {
    resolveProfile.mockImplementation(async () => {
      throw new Error("pg down");
    });
    const out = await validateCaptureRelationTypes(
      {
        query: { relationDefs: { findMany: async () => relationDefs } },
      } as never,
      null,
      [edge("nope")],
      "u1"
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).toMatch(/nope/);
    // The distinction this repo requires: a failed read is never reported as
    // "not a role".
    expect(out[0].message).toMatch(
      /could not check whether this slug is a ROLE/
    );
  });

  it("skips the hint (but still refuses) when no userId is given", async () => {
    resolveProfile.mockImplementation(async () => ({ profileKind: "role" }));
    const out = await validateCaptureRelationTypes(
      {
        query: { relationDefs: { findMany: async () => relationDefs } },
      } as never,
      null,
      [edge("client")]
    );
    expect(out).toHaveLength(1);
    expect(out[0].message).not.toMatch(/is a ROLE/);
    expect(out[0].message).not.toMatch(/could not check/);
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
