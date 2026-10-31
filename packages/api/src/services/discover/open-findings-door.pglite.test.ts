/**
 * `readOpenBlockerFindings` against real rows on PGlite — the SQL that
 * `start-here-open-findings.test.ts` stubs out.
 *
 * WHY: the door read `properties->>'finding-status' = 'open'`, a key no
 * profile declares and no finding carries. On the founder's pod (30 Oct)
 * orient reported `openTotal: 0` over 296 findings, none resolved, 59 of them
 * `high`. A stubbed door could not see it.
 *
 * The seed is DISCRIMINATING — each row exists because one predicate decides
 * it: no status (open: nothing resolved it), each lifecycle category, a status
 * no option declares, a soft-deleted row, a row of another kind.
 *
 * Stubbed, and why:
 *  - `profileSlugScopeCondition` — the polymorphic kind door has its own
 *    tests; pinned to the fixture's `finding` profile id.
 *  - `resolveFacetVisibilityScope` — membership resolution, unrelated here.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  findingProfileId: "",
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, any>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client),
    profileSlugScopeCondition: async () =>
      actual.eq(actual.entities.profileId, h.findingProfileId),
  };
});

vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: async (userId: string) => ({
    userId,
    workspaceId: undefined,
    allowedWorkspaceIds: [],
  }),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { entities } from "@synap/database";
import {
  readOpenBlockerFindings,
  OPEN_FINDINGS_READ_CAP,
} from "./open-findings-door.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const U = "user-caller";
const P_TASK = randomUUID();
let minute = 0;

async function finding(over: {
  profileId?: string;
  severity?: string;
  status?: string | null;
  category?: string | null;
  deleted?: boolean;
}): Promise<string> {
  const id = randomUUID();
  // Each row one minute newer than the last: the page is newest first.
  const updatedAt = new Date(Date.UTC(2026, 9, 30, 0, minute++)).toISOString();
  await h.client!.query(
    `insert into entities (id, user_id, profile_id, type, title, properties, status, status_category, created_at, updated_at, deleted_at)
     values ($1, $2, $3, 'finding', 't', $4::jsonb, $5, $6, now(), $7, $8)`,
    [
      id,
      U,
      over.profileId ?? h.findingProfileId,
      JSON.stringify({ severity: over.severity ?? "high" }),
      over.status ?? null,
      over.category ?? null,
      updatedAt,
      over.deleted ? updatedAt : null,
    ]
  );
  return id;
}

beforeAll(async () => {
  await h.client!.exec(ddlFor(entities));
});

beforeEach(() => {
  // A fresh kind per test: rows of earlier tests are another kind's.
  h.findingProfileId = randomUUID();
});

describe("readOpenBlockerFindings", () => {
  it("counts a finding with no status as open, and a resolved one as not", async () => {
    await finding({});
    const noStatusBlocker = await finding({ severity: "blocker" });
    await finding({ status: "new", category: "open" });
    const working = await finding({
      severity: "blocker",
      status: "investigating",
      category: "active",
    });
    // Not open: resolved, dropped, parked, a status no option declares,
    // soft-deleted, and another kind.
    await finding({ severity: "blocker", status: "fixed", category: "done" });
    await finding({ severity: "blocker", status: "wontfix", category: "lost" });
    await finding({
      severity: "blocker",
      status: "parked",
      category: "paused",
    });
    await finding({ severity: "blocker", status: "weird", category: null });
    await finding({ severity: "blocker", deleted: true });
    await finding({ severity: "blocker", profileId: P_TASK });

    const out = await readOpenBlockerFindings(U);

    expect(out.openTotal).toBe(4);
    expect(out.blockers.map((r) => r.id)).toEqual([working, noStatusBlocker]);
  });

  it("reads CAP + 1 blockers so the caller can say there are more", async () => {
    for (let i = 0; i < OPEN_FINDINGS_READ_CAP + 3; i++) {
      await finding({ severity: "blocker" });
    }

    const out = await readOpenBlockerFindings(U);

    expect(out.blockers).toHaveLength(OPEN_FINDINGS_READ_CAP + 1);
    expect(out.openTotal).toBe(OPEN_FINDINGS_READ_CAP + 3);
  });
});
