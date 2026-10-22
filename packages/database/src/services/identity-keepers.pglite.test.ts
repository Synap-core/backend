/**
 * `readIdentityKeepers` — what still holds a person's identity once they are
 * out of every space, driven through the real drizzle queries on PGlite.
 *
 * Each keeper has ONE person who holds only it, so removing a keeper's table
 * read flips exactly that person to "nothing keeps them" (checked by reverting
 * each query, see the PR). The never-joined person is the control: the only
 * one for whom an empty list is right.
 *
 * NOT COVERED: who may delete (`workspaces.removeFromPod`'s pod-admin check,
 * `workspaces.pod-invite-and-removal.pglite.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { documents } from "../schema/documents.js";
import { entities } from "../schema/entities.js";
import { federatedIdentityLinks } from "../schema/federation.js";
import { messages } from "../schema/messages.js";
import { projectMembers } from "../schema/project-members.js";
import { projects } from "../schema/projects.js";
import { proposals } from "../schema/proposals.js";
import {
  podMembers,
  workspaceMembers,
  workspaces,
} from "../schema/workspaces.js";
import { readIdentityKeepers } from "./identity-keepers.js";

const TABLES = [
  podMembers,
  workspaceMembers,
  workspaces,
  projects,
  projectMembers,
  federatedIdentityLinks,
  entities,
  documents,
  proposals,
  messages,
];
const client = new PGlite();
const db = drizzle(client, {
  schema: {
    podMembers,
    workspaceMembers,
    workspaces,
    projects,
    projectMembers,
    federatedIdentityLinks,
    entities,
    documents,
    proposals,
    messages,
  },
});
const conn = db as unknown as Parameters<typeof readIdentityKeepers>[1];

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

beforeAll(async () => {
  for (const t of TABLES) await client.exec(ddlFor(t as unknown as PgTable));
  await client.exec(`
    insert into workspaces (id, name) values ('${LIVE}', 'Content');
    insert into workspace_members (workspace_id, user_id, role) values
      ('${LIVE}', 'in-a-space', 'editor');
    insert into pod_members (user_id, pod_role) values ('joined', 'member');
    insert into federated_identity_links (issuer_id, issuer_subject, user_id)
      values ('22222222-2222-4222-8222-222222222222', 'sub-1', 'linked');
    insert into entities (id, user_id) values (gen_random_uuid(), 'author-entity');
    insert into entities (id, user_id, created_by_user_id)
      values (gen_random_uuid(), 'someone-else', 'author-created-by');
    insert into documents (id, user_id) values (gen_random_uuid(), 'author-doc');
    insert into proposals (id, created_by) values (gen_random_uuid(), 'author-proposal');
    insert into messages (id, user_id) values (gen_random_uuid(), 'author-message');
  `);
});
afterAll(async () => {
  await client.close();
});

describe("readIdentityKeepers", () => {
  it("a person who never joined and wrote nothing is kept by nothing", async () => {
    await expect(readIdentityKeepers("never-joined", conn)).resolves.toEqual(
      []
    );
  });

  it("access in a live space keeps them", async () => {
    await expect(readIdentityKeepers("in-a-space", conn)).resolves.toEqual([
      "active_access",
    ]);
  });

  it("a pod_members row alone keeps them", async () => {
    await expect(readIdentityKeepers("joined", conn)).resolves.toEqual([
      "pod_member",
    ]);
  });

  it("a linked Synap account alone keeps them", async () => {
    await expect(readIdentityKeepers("linked", conn)).resolves.toEqual([
      "linked_account",
    ]);
  });

  it.each([
    ["author-entity"],
    ["author-created-by"],
    ["author-doc"],
    ["author-proposal"],
    ["author-message"],
  ])("authored data alone keeps them (%s)", async (who) => {
    await expect(readIdentityKeepers(who, conn)).resolves.toEqual([
      "authored_data",
    ]);
  });
});
