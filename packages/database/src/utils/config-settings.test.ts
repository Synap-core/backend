import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveGuidelines, SCOPE_SPECIFICITY } from "./config-settings.js";
import { CONFIG_SCOPE_KINDS } from "../schema/config-settings.js";

/**
 * Minimal fake db mirroring resolve-agent-governance-decision.test.ts:
 * `resolveGuidelines` issues exactly ONE query (`select().from().where()`,
 * awaited directly, no `.limit()`). The fake makes the `.where()` result
 * awaitable (via `.then`) and OPTIONALLY records the WHERE condition so a test
 * can render it to SQL — the honest way to verify the SQL-level floors
 * (owner-floor, revoked-exclusion) without a live PG (none in this env).
 *
 * Like the governance test, fixtures are written as if the real WHERE had
 * ALREADY filtered rows — the in-memory scope-match + specificity ordering is
 * what this exercises directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeDb(rows: any[]): { db: any; getWhere: () => any } {
  let captured: unknown;
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          captured = cond;
          return { then: (resolve: (r: unknown[]) => void) => resolve(rows) };
        },
      }),
    }),
  };
  return { db, getWhere: () => captured };
}

function row(overrides: {
  id: string;
  scopeKind: (typeof CONFIG_SCOPE_KINDS)[number];
  scopeRef?: string | null;
  text: string;
  posture?: "auto" | "propose";
  shape?: { op: string; value?: string } | null;
  createdAt?: Date;
}) {
  return {
    id: overrides.id,
    scopeKind: overrides.scopeKind,
    scopeRef: overrides.scopeRef ?? null,
    value: {
      text: overrides.text,
      ...(overrides.posture ? { posture: overrides.posture } : {}),
    },
    shape: overrides.shape ?? null,
    createdAt: overrides.createdAt ?? new Date("2026-01-01T00:00:00Z"),
  };
}

describe("resolveGuidelines — scope match + additive-specificity ordering", () => {
  it("resolves a channel guideline + a shape guideline and composes them most-general → most-specific", async () => {
    const { db } = makeDb([
      row({
        id: "g-default",
        scopeKind: "default",
        text: "Default rule",
        createdAt: new Date("2026-01-01T00:00:00Z"),
      }),
      row({
        id: "g-shape",
        scopeKind: "shape",
        text: "Shape rule",
        posture: "propose",
        shape: { op: "contains", value: "ready for review" },
        createdAt: new Date("2026-01-03T00:00:00Z"),
      }),
      row({
        id: "g-channel",
        scopeKind: "channel",
        scopeRef: "chan-1",
        text: "Channel rule",
        createdAt: new Date("2026-01-02T00:00:00Z"),
      }),
      // Non-matching: a different channel + a shape whose predicate fails.
      row({
        id: "g-other-channel",
        scopeKind: "channel",
        scopeRef: "chan-999",
        text: "Other channel",
      }),
      row({
        id: "g-other-shape",
        scopeKind: "shape",
        text: "Other shape",
        shape: { op: "contains", value: "never appears" },
      }),
    ]);

    const resolved = await resolveGuidelines({
      db,
      userId: "u1",
      channelId: "chan-1",
      workspaceId: "ws-1",
      envelope: { content: "this is ready for review now", attachments: [] },
    });

    // General → specific, by SCOPE_ORDER's ranks. The two non-matching rows
    // are dropped.
    expect(resolved.map((g) => g.id)).toEqual([
      "g-default",
      "g-channel",
      "g-shape",
    ]);
    expect(resolved.map((g) => g.text)).toEqual([
      "Default rule",
      "Channel rule",
      "Shape rule",
    ]);
    // The most-specific (shape) is last so it reinforces/overrides, and its
    // stored posture rides through.
    expect(resolved[resolved.length - 1].posture).toBe("propose");
  });

  it("skips guidelines whose text is empty/blank", async () => {
    const { db } = makeDb([
      row({ id: "g-blank", scopeKind: "default", text: "   " }),
      row({ id: "g-real", scopeKind: "default", text: "Keep me" }),
    ]);
    const resolved = await resolveGuidelines({ db, userId: "u1" });
    expect(resolved.map((g) => g.id)).toEqual(["g-real"]);
  });

  it("SQL floor carries the owner-floor (created_by) for pod-wide rows AND excludes revoked rows", async () => {
    const { db, getWhere } = makeDb([]);
    await resolveGuidelines({ db, userId: "u1", workspaceId: "ws-1" });

    const rendered = new PgDialect().sqlToQuery(getWhere()).sql.toLowerCase();
    // (d) revoked rows excluded, and the store is keyed to 'guideline'.
    expect(rendered).toContain("revoked_at");
    expect(rendered).toContain("is null");
    expect(rendered).toContain('"key"');
    // (c) pod-wide (NULL-workspace) rows are owner-floored by created_by.
    expect(rendered).toContain("created_by");
    // workspace lens branch present.
    expect(rendered).toContain("workspace_id");
  });
});

/**
 * The `workKind` rung.
 *
 * THE INVARIANT THAT MATTERS MOST is the last describe block: `resolveGuidelines`
 * sits inside the governance decision (`resolveOriginTrust`, rung 2.55, reads
 * the most-specific applicable `posture`). A rung that could match without the
 * caller asking for it would silently move an origin between trusted and
 * untrusted. These tests pin that it cannot.
 */
describe("resolveGuidelines — the workKind rung", () => {
  it("matches a workKind row ONLY when the caller passes that work kind, and ranks it above default but below every transport rung", async () => {
    const rows = [
      row({ id: "g-default", scopeKind: "default", text: "Always" }),
      row({
        id: "g-workkind",
        scopeKind: "workKind",
        scopeRef: "credential",
        text: "When blocked on a credential",
      }),
      row({
        id: "g-other-workkind",
        scopeKind: "workKind",
        scopeRef: "capability",
        text: "When blocked on a capability",
      }),
      row({
        id: "g-channel",
        scopeKind: "channel",
        scopeRef: "chan-1",
        text: "On this channel",
      }),
    ];

    const resolved = await resolveGuidelines({
      db: makeDb(rows).db,
      userId: "u1",
      workspaceId: "ws-1",
      channelId: "chan-1",
      workKind: "credential",
    });

    // The non-matching work kind is dropped; the matching one is ordered
    // BETWEEN default and the channel rung — the placement SCOPE_ORDER records.
    expect(resolved.map((g) => g.id)).toEqual([
      "g-default",
      "g-workkind",
      "g-channel",
    ]);
    expect(SCOPE_SPECIFICITY.default).toBeLessThan(SCOPE_SPECIFICITY.workKind);
    expect(SCOPE_SPECIFICITY.workKind).toBeLessThan(
      SCOPE_SPECIFICITY.channelType
    );
    expect(SCOPE_SPECIFICITY.workKind).toBeLessThan(SCOPE_SPECIFICITY.channel);
  });

  it("every scope kind in the enum has a rank (no member resolves to undefined)", () => {
    // NON-VACUITY: the enum must actually contain the rungs, so a truncated
    // CONFIG_SCOPE_KINDS cannot make the loop below pass by iterating nothing.
    expect(CONFIG_SCOPE_KINDS.length).toBeGreaterThanOrEqual(6);
    expect(CONFIG_SCOPE_KINDS).toContain("workKind");
    for (const kind of CONFIG_SCOPE_KINDS) {
      expect(typeof SCOPE_SPECIFICITY[kind]).toBe("number");
      expect(Number.isNaN(SCOPE_SPECIFICITY[kind])).toBe(false);
    }
    // Ranks are distinct — a duplicated rank would make the ladder ambiguous.
    const ranks = CONFIG_SCOPE_KINDS.map((k) => SCOPE_SPECIFICITY[k]);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("GOVERNANCE IS UNCHANGED for a caller that passes no workKind", () => {
  /**
   * `resolveOriginTrust` (resolve-agent-governance-decision.ts:641-651) calls
   * `resolveGuidelines` with db/userId/channelId/channelType/workspaceId/
   * capabilityId and NOTHING ELSE — no `workKind`. These two tests reproduce
   * exactly that call shape and assert a stored `workKind` row is invisible to
   * it, so no `posture` it carries can ever reach the origin-trust gate.
   */
  const governanceCallShape = {
    userId: "u1",
    channelId: "chan-1",
    channelType: "external",
    workspaceId: "ws-1",
    capabilityId: null,
  };

  it("a workKind guideline carrying posture:'auto' does NOT reach a governance-shaped call", async () => {
    const withWorkKind = [
      row({ id: "g-default", scopeKind: "default", text: "Always" }),
      row({
        id: "g-workkind-auto",
        scopeKind: "workKind",
        scopeRef: "credential",
        text: "Would flip trust if it matched",
        posture: "auto",
      }),
    ];

    const resolved = await resolveGuidelines({
      db: makeDb(withWorkKind).db,
      ...governanceCallShape,
    });

    expect(resolved.map((g) => g.id)).toEqual(["g-default"]);
    // The posture the governance gate would read: undefined, not "auto".
    expect(resolved.some((g) => g.posture)).toBe(false);
  });

  it("the resolved list for a governance-shaped call is byte-identical with and without workKind rows present", async () => {
    const transportOnly = [
      row({ id: "g-default", scopeKind: "default", text: "Always" }),
      row({
        id: "g-chan",
        scopeKind: "channel",
        scopeRef: "chan-1",
        text: "Channel rule",
        posture: "propose",
      }),
    ];
    const withWorkKindAdded = [
      ...transportOnly,
      row({
        id: "g-wk",
        scopeKind: "workKind",
        scopeRef: "credential",
        text: "Work-kind rule",
        posture: "auto",
      }),
    ];

    const before = await resolveGuidelines({
      db: makeDb(transportOnly).db,
      ...governanceCallShape,
    });
    const after = await resolveGuidelines({
      db: makeDb(withWorkKindAdded).db,
      ...governanceCallShape,
    });

    // NON-VACUITY: the comparison must be over a non-empty, posture-carrying
    // result — an assertion that [] equals [] would prove nothing.
    expect(before.length).toBe(2);
    expect(before[before.length - 1].posture).toBe("propose");
    expect(after).toEqual(before);
  });
});
