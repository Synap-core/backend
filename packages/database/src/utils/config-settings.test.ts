import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  resolveGuidelines,
  supersedeGuideline,
  SCOPE_SPECIFICITY,
} from "./config-settings.js";
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

/**
 * The DATA-TYPE rungs (0258). Same inert-unless-asked contract as workKind:
 * a caller that passes no sourceKind / entityKinds resolves exactly as before.
 */
describe("resolveGuidelines — the data-type rungs (sourceKind, entityKind)", () => {
  const rows = () => [
    row({ id: "g-default", scopeKind: "default", text: "Always" }),
    row({
      id: "g-src-image",
      scopeKind: "sourceKind",
      scopeRef: "image",
      text: "Screenshots: read prices literally",
    }),
    row({
      id: "g-src-url",
      scopeKind: "sourceKind",
      scopeRef: "url",
      text: "Links: bookmark only",
    }),
    row({
      id: "g-kind-person",
      scopeKind: "entityKind",
      scopeRef: "person",
      text: "Always capture the LinkedIn URL",
    }),
    row({
      id: "g-kind-deal",
      scopeKind: "entityKind",
      scopeRef: "deal",
      text: "Deals need a stage",
    }),
    row({
      id: "g-channel",
      scopeKind: "channel",
      scopeRef: "chan-1",
      text: "On this channel",
    }),
  ];

  it("matches a sourceKind row only for that source and an entityKind row only when the kind is in play; ranks default < sourceKind < entityKind < transport", async () => {
    const resolved = await resolveGuidelines({
      db: makeDb(rows()).db,
      userId: "u1",
      workspaceId: "ws-1",
      channelId: "chan-1",
      sourceKind: "image",
      entityKinds: ["person", "company"],
    });
    expect(resolved.map((g) => g.id)).toEqual([
      "g-default",
      "g-src-image",
      "g-kind-person",
      "g-channel",
    ]);
    expect(SCOPE_SPECIFICITY.workKind).toBeLessThan(
      SCOPE_SPECIFICITY.sourceKind
    );
    expect(SCOPE_SPECIFICITY.sourceKind).toBeLessThan(
      SCOPE_SPECIFICITY.entityKind
    );
    expect(SCOPE_SPECIFICITY.entityKind).toBeLessThan(
      SCOPE_SPECIFICITY.channelType
    );
  });

  it("returns each resolved guideline's id + version + scopeRef (the manifest shape)", async () => {
    const [g] = await resolveGuidelines({
      db: makeDb([
        {
          ...row({
            id: "g-v3",
            scopeKind: "entityKind",
            scopeRef: "person",
            text: "v3 text",
          }),
          version: 3,
        },
      ]).db,
      userId: "u1",
      entityKinds: ["person"],
    });
    expect(g).toMatchObject({ id: "g-v3", version: 3, scopeRef: "person" });
  });

  it("a caller passing no data-type context resolves byte-identically with and without data-type rows present", async () => {
    const transportOnly = rows().filter(
      (r) => r.scopeKind !== "sourceKind" && r.scopeKind !== "entityKind"
    );
    const call = { userId: "u1", workspaceId: "ws-1", channelId: "chan-1" };
    const before = await resolveGuidelines({
      db: makeDb(transportOnly).db,
      ...call,
    });
    const after = await resolveGuidelines({ db: makeDb(rows()).db, ...call });
    // NON-VACUITY: the data-type rows really were in the second fixture.
    expect(rows().length - transportOnly.length).toBe(4);
    expect(before.map((g) => g.id)).toEqual(["g-default", "g-channel"]);
    expect(after).toEqual(before);
  });
});

describe("supersedeGuideline — an edit is a new version, never an in-place update", () => {
  function makeTxDb(current: Record<string, unknown> | undefined) {
    const inserted: Array<Record<string, unknown>> = [];
    const revokedIds: string[] = [];
    const tx = {
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              if (!current || current.revokedAt) return [];
              revokedIds.push(current.id as string);
              return [{ ...current, ...patch }];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            const r = { id: "new-row", ...v };
            inserted.push(r);
            return [r];
          },
        }),
      }),
      query: {
        configSettings: {
          findFirst: async () => (current ? { id: current.id } : undefined),
        },
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db: any = {
      transaction: async (fn: (t: unknown) => unknown) => fn(tx),
    };
    return { db, inserted, revokedIds };
  }

  const v2 = {
    id: "g-v2",
    key: "guideline",
    value: { text: "old", posture: "propose" },
    scopeKind: "entityKind",
    scopeRef: "person",
    shape: null,
    capabilityId: null,
    workspaceId: "ws-1",
    version: 2,
    supersedesId: "g-v1",
    revokedAt: null,
  };

  it("revokes the current row and inserts version+1 with the same scope and supersedesId lineage", async () => {
    const { db, inserted, revokedIds } = makeTxDb(v2);
    const { guideline, previous } = await supersedeGuideline({
      db,
      id: "g-v2",
      text: "new text",
      createdBy: "u1",
    });
    expect(revokedIds).toEqual(["g-v2"]);
    expect(previous.revokedAt).toBeInstanceOf(Date);
    expect(inserted).toHaveLength(1);
    expect(guideline).toMatchObject({
      version: 3,
      supersedesId: "g-v2",
      scopeKind: "entityKind",
      scopeRef: "person",
      workspaceId: "ws-1",
      // posture carries over when not given
      value: { text: "new text", posture: "propose" },
    });
  });

  it("refuses to supersede a version that is no longer current (no insert)", async () => {
    const { db, inserted } = makeTxDb({ ...v2, revokedAt: new Date() });
    await expect(
      supersedeGuideline({ db, id: "g-v2", text: "x", createdBy: "u1" })
    ).rejects.toMatchObject({ reason: "not_current" });
    expect(inserted).toHaveLength(0);
  });
});
