/**
 * Unit tests for the boot-reconcile dependency-first sort.
 *
 * WHY THESE LIVE IN `packages/api` AND NOT NEXT TO THE CALLER: the caller is
 * `apps/api/src/startup/reconcile-workspaces-to-templates.ts`, and `apps/api` has
 * NO `test` script and NO vitest config. `turbo.json`'s `test` task runs each
 * package's `test` script, so a test placed there would never execute — it would
 * be decoration, not a gate. The SORT is therefore a pure exported function in
 * `packages/api` (whose vitest config has no `setupFiles`, so these run DB-free)
 * and `apps/api` keeps only the DB/iteration shell.
 *
 * Mechanics are asserted against SYNTHETIC lookups so the sort's contract is
 * pinned independently of template data drift. One test additionally reads the
 * REAL installed `@synap-core/workspace-templates` — correct here (unlike the
 * shared-role tripwire, which reads synap-app source on purpose) because the boot
 * loop imports the INSTALLED package, so installed data is the actual subject.
 */

import { describe, expect, it } from "vitest";
import {
  orderWorkspacesByTemplateDependencies,
  type TemplateForOrdering,
  type TemplateLookup,
} from "./workspace-reconcile-order.js";

/** Builds a lookup from a plain slug→deps map. Keyed by meta.slug, like the real one. */
function lookupFrom(
  graph: Record<string, string[]>
): TemplateLookup {
  const map = new Map<string, TemplateForOrdering>(
    Object.entries(graph).map(([slug, deps]) => [
      slug,
      { meta: { slug }, dependencies: deps.map((d) => ({ slug: d })) },
    ])
  );
  return (slug: string) => map.get(slug);
}

const subtypes = (rows: Array<{ subtype?: string | null; id?: string }>) =>
  rows.map((r) => r.subtype ?? null);

describe("orderWorkspacesByTemplateDependencies", () => {
  it("(1) sorts a consumer AFTER its dependency — the marketing-before-foundation bug", () => {
    // The exact live failure: Postgres returns marketing first, no pod-wide base
    // exists yet, so marketing would seed the shared base.
    const lookup = lookupFrom({
      foundation: [],
      "marketing-campaign": ["foundation"],
      ecosystem: ["foundation"],
    });

    const rows = [
      { id: "w-marketing", subtype: "marketing-campaign" },
      { id: "w-ecosystem", subtype: "ecosystem" },
      { id: "w-foundation", subtype: "foundation" },
    ];

    const ordered = orderWorkspacesByTemplateDependencies(rows, lookup);

    expect(subtypes(ordered)[0]).toBe("foundation");
    expect(ordered.map((r) => r.id)).toEqual([
      "w-foundation",
      "w-marketing",
      "w-ecosystem",
    ]);
  });

  it("(1b) orders a transitive chain deps-first regardless of input order", () => {
    const lookup = lookupFrom({ a: ["b"], b: ["c"], c: [] });
    const ordered = orderWorkspacesByTemplateDependencies(
      [{ subtype: "a" }, { subtype: "b" }, { subtype: "c" }],
      lookup
    );
    expect(subtypes(ordered)).toEqual(["c", "b", "a"]);
  });

  it("(2) a cycle still yields ALL rows exactly once and terminates", () => {
    const lookup = lookupFrom({ a: ["b"], b: ["c"], c: ["a"] });
    const rows = [
      { id: "1", subtype: "a" },
      { id: "2", subtype: "b" },
      { id: "3", subtype: "c" },
    ];

    const ordered = orderWorkspacesByTemplateDependencies(rows, lookup);

    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((r) => r.id))).toEqual(new Set(["1", "2", "3"]));
    // A self-cycle must not hang or drop either.
    const selfLoop = orderWorkspacesByTemplateDependencies(
      [{ id: "s", subtype: "x" }],
      lookupFrom({ x: ["x"] })
    );
    expect(selfLoop.map((r) => r.id)).toEqual(["s"]);
  });

  it("(3) preserves rows with no subtype and rows whose subtype has no template", () => {
    const lookup = lookupFrom({ foundation: [], ecosystem: ["foundation"] });
    const rows = [
      { id: "no-subtype", subtype: null },
      { id: "unknown", subtype: "not-a-template" },
      { id: "eco", subtype: "ecosystem" },
      { id: "undef", subtype: undefined },
      { id: "found", subtype: "foundation" },
    ];

    const ordered = orderWorkspacesByTemplateDependencies(rows, lookup);

    // Nothing dropped.
    expect(ordered).toHaveLength(5);
    expect(new Set(ordered.map((r) => r.id))).toEqual(
      new Set(["no-subtype", "unknown", "eco", "undef", "found"])
    );
    // The graph rows are still correctly ordered relative to each other...
    const graphIds = ordered
      .map((r) => r.id)
      .filter((id) => id === "found" || id === "eco");
    expect(graphIds).toEqual(["found", "eco"]);
    // ...and off-graph rows keep their original relative order at the tail.
    const offGraph = ordered
      .map((r) => r.id)
      .filter((id) => !["found", "eco"].includes(id));
    expect(offGraph).toEqual(["no-subtype", "unknown", "undef"]);
  });

  it("(3b) a dependency with no workspace on this pod is absent, not an error", () => {
    const lookup = lookupFrom({ foundation: [], ecosystem: ["foundation"] });
    // ecosystem present, foundation NOT installed on this pod.
    const ordered = orderWorkspacesByTemplateDependencies(
      [{ id: "eco", subtype: "ecosystem" }],
      lookup
    );
    expect(ordered.map((r) => r.id)).toEqual(["eco"]);
  });

  it("(3c) multiple workspaces sharing a subtype all sort together, in original order", () => {
    const lookup = lookupFrom({ foundation: [], ecosystem: ["foundation"] });
    const ordered = orderWorkspacesByTemplateDependencies(
      [
        { id: "eco-a", subtype: "ecosystem" },
        { id: "found-1", subtype: "foundation" },
        { id: "eco-b", subtype: "ecosystem" },
        { id: "found-2", subtype: "foundation" },
      ],
      lookup
    );
    expect(ordered.map((r) => r.id)).toEqual([
      "found-1",
      "found-2",
      "eco-a",
      "eco-b",
    ]);
  });

  it("(4) node identity is the RESOLVED template's meta.slug, not the raw subtype string", () => {
    // A lookup whose returned meta.slug DIFFERS from the queried key. Edges are
    // declared in meta.slug space, so identity must be read from the resolved
    // template — keying the graph on the raw subtype string would miss this edge
    // entirely and leave the rows in input order.
    const lookup: TemplateLookup = (slug) => {
      if (slug === "alias-subtype")
        return { meta: { slug: "real-consumer" }, dependencies: [{ slug: "base" }] };
      if (slug === "base") return { meta: { slug: "base" }, dependencies: [] };
      return undefined;
    };

    const ordered = orderWorkspacesByTemplateDependencies(
      [{ id: "consumer", subtype: "alias-subtype" }, { id: "base", subtype: "base" }],
      lookup
    );

    expect(ordered.map((r) => r.id)).toEqual(["base", "consumer"]);
  });

  it("(4b) REAL installed templates: the live foundation consumers sort deps-first", async () => {
    const { getWorkspaceTemplate, WORKSPACE_TEMPLATES } = await import(
      "@synap-core/workspace-templates"
    );

    // Pin the real graph this sort must handle, so a template change that alters
    // it surfaces here rather than on a live pod boot.
    expect(getWorkspaceTemplate("foundation")?.dependencies ?? []).toEqual([]);
    expect(
      (getWorkspaceTemplate("ecosystem")?.dependencies ?? []).map((d) => d.slug)
    ).toContain("foundation");

    const rows = [
      { id: "w-marketing", subtype: "marketing-campaign" },
      { id: "w-ecosystem", subtype: "ecosystem" },
      { id: "w-foundation", subtype: "foundation" },
    ];
    const ordered = orderWorkspacesByTemplateDependencies(
      rows,
      getWorkspaceTemplate
    );
    expect(ordered[0]?.id).toBe("w-foundation");

    // DOCUMENTS REAL BEHAVIOUR (not a wish): `grants` declares
    // `workspace.subtype: operations`, and WORKSPACE_TEMPLATES is keyed by
    // meta.slug with `getWorkspaceTemplate` a plain key lookup. So a workspace
    // stamped subtype `operations` resolves to the OPERATIONS template — never to
    // `grants`. The sort faithfully orders what the lookup returns; it does not
    // and must not second-guess which template a row belongs to.
    expect(WORKSPACE_TEMPLATES["grants"]?.workspace?.subtype).toBe("operations");
    expect(getWorkspaceTemplate("operations")?.meta.slug).toBe("operations");

    // operations declares no deps → an operations row is unconstrained, and a
    // grants-subtype row simply never enters the graph as `grants`.
    const opsOrdered = orderWorkspacesByTemplateDependencies(
      [{ id: "w-ops", subtype: "operations" }, { id: "w-found", subtype: "foundation" }],
      getWorkspaceTemplate
    );
    expect(opsOrdered).toHaveLength(2);
  });

  it("(5) is deterministic — same input yields the same output", () => {
    const lookup = lookupFrom({
      foundation: [],
      ecosystem: ["foundation"],
      "marketing-campaign": ["foundation"],
      operations: [],
      cyclic: ["cyclic"],
    });
    const rows = [
      { id: "a", subtype: "marketing-campaign" },
      { id: "b", subtype: null },
      { id: "c", subtype: "ecosystem" },
      { id: "d", subtype: "foundation" },
      { id: "e", subtype: "operations" },
      { id: "f", subtype: "cyclic" },
      { id: "g", subtype: "ecosystem" },
    ];

    const first = orderWorkspacesByTemplateDependencies(rows, lookup).map(
      (r) => r.id
    );
    for (let i = 0; i < 20; i++) {
      expect(
        orderWorkspacesByTemplateDependencies(rows, lookup).map((r) => r.id)
      ).toEqual(first);
    }
    // Same multiset, no duplicates, nothing lost.
    expect(new Set(first).size).toBe(rows.length);
  });
});
