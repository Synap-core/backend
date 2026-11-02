/**
 * A POD-WIDE READ (founder decision e1b59d38 "B", 2026-10-30): an app the
 * person gave "read decisions, everywhere in your pod" reads decisions in
 * every space and outside any space, and NOTHING else beyond its spaces; its
 * writes stay pinned to the spaces it was given.
 *
 * Driven through the REAL chain on PGlite, as `app-connect.grants` is:
 * `grantsForApprovedRequests` → `attachGrantsOrRevoke` (the grant write door)
 * → `GrantRepository.resolveForKey` (what every key-auth door enters) →
 * `keyGrantReadClause` (the read floor) and `checkPermissionOrPropose` (the
 * write gate), plus the door fence (`grantBoundsDoor`).
 *
 * The approval holds what a forged or stale row could hold too: a WRITE and an
 * every-kind read with no space. Rows that rule out a wrong rule:
 *  - a decision in FINANCE and a pod-wide one are READ (no pod-wide scope, or
 *    one pinned to SALES, drops them);
 *  - a task in FINANCE or pod-wide is NOT read (an every-kind read with no
 *    space, kept from the forged row, reads them);
 *  - updating or deleting a decision anywhere is grant-DENIED (a write kept
 *    pod-wide permits it), while creating a task in SALES is NOT (a "deny
 *    every write" fix passes the first and fails this one);
 *  - the aggregate doors that need every kind stay closed (READS("entity")),
 *    which an every-kind read with no space would open.
 *
 * Cannot see: production Postgres constraints (tables come from the Drizzle
 * definitions without FKs / NOT NULL / enums), and the person's floor (the
 * clause is read alone: effective = this clause ∩ the floor, which only
 * narrows; `grant-read-space-reach` covers the composition).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { isPodWideReadScope } from "@synap/database/schema";
import { GrantRepository, runWithGrant, type KeyGrant } from "@synap/database";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import { attachGrantsOrRevoke } from "./key-grant.js";
import {
  appApprovalWithinAsked,
  appRequestsWithin,
  grantsForApprovedRequests,
} from "./app-connect.js";
import { requestsWithin } from "./agent-connect.js";
import { describeAppSignIn } from "../routers/oauth/app-client.js";
import { keyGrantReadClause } from "../access/grant-read.js";
import {
  grantBoundsDoor,
  MCP_READ_TOOL_DOORS,
} from "../access/grant-door-fence.js";
import { grantedWorkspaceIdsOf } from "./intake/capture-schema-linking.js";

const SALES = randomUUID();
const FINANCE = randomUUID();
const KEY = randomUUID();
const DECISION_FINANCE = randomUUID();
const DECISION_POD = randomUUID();
const TASK_FINANCE = randomUUID();
const TASK_POD = randomUUID();
const TASK_SALES = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def = c.name === "created_at" ? " default now()" : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

let keyGrant: KeyGrant;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await h.client!.query(
    `insert into entities (id, type, user_id, workspace_id) values
       ($1, 'decision', 'human-1', $6), ($2, 'decision', 'human-1', null),
       ($3, 'task', 'human-1', $6), ($4, 'task', 'human-1', null),
       ($5, 'task', 'human-1', $7)`,
    [
      DECISION_FINANCE,
      DECISION_POD,
      TASK_FINANCE,
      TASK_POD,
      TASK_SALES,
      FINANCE,
      SALES,
    ]
  );
  await attachGrantsOrRevoke({
    apiKeyId: KEY,
    principalUserId: "human-1",
    onBehalfOf: "human-1",
    grants: grantsForApprovedRequests([
      { permission: "entity.task.read", workspaceId: SALES },
      { permission: "entity.task.create", workspaceId: SALES },
      { permission: "entity.decision.read", workspaceId: null },
      // What only a forged or stale row holds: never kept pod-wide.
      { permission: "entity.decision.update", workspaceId: null },
      { permission: "entity.decision", workspaceId: null },
      { permission: "entity.read", workspaceId: null },
    ]),
    expiresAt: null,
    createdBy: "human-1",
    clientId: "app_test",
  });
  keyGrant = (await new GrantRepository(h.db as never).resolveForKey(KEY))!;
});

const readable = async () => {
  const clause = keyGrantReadClause(schema.entities, keyGrant);
  const rows = await (h.db as any)
    .select({ id: schema.entities.id })
    .from(schema.entities)
    .where(clause);
  return rows.map((r: { id: string }) => r.id).sort();
};

const write = (
  action: "create" | "update" | "delete",
  workspaceId: string | null,
  data: Record<string, unknown>
) =>
  runWithGrant(keyGrant, () =>
    checkPermissionOrPropose({
      userId: "human-1",
      workspaceId,
      subjectType: "entity",
      action,
      data,
    } as Parameters<typeof checkPermissionOrPropose>[0])
  ).catch((e: unknown) => ({ thrown: String(e) }));

const grantDenied = (r: unknown) =>
  /grant does not allow/.test((r as { reason?: string }).reason ?? "");

describe("the key an approval with a pod-wide read makes", () => {
  it("holds one scope per space plus ONE unpinned scope of exactly the pod-wide reads", () => {
    expect(keyGrant.scopes).toHaveLength(2);
    const pod = keyGrant.scopes.find((s) => !s.workspaceIds);
    expect(pod?.permissions).toEqual(["entity.decision.read"]);
    expect(isPodWideReadScope(pod!)).toBe(true);
    const sales = keyGrant.scopes.find((s) => s.workspaceIds);
    expect(sales?.workspaceIds).toEqual([SALES]);
    expect(isPodWideReadScope(sales!)).toBe(false);
  });
});

describe("reads: the kind everywhere, nothing else beyond its spaces", () => {
  it("reads decisions in another space and outside any space", async () => {
    const seen = await readable();
    expect(seen).toContain(DECISION_FINANCE);
    expect(seen).toContain(DECISION_POD);
  });

  it("reads no task outside SALES: not in FINANCE, not pod-wide", async () => {
    const seen = await readable();
    expect(seen).not.toContain(TASK_FINANCE);
    expect(seen).not.toContain(TASK_POD);
    expect(seen).toContain(TASK_SALES);
    expect(seen).toEqual([DECISION_FINANCE, DECISION_POD, TASK_SALES].sort());
  });

  it("does not open an aggregate door that needs every kind (READS entity)", () => {
    const everyKind = MCP_READ_TOOL_DOORS.synap_list_profiles;
    expect(grantBoundsDoor(everyKind, keyGrant)).toBe(false);
    // Positive control: an unpinned read of EVERY kind does open it, so the
    // false above is the pod-wide scope's one kind, not a closed door.
    expect(
      grantBoundsDoor(everyKind, {
        clientId: null,
        scopes: [
          {
            permissions: ["entity.read"],
            workspaceIds: null,
            projectIds: null,
            entityIds: null,
          },
        ],
      })
    ).toBe(true);
  });

  it("does not lift the space narrowing of capture routing and facet reach", () => {
    expect(grantedWorkspaceIdsOf(keyGrant)).toEqual(new Set([SALES]));
  });
});

describe("writes stay pinned to the spaces it was given", () => {
  it("can NOT update or delete a decision, in another space or pod-wide", async () => {
    for (const [action, ws, id] of [
      ["update", FINANCE, DECISION_FINANCE],
      ["update", null, DECISION_POD],
      ["delete", FINANCE, DECISION_FINANCE],
      ["delete", null, DECISION_POD],
    ] as const) {
      expect(
        grantDenied(await write(action, ws, { id })),
        `${action} ${id} in ${ws}`
      ).toBe(true);
    }
  });

  it("can NOT create a decision or a task outside SALES", async () => {
    expect(
      grantDenied(await write("create", FINANCE, { profileSlug: "decision" }))
    ).toBe(true);
    expect(
      grantDenied(await write("create", null, { profileSlug: "decision" }))
    ).toBe(true);
    expect(
      grantDenied(await write("update", FINANCE, { id: TASK_FINANCE }))
    ).toBe(true);
  });

  it("is not grant-denied creating a task in SALES (what was approved)", async () => {
    const r = await write("create", SALES, { profileSlug: "task" });
    expect(grantDenied(r)).toBe(false);
    // Past the grant rung (no membership row in this harness, so the next
    // rung answers): not a thrown error read as "not denied".
    expect((r as { reason?: string }).reason).toMatch(/not a member/);
  });
});

// The consent's "is it on offer" check (`connectOAuthApp`) and the executor's
// "within what was asked" check (`appApprovalWithinAsked`). Rules out: an
// app's pod-wide ask read as "any space", which let a hand-edited consent
// approve `entity.decision.read` IN FINANCE (FINANCE never offered) and make
// the app's agent a viewer of FINANCE.
describe("an app's pod-wide ask covers the pod-wide read only", () => {
  const ASKED = [
    { permission: "entity.task.create", workspaceId: SALES },
    { permission: "entity.decision.read", workspaceId: null },
  ];

  it("accepts what was asked, place by place", () => {
    expect(appRequestsWithin(ASKED, ASKED)).toBe(true);
    expect(appRequestsWithin([ASKED[1]!], ASKED)).toBe(true);
  });

  it("refuses the pod-wide read moved into a space, offered there or not", () => {
    for (const ws of [FINANCE, SALES]) {
      const forged = [{ permission: "entity.decision.read", workspaceId: ws }];
      expect(appRequestsWithin(forged, ASKED), ws).toBe(false);
      expect(
        appApprovalWithinAsked({
          data: { data: { asked: ASKED } },
          revisionHistory: [],
          approved: forged,
        }),
        ws
      ).toBe(false);
    }
  });

  it("still refuses a space-pinned ask widened to pod-wide", () => {
    expect(
      appRequestsWithin(
        [{ permission: "entity.task.create", workspaceId: null }],
        ASKED
      )
    ).toBe(false);
  });

  it("leaves an AI's ask with no space covering any space (agent/connect)", () => {
    expect(
      requestsWithin(
        [{ permission: "entity.decision.read", workspaceId: FINANCE }],
        ASKED
      )
    ).toBe(true);
  });
});

// The owner's sign-in keeps its pod-wide reads (`appSignInReach`). Rules out:
// a sign-in screen that leaves them out and still says the app sees nothing
// outside its spaces.
describe("the owner's sign-in names the pod-wide reads it carries", () => {
  it("says them after the spaces, and drops 'nothing outside these spaces'", async () => {
    await h.client!.query(
      `insert into workspaces (id, name) values ($1, 'Sales') on conflict do nothing`,
      [SALES]
    );
    const d = await describeAppSignIn("DevPlane", "Antoine", [
      { permission: "entity.task.read", workspaceId: SALES },
      { permission: "entity.decision.read", workspaceId: null },
    ]);
    expect(d.headline).toMatch(
      /^DevPlane will act as you in: Sales\. .*Decisions.*, everywhere in your pod\.$/
    );
    expect(d.spaces.map((s) => s.name)).toEqual(["Sales"]);
    expect(d.cannot).toContain("see anything else outside");
  });

  it("without pod-wide reads, reads as before", async () => {
    const d = await describeAppSignIn("DevPlane", "Antoine", [
      { permission: "entity.task.read", workspaceId: SALES },
    ]);
    expect(d.headline).toBe("DevPlane will act as you in: Sales.");
    expect(d.cannot).toContain(
      "see anything outside what a member of these spaces sees"
    );
  });
});
