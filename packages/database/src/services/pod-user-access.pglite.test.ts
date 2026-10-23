/**
 * "Does this person still hold access here?" — `readPodUserAccess` +
 * `hasActivePodAccess`, driven through the real drizzle query on PGlite.
 *
 * The discriminating row is the REMOVED member: `workspaces.removeFromPod`
 * deletes their space memberships but leaves their `pod_members` row (it
 * records how they joined), so any rule that reads `pod_members` says they are
 * still in. The archived-space member rules out "any `workspace_members` row".
 *
 * NOT COVERED: the doors that call it (`invite-consent.test.ts` and the
 * federation route tests in apps/api).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  podMembers,
  workspaceMembers,
  workspaces,
} from "../schema/workspaces.js";
import { projects } from "../schema/projects.js";
import { projectMembers } from "../schema/project-members.js";
import { hasActivePodAccess, readPodUserAccess } from "./pod-user-access.js";

const client = new PGlite();
const db = drizzle(client, {
  schema: {
    podMembers,
    workspaceMembers,
    workspaces,
    projects,
    projectMembers,
  },
});
const conn = db as unknown as Parameters<typeof readPodUserAccess>[1];

/** Columns only: no constraints, so each row names just what it is about. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp)/.exec(t)?.[0] ?? "text";
    const dflt = c.name === "id" ? " default gen_random_uuid()" : "";
    return `"${c.name}" ${type === "timestamp" ? "timestamptz" : type}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const LIVE = "11111111-1111-4111-8111-111111111111";
const ARCHIVED = "22222222-2222-4222-8222-222222222222";
const POD_ADMIN = "33333333-3333-4333-8333-333333333333";
const PROJECT = "44444444-4444-4444-8444-444444444444";

async function access(userId: string): Promise<boolean> {
  return hasActivePodAccess(await readPodUserAccess(userId, conn));
}

beforeAll(async () => {
  for (const t of [
    podMembers,
    workspaceMembers,
    workspaces,
    projects,
    projectMembers,
  ]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  await client.exec(`
    insert into workspaces (id, name, system_slug, archived_at) values
      ('${LIVE}', 'Content', null, null),
      ('${ARCHIVED}', 'Old', null, now()),
      ('${POD_ADMIN}', 'Pod admin', 'pod-admin', null);
    insert into projects (id, name, workspace_id, status) values
      ('${PROJECT}', 'Launch', '${LIVE}', 'active');
    -- Removed from the Pod: the pod_members row stays, every space is gone.
    insert into pod_members (user_id, pod_role) values ('removed', 'member');
    insert into pod_members (user_id, pod_role) values ('member', 'member');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${LIVE}', 'member', 'editor'),
      ('${ARCHIVED}', 'archived-only', 'editor'),
      ('${POD_ADMIN}', 'admin', 'admin');
    insert into project_members (project_id, user_id, role) values
      ('${PROJECT}', 'project-only', 'viewer');
  `);
});
afterAll(async () => {
  await client.close();
});

describe("readPodUserAccess + hasActivePodAccess", () => {
  it("a member of a live space holds access", async () => {
    await expect(access("member")).resolves.toBe(true);
  });

  it("a person removed from the Pod does not, although their pod_members row stays", async () => {
    await expect(access("removed")).resolves.toBe(false);
  });

  it("a membership of an archived space alone is no access", async () => {
    await expect(access("archived-only")).resolves.toBe(false);
  });

  it("a live project membership holds access", async () => {
    await expect(access("project-only")).resolves.toBe(true);
  });

  it("a Pod admin holds access before joining any space", async () => {
    await expect(access("admin")).resolves.toBe(true);
  });

  it("an unknown person holds none", async () => {
    await expect(access("nobody")).resolves.toBe(false);
  });
});
