/**
 * THE usage aggregate drives every consumer — parity through the REAL functions
 * on PGlite, plus the orient `who` block's filter-before-limit fix.
 *
 * Real: `loadEntityUsage` (its SQL, the owner-private floor, the soft-delete
 * rule, the LEFT JOIN on `user_entity_state`), orient's `discover()`, MCP
 * `buildGrounding`, `diagnoseWorkspaceObject`, and `rankProfilesByUsage` (the
 * function `GET /discover?summary=true` ranks with). Tables are generated from
 * the Drizzle definitions.
 *
 * The seed is DISCRIMINATING, not representative — each row exists because one
 * of the three pre-consolidation copies counted it differently:
 *   - a SOFT-DELETED entity in W1  → grounding's old copy counted it;
 *   - ANOTHER user's pod-scoped row → a floor-less copy would count it;
 *   - a workspace the caller is NOT in (W3) → an unfloored lens would count it;
 *   - an entity the caller OPENED  → only the blended rank can see it.
 *
 * Stubbed, and why:
 *  - `getUserAccessibleWorkspaceIds` — its pod-visible branch uses the
 *    relational `db.query` API; pinned to the caller's real memberships.
 *  - `profileSlugScopeCondition` — the polymorphic type door has its own
 *    tests; pinned to `type = 'user_observation'`.
 *  - team roster / facet scope / capability registry — unrelated reads that
 *    orient makes best-effort.
 *
 * NOT covered: the Hub REST route wiring (`rest/discover.ts` calls
 * `rankProfilesByUsage` in one place; typecheck only).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  memberships: [] as string[],
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
      actual.eq(actual.entities.type, "user_observation"),
  };
});

vi.mock("../../routers/hub-protocol/rest/_shared.js", () => ({
  getUserAccessibleWorkspaceIds: async () => h.memberships,
}));
vi.mock("../../utils/workspace-membership.js", () => ({
  resolveFacetVisibilityScope: async (userId: string) => ({
    userId,
    workspaceId: undefined,
    allowedWorkspaceIds: [],
  }),
}));
vi.mock("../team-roster-context.js", () => ({
  loadTeamRosterForCapture: async () => ({
    members: [],
    names: [],
    instructionBlock: null,
  }),
  formatTeamRosterBlock: () => null,
}));
vi.mock("../capabilities/capability-registry.js", () => ({
  listCapabilities: async () => [],
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  workspaces,
  workspaceMembers,
  userResourceState,
  projects,
  proposals,
  profiles,
  focusSessions,
} from "@synap/database";
import { loadEntityUsage, usageByWorkspace } from "./usage-aggregate.js";
import { rankProfilesByUsage } from "./profile-ranking.js";
import { discover } from "./discover.js";
import { buildGrounding } from "../../routers/mcp/http-handler.js";
import {
  createMCPServer,
  INSTRUCTIONS_BUDGET_BYTES,
} from "../../routers/mcp/index.js";
import { diagnoseWorkspaceObject } from "../diagnose/workspace.js";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const U = "user-caller";
const O = "user-other";
const W1 = randomUUID();
const W2 = randomUUID();
const W3 = randomUUID();
const P_TASK = randomUUID();
const P_NOTE = randomUUID();
let openedNoteId = "";

async function entity(over: {
  userId: string;
  workspaceId: string | null;
  profileId: string;
  type: string;
  deleted?: boolean;
  updatedAt?: string;
  title?: string;
  properties?: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, created_at, updated_at, deleted_at)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), $8, $9)`,
    [
      id,
      over.userId,
      over.workspaceId,
      over.profileId,
      over.type,
      over.title ?? "t",
      JSON.stringify(over.properties ?? {}),
      over.updatedAt ?? new Date().toISOString(),
      over.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

const listProfilesCaller = {
  profiles: {
    listProfiles: async () => ({
      profiles: [
        {
          id: P_TASK,
          slug: "task",
          displayName: "Task",
          scope: "system",
          profileKind: "kind",
        },
        {
          id: P_NOTE,
          slug: "note",
          displayName: "Note",
          scope: "workspace",
          workspaceId: W1,
          profileKind: "kind",
        },
      ],
    }),
  },
} as never;

beforeAll(async () => {
  for (const t of [
    entities,
    workspaces,
    workspaceMembers,
    userResourceState,
    projects,
    proposals,
    profiles,
    focusSessions,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  h.memberships = [W1, W2];
  for (const [id, name] of [
    [W1, "CRM"],
    [W2, "Builder"],
    [W3, "Not mine"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, workspace_type, settings, created_at, updated_at) values ($1, $2, 'personal', '{}'::jsonb, now(), now())`,
      [id, name]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner'), ($4, $5, $3, 'owner')`,
    [randomUUID(), W1, U, randomUUID(), W2]
  );

  // W1: 3 live tasks + 1 SOFT-DELETED task.
  for (let i = 0; i < 3; i++)
    await entity({
      userId: U,
      workspaceId: W1,
      profileId: P_TASK,
      type: "task",
    });
  await entity({
    userId: U,
    workspaceId: W1,
    profileId: P_TASK,
    type: "task",
    deleted: true,
  });
  // W2: 2 notes, one of them OPENED 7 times by the caller.
  openedNoteId = await entity({
    userId: U,
    workspaceId: W2,
    profileId: P_NOTE,
    type: "note",
  });
  await entity({ userId: U, workspaceId: W2, profileId: P_NOTE, type: "note" });
  await q(
    `insert into user_entity_state (user_id, item_id, item_type, starred, pinned, view_count, last_viewed_at, created_at, updated_at)
     values ($1, $2, 'entity', false, false, 7, now(), now(), now())`,
    [U, openedNoteId]
  );
  // W3: the caller is not a member.
  for (let i = 0; i < 5; i++)
    await entity({
      userId: O,
      workspaceId: W3,
      profileId: P_TASK,
      type: "task",
    });
  // Pod-scoped: 2 of the caller's own, 1 belonging to ANOTHER user.
  await entity({
    userId: U,
    workspaceId: null,
    profileId: P_TASK,
    type: "task",
  });
  await entity({
    userId: U,
    workspaceId: null,
    profileId: P_TASK,
    type: "task",
  });
  await entity({
    userId: O,
    workspaceId: null,
    profileId: P_TASK,
    type: "task",
  });
});

describe("the ONE usage aggregate", () => {
  it("floors: excludes soft-deletes, other users' pod rows, and workspaces not in the lens", async () => {
    const byWs = usageByWorkspace(
      await loadEntityUsage({
        userId: U,
        workspaceIds: [W1, W2, W3],
        includePodScoped: true,
      })
    );
    expect(byWs.get(W1)?.count).toBe(3);
    expect(byWs.get(W2)?.count).toBe(2);
    // W3 was REQUESTED but the owner-private floor refuses it.
    expect(byWs.get(W3)).toBeUndefined();
  });

  it("orient, MCP grounding and diagnose report the SAME per-workspace counts", async () => {
    const orient = await discover({
      caller: listProfilesCaller,
      userId: U,
      authScopes: ["mcp.read"],
      detail: "full",
    });
    const orientCount = (id: string) =>
      orient.workspaces.find((w) => w.id === id)?.entityCount;

    const grounding = (await buildGrounding(U)) ?? "";
    const groundingCount = (id: string) => {
      const m = grounding.match(new RegExp(`\\(${id}, (\\d+) entities\\)`));
      return m ? Number(m[1]) : undefined;
    };

    const diag = async (id: string) => {
      const r = await diagnoseWorkspaceObject(U, id);
      return "error" in r
        ? undefined
        : (r.state as { entityCount: number }).entityCount;
    };

    for (const [id, expected] of [
      [W1, 3],
      [W2, 2],
    ] as const) {
      expect({ ws: id, orient: orientCount(id) }).toEqual({
        ws: id,
        orient: expected,
      });
      expect({ ws: id, grounding: groundingCount(id) }).toEqual({
        ws: id,
        grounding: expected,
      });
      expect({ ws: id, diagnose: await diag(id) }).toEqual({
        ws: id,
        diagnose: expected,
      });
    }
  });

  it("ranks profiles for discover from the same rows: counts include the caller's pod bucket; opens lift a kind", async () => {
    const { ranked } = await rankProfilesByUsage({
      userId: U,
      profiles: (
        (await (listProfilesCaller as any).profiles.listProfiles()) as {
          profiles: any[];
        }
      ).profiles,
    });
    const task = ranked.find((r) => r.profile.slug === "task")!;
    const note = ranked.find((r) => r.profile.slug === "note")!;
    // 3 in W1 + the caller's 2 pod-scoped (never W3's 5, the deleted one, or O's).
    expect(task.entityCount).toBe(5);
    expect(note.entityCount).toBe(2);
    // Fewer entities, but opened 7× today — the blend ranks it first.
    expect(note.rank).toBe(1);
    expect(note.origin).toEqual({
      origin: "unknown",
      group: "workspace",
      workspaceId: W1,
    });
    expect(task.origin).toEqual({ origin: "core", group: "core" });
  });

  it("orient startHere.topKinds carries the same rank discover does", async () => {
    const orient = await discover({
      caller: listProfilesCaller,
      userId: U,
      authScopes: ["mcp.read"],
    });
    expect(Object.keys(orient)[0]).toBe("startHere");
    const top = orient.startHere.topKinds as Array<{
      slug: string;
      rank: number;
      entityCount: number;
    }>;
    expect(top.map((k) => [k.slug, k.rank, k.entityCount])).toEqual([
      ["note", 1, 2],
      ["task", 2, 5],
    ]);
  });
});

describe("orient `who` — qualify in SQL, then limit", () => {
  it("finds a validated observation that sits behind 45 weak guesses", async () => {
    const WHO_USER = "user-who";
    const P_OBS = randomUUID();
    const recent = (i: number) => new Date(Date.now() - i * 1000).toISOString();
    for (let i = 0; i < 45; i++) {
      await entity({
        userId: WHO_USER,
        workspaceId: null,
        profileId: P_OBS,
        type: "user_observation",
        updatedAt: recent(i),
        properties: { uo_observation: `weak guess ${i}`, uo_confidence: 0.1 },
      });
    }
    // Inserted LAST and OLDEST: past row 40 in insertion order AND in
    // newest-first order, so only a filter that runs before the limit finds it.
    await entity({
      userId: WHO_USER,
      workspaceId: null,
      profileId: P_OBS,
      type: "user_observation",
      updatedAt: "2020-01-01T00:00:00.000Z",
      properties: {
        uo_observation: "Ships in verified waves.",
        uo_validated: true,
      },
    });

    const orient = await discover({
      caller: listProfilesCaller,
      userId: WHO_USER,
      authScopes: ["mcp.read"],
      scope: ["projects"],
    });
    expect(orient.who).toContain("Ships in verified waves.");
    expect(orient.who).not.toContain("weak guess");
  });
});

describe("MCP instructions — the live initialize path on a hostile pod", () => {
  it("real buildGrounding + real createMCPServer stay within the budget and keep the grounding", async () => {
    const LIVE = "user-live-budget";
    for (let i = 0; i < 40; i++) {
      const id = randomUUID();
      await q(
        `insert into workspaces (id, name, workspace_type, settings, created_at, updated_at) values ($1, $2, 'personal', '{}'::jsonb, now(), now())`,
        [id, `Operations and Revenue Workspace Number ${i} — Émeraude`]
      );
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'owner')`,
        [randomUUID(), id, LIVE]
      );
    }
    const grounding = await buildGrounding(LIVE);
    expect(grounding).toContain("Domains, busiest first:");
    const server = createMCPServer(undefined, LIVE, grounding) as unknown as {
      _instructions?: string;
    };
    const live = server._instructions ?? "";
    expect(Buffer.byteLength(live)).toBeLessThanOrEqual(
      INSTRUCTIONS_BUDGET_BYTES
    );
    expect(live).toContain(grounding!);
  });
});
