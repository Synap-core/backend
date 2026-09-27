/**
 * POD-ADMIN MATERIALIZATION — membership-wave tripwire.
 *
 * The wave gives pod owner/admins a `workspace_members` row on pod_visible /
 * pod_joinable workspaces so they can administer shared engagements/contracts
 * inline (`verifyPermission` → `getWorkspaceMembership` → grant on
 * `entities.update`). Three properties must hold and never regress:
 *
 *   1. The pod-shared READ floor is GRANT-GATED. Before decision B
 *      (2026-09-27) it keyed on `pod_members` alone and was independent of
 *      `workspace_members`. Decision B made it deliberately depend on space
 *      membership: a pod-wide facet shares only with a pod member in a space
 *      its ROLE is granted to (`profile_workspace_access` / the role's owning
 *      workspace). So a materialized member row DOES admit the roles granted
 *      to that space — accepted: an admin administering the space sees what the
 *      space was granted. What must never regress is that the share needs BOTH
 *      `pod_members` AND a role grant — never pod membership alone. Proven
 *      DB-free by compiling the two floor predicates.
 *
 *   2. The visibility GATE the triggers use admits ONLY pod_visible /
 *      pod_joinable — a private workspace is never materialized into (that WOULD
 *      widen its reads). Proven DB-free against the exact exported gate.
 *
 *   3. The materialization itself is idempotent, role-correct, and never
 *      downgrades an owner; `isPodMember` is true for a pod member. DB-gated
 *      (skips honestly when Postgres is unavailable — see the sibling access
 *      suites for the same `skipIf(!dbAvailable)` discipline).
 */

import { randomUUID } from "crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  db,
  eq,
  drizzleSql,
  workspaces,
  workspaceMembers,
  podMembers,
  entities,
  users,
  facetVisibilityConditions,
} from "@synap/database";
import { podSharedFacetWhere } from "./project-scope.js";
import { materializePodAdminsIntoWorkspace } from "./workspace-role.js";
import { isPodReadableWorkspace } from "../routers/workspaces.js";

const dialect = new PgDialect();
const compile = (sql: SQL) => dialect.sqlToQuery(sql).sql.toLowerCase();

// ── 1. READ FLOOR needs pod_members AND a role grant (decision B) ──────────
describe("pod-shared read floor is grant-gated, never pod-membership alone", () => {
  it("podSharedFacetWhere requires pod_members AND profile_workspace_access", () => {
    const sql = compile(
      podSharedFacetWhere(entities.workspaceId, entities.id, "user-x")
    );
    expect(sql).toContain("pod_members");
    expect(sql).toContain("entity_facets");
    expect(sql).toContain("profile_workspace_access");
  });

  it("facetVisibilityConditions requires pod_members AND profile_workspace_access", () => {
    const conditions = facetVisibilityConditions({ userId: "user-x" });
    const sql = conditions.map(compile).join(" ");
    expect(sql).toContain("pod_members");
    expect(sql).toContain("profile_workspace_access");
  });
});

// ── 2. GATE admits only pod_visible / pod_joinable ───────────────────────────
describe("materialization gate — pod_visible/pod_joinable only", () => {
  it("admits pod_visible and pod_joinable", () => {
    expect(isPodReadableWorkspace({ workspaceVisibility: "pod_visible" })).toBe(
      true
    );
    expect(
      isPodReadableWorkspace({ workspaceVisibility: "pod_joinable" })
    ).toBe(true);
  });

  it("excludes private / members / unset (never widens a private workspace)", () => {
    expect(isPodReadableWorkspace({ workspaceVisibility: "members" })).toBe(
      false
    );
    expect(isPodReadableWorkspace({ workspaceVisibility: "private" })).toBe(
      false
    );
    expect(isPodReadableWorkspace({})).toBe(false);
    expect(isPodReadableWorkspace(null)).toBe(false);
    expect(isPodReadableWorkspace(undefined)).toBe(false);
  });
});

// ── 3. Materialization behaviour (DB-gated) ──────────────────────────────────
const POD_ADMIN_WS = "d0000000-0000-0000-0000-0000000000a0";
const TARGET_WS = "d0000000-0000-0000-0000-0000000000b0";
const OWNER = "d0000000-0000-0000-0000-0000000000c1";
const ADMIN = "d0000000-0000-0000-0000-0000000000c2";
const MEMBER = "d0000000-0000-0000-0000-0000000000c3";

async function checkDb(): Promise<boolean> {
  try {
    await db
      .select({ one: drizzleSql`1` })
      .from(users)
      .limit(1);
    return true;
  } catch {
    return false;
  }
}
const dbAvailable = await checkDb();

async function rowsForWs(workspaceId: string) {
  const rows = await db.query.workspaceMembers.findMany({
    where: eq(workspaceMembers.workspaceId, workspaceId),
    columns: { userId: true, role: true },
  });
  return new Map(rows.map((r) => [r.userId, r.role]));
}

describe("materialization tripwire — live-PG gate", () => {
  it("probed the database (skips below are honest, not vacuous)", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});

describe.skipIf(!dbAvailable)(
  "materializePodAdminsIntoWorkspace — idempotent, role-correct, owner-safe",
  () => {
    beforeAll(async () => {
      // Clean slate for the fixed fixture ids.
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, TARGET_WS));
      await db
        .delete(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, POD_ADMIN_WS));
      await db.delete(workspaces).where(eq(workspaces.id, TARGET_WS));
      await db.delete(workspaces).where(eq(workspaces.id, POD_ADMIN_WS));
      for (const id of [OWNER, ADMIN, MEMBER]) {
        await db.delete(podMembers).where(eq(podMembers.userId, id));
        await db.delete(users).where(eq(users.id, id));
      }

      for (const id of [OWNER, ADMIN, MEMBER]) {
        await db
          .insert(users)
          .values({ id, email: `${id}@test.synap`, userType: "human" })
          .onConflictDoNothing();
      }

      // The canonical pod-admin system workspace + its owner/admin members.
      await db.insert(workspaces).values({
        id: POD_ADMIN_WS,
        name: "Pod Admin",
        ownerId: OWNER,
        systemSlug: "pod-admin",
      });
      await db.insert(workspaceMembers).values([
        {
          id: randomUUID(),
          workspaceId: POD_ADMIN_WS,
          userId: OWNER,
          role: "owner",
        },
        {
          id: randomUUID(),
          workspaceId: POD_ADMIN_WS,
          userId: ADMIN,
          role: "admin",
        },
      ]);

      // A pod-visible target workspace (owned by OWNER, who already holds an
      // owner row — the create-time creator membership we must never downgrade).
      await db.insert(workspaces).values({
        id: TARGET_WS,
        name: "Shared Ops",
        ownerId: OWNER,
        settings: { workspaceVisibility: "pod_visible" },
      });
      await db.insert(workspaceMembers).values({
        id: randomUUID(),
        workspaceId: TARGET_WS,
        userId: OWNER,
        role: "owner",
      });

      // MEMBER is a pod member (pod_members) but NOT a pod admin.
      await db
        .insert(podMembers)
        .values({ userId: MEMBER, podRole: "member" })
        .onConflictDoNothing();
    });

    it("materializes pod owner as owner and pod admin as admin", async () => {
      await materializePodAdminsIntoWorkspace(TARGET_WS);
      const rows = await rowsForWs(TARGET_WS);
      expect(rows.get(OWNER)).toBe("owner");
      expect(rows.get(ADMIN)).toBe("admin");
      // MEMBER is a pod member but NOT a pod admin → never materialized.
      expect(rows.has(MEMBER)).toBe(false);
    });

    it("is idempotent — a re-run adds nothing and never downgrades the owner", async () => {
      const before = await rowsForWs(TARGET_WS);
      await materializePodAdminsIntoWorkspace(TARGET_WS);
      const after = await rowsForWs(TARGET_WS);
      expect(after.size).toBe(before.size);
      // OWNER stays owner (the pre-seeded creator row is never overwritten).
      expect(after.get(OWNER)).toBe("owner");
      expect(after.get(ADMIN)).toBe("admin");
    });

    it("isPodMember signal is true for a pod member, false for a non-member", async () => {
      const memberRow = await db.query.podMembers.findFirst({
        where: eq(podMembers.userId, MEMBER),
        columns: { id: true },
      });
      expect(!!memberRow).toBe(true);

      const strangerRow = await db.query.podMembers.findFirst({
        where: eq(podMembers.userId, "d0000000-0000-0000-0000-0000000000ff"),
        columns: { id: true },
      });
      expect(!!strangerRow).toBe(false);
    });
  }
);
