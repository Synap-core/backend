/**
 * An employer a CSV row names is LINKED to the pod's existing entity of that
 * kind and name — through the real `linkExistingImportTargets` SQL on PGlite
 * (tables generated from the Drizzle definitions, so the scope predicate's
 * subqueries — membership, ownership, pod readers — run for real).
 *
 * Why it matters: an exact same-kind title is what `entities.create`'s weak
 * same-name gate REFUSES at apply, so without this link a contacts import that
 * names a company the pod already holds fails on approval instead of linking.
 *
 * Pinned: case/whitespace-insensitive match; same kind only; deleted rows and
 * rows outside the caller's scope never match; earliest-created wins; a failed
 * read throws (it is not "nothing exists").
 *
 * NOT covered: the alias / discord-handle surface forms `resolveIdentity`'s weak
 * path also reads (person-oriented; employers match on title).
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  users,
  podMembers,
  projectMembers,
  workspaces,
  workspaceMembers,
  profiles,
  type db as DatabaseHandle,
} from "@synap/database";
import * as schema from "@synap/database/schema";
import type { ImportItem } from "../../../import/import-items.js";
import { linkExistingImportTargets } from "../structuring.js";

const ME = "user-me";
const OTHER = "user-other";
const MY_WS = randomUUID();
const OTHER_WS = randomUUID();
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

let client: PGlite;
let database: typeof DatabaseHandle;

async function entity(row: {
  type: string;
  title: string;
  userId?: string;
  workspaceId?: string | null;
  deleted?: boolean;
  createdAt?: string;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, workspace_id, type, title, deleted_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      row.userId ?? ME,
      row.workspaceId ?? null,
      row.type,
      row.title,
      row.deleted ? new Date().toISOString() : null,
      row.createdAt ?? new Date().toISOString(),
    ]
  );
  return id;
}

const target = (title: string, typeHint = "company"): ImportItem => ({
  title,
  path: [],
  metadata: {},
  body: "",
  links: [],
  labels: [],
  typeHint,
});

beforeAll(async () => {
  client = new PGlite();
  for (const t of [
    entities,
    users,
    podMembers,
    projectMembers,
    workspaces,
    workspaceMembers,
    profiles,
  ]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  // With the schema: the kind match reads `profiles` through `db.query`.
  database = drizzle(client, { schema }) as unknown as typeof DatabaseHandle;
});

beforeEach(async () => {
  for (const t of [
    "entities",
    "users",
    "pod_members",
    "workspaces",
    "workspace_members",
  ]) {
    await client.exec(`delete from "${t}"`);
  }
  await client.query(`insert into users (id) values ($1), ($2)`, [ME, OTHER]);
  await client.query(
    `insert into pod_members (id, user_id) values (gen_random_uuid(), $1), (gen_random_uuid(), $2)`,
    [ME, OTHER]
  );
  await client.query(
    `insert into workspaces (id, owner_id, name) values ($1, $2, 'Mine'), ($3, $4, 'Theirs')`,
    [MY_WS, ME, OTHER_WS, OTHER]
  );
});

describe("linkExistingImportTargets", () => {
  it("links a same-kind, same-name entity the caller can see (case/space-insensitive)", async () => {
    const id = await entity({ type: "company", title: "Brindlewood  Labs" });
    const items = [target("brindlewood labs"), target("Saltmarsh & Co")];
    const n = await linkExistingImportTargets(
      { userId: ME, workspaceId: null },
      items,
      database
    );
    expect(n).toBe(1);
    expect(items[0]!.existingEntityId).toBe(id);
    expect(items[1]!.existingEntityId).toBeUndefined();
  });

  it("never links another kind, a deleted row, or a row outside the caller's scope", async () => {
    await entity({ type: "person", title: "Saltmarsh & Co" });
    await entity({ type: "company", title: "Brindlewood Labs", deleted: true });
    await entity({
      type: "company",
      title: "Quillfeather Partners",
      userId: OTHER,
      workspaceId: OTHER_WS,
    });
    const items = [
      target("Saltmarsh & Co"),
      target("Brindlewood Labs"),
      target("Quillfeather Partners"),
    ];
    const n = await linkExistingImportTargets(
      { userId: ME, workspaceId: MY_WS },
      items,
      database
    );
    expect(n).toBe(0);
    expect(items.map((i) => i.existingEntityId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("sees the caller's workspace and pod-wide rows under a workspace lens; earliest wins", async () => {
    const older = await entity({
      type: "company",
      title: "Saltmarsh & Co",
      workspaceId: MY_WS,
      createdAt: "2024-01-01T00:00:00Z",
    });
    await entity({
      type: "company",
      title: "Saltmarsh & Co",
      createdAt: "2025-01-01T00:00:00Z",
    });
    const items = [target("Saltmarsh & Co")];
    await linkExistingImportTargets(
      { userId: ME, workspaceId: MY_WS },
      items,
      database
    );
    expect(items[0]!.existingEntityId).toBe(older);
  });

  it("a failed read THROWS — it is not 'nothing exists'", async () => {
    const broken = {
      select: () => {
        throw new Error("db down");
      },
    } as unknown as typeof DatabaseHandle;
    await expect(
      linkExistingImportTargets(
        { userId: ME, workspaceId: null },
        [target("Brindlewood Labs")],
        broken
      )
    ).rejects.toThrow("db down");
  });
});
