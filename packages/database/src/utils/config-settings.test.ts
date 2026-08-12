import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { resolveGuidelines } from "./config-settings.js";

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
  scopeKind: "default" | "bridge" | "channelType" | "channel" | "shape";
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

    // General → specific: default (0) < channel (3) < shape (4). The two
    // non-matching rows are dropped.
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
