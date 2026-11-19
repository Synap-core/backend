/**
 * The consent offer's W3c additions (app permissions, decision 51ad8d1e):
 *
 *  - the projects a person may give an app a permission in, by name
 *    (`oauthAppProjectOffer`): every project they can SEE for a read
 *    (`projectVisibleWhere`), and for anything else only the projects whose
 *    home space they may WRITE in (`spacesOwnerMayWriteIn`) or that live in
 *    no space and are theirs. Archived projects, and projects in an archived
 *    space, are not offered;
 *  - each offer item's kinds group (F4: the `synap_requests` entry that
 *    listed its kinds), so the screen draws one row "Records: N kinds";
 *  - without options, the offer is exactly what it was.
 *
 * Rows that rule out a wrong rule:
 *  - Beta (a space the person only VIEWS) is readable, never writable: a
 *    "visible = writable" rule fails it;
 *  - Eta (no space, someone else's, the person an editor MEMBER of the
 *    project) is readable, never writable: a "project role writes" rule fails
 *    it;
 *  - Delta (a space the person cannot see) is never offered: an unfloored
 *    list fails it; Kappa (the same space, the person a project member) is
 *    readable through the member branch;
 *  - Theta (archived) and Iota (archived space) are never offered.
 *
 * Real: the app service on PGlite with every @synap/database table and the
 * real visibility predicates. Cannot see: production FKs.
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
import {
  kindGroupIndex,
  kindGroupOf,
  oauthAppOffer,
  oauthAppProjectOffer,
} from "./app-connect.js";

const OWNER = `owner-${randomUUID()}`;
const OTHER = `other-${randomUUID()}`;

const OWN = randomUUID(); // owned by OWNER
const VIEW = randomUUID(); // OWNER a viewer member
const EDIT = randomUUID(); // OWNER an editor member
const HIDDEN = randomUUID(); // OWNER no member
const ARCH = randomUUID(); // owned by OWNER, archived

const P = {
  alpha: randomUUID(), // in OWN
  beta: randomUUID(), // in VIEW
  gamma: randomUUID(), // in EDIT
  delta: randomUUID(), // in HIDDEN
  epsilon: randomUUID(), // no space, OWNER's
  zeta: randomUUID(), // no space, OTHER's
  eta: randomUUID(), // no space, OTHER's, OWNER an editor member of it
  theta: randomUUID(), // in OWN, archived
  iota: randomUUID(), // in ARCH
  kappa: randomUUID(), // in HIDDEN, OWNER a viewer member of it
};

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
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  await q(`insert into users (id) values ($1), ($2)`, [OWNER, OTHER]);
  await q(
    `insert into workspaces (id, name, owner_id, archived_at) values
       ($1, 'Own', $6, null),
       ($2, 'View', $7, null),
       ($3, 'Edit', $7, null),
       ($4, 'Hidden', $7, null),
       ($5, 'Archived', $6, now())`,
    [OWN, VIEW, EDIT, HIDDEN, ARCH, OWNER, OTHER]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values
       ($1, $3, 'viewer'), ($2, $3, 'editor')`,
    [VIEW, EDIT, OWNER]
  );
  const project = (
    id: string,
    name: string,
    workspaceId: string | null,
    userId: string,
    status = "active"
  ) =>
    q(
      `insert into projects (id, name, workspace_id, user_id, status) values ($1, $2, $3, $4, $5)`,
      [id, name, workspaceId, userId, status]
    );
  await project(P.alpha, "Alpha", OWN, OWNER);
  await project(P.beta, "Beta", VIEW, OTHER);
  await project(P.gamma, "Gamma", EDIT, OTHER);
  await project(P.delta, "Delta", HIDDEN, OTHER);
  await project(P.epsilon, "Epsilon", null, OWNER);
  await project(P.zeta, "Zeta", null, OTHER);
  await project(P.eta, "Eta", null, OTHER);
  await project(P.theta, "Theta", OWN, OWNER, "archived");
  await project(P.iota, "Iota", ARCH, OWNER);
  await project(P.kappa, "Kappa", HIDDEN, OTHER);
  await q(
    `insert into project_members (project_id, user_id, role) values
       ($1, $3, 'editor'), ($2, $3, 'viewer')`,
    [P.eta, P.kappa, OWNER]
  );
});

const names = (list: ReadonlyArray<{ projectName: string }>) =>
  list.map((p) => p.projectName);

describe("oauthAppProjectOffer — the projects a person may give", () => {
  it("reads: every project they can see, by name; writes: only where they may write", async () => {
    const offer = await oauthAppProjectOffer(OWNER);
    expect(names(offer.readable)).toEqual([
      "Alpha",
      "Beta",
      "Epsilon",
      "Eta",
      "Gamma",
      "Kappa",
    ]);
    expect(names(offer.writable)).toEqual(["Alpha", "Epsilon", "Gamma"]);
    expect(offer.readable.find((p) => p.projectId === P.alpha)).toEqual({
      projectId: P.alpha,
      projectName: "Alpha",
      workspaceId: OWN,
    });
    expect(offer.readable.find((p) => p.projectId === P.epsilon)).toEqual({
      projectId: P.epsilon,
      projectName: "Epsilon",
      workspaceId: null,
    });
  });

  // Rules out: another person's floor leaking into this one's offer.
  it("is the person's own: someone else sees their own projects", async () => {
    const offer = await oauthAppProjectOffer(OTHER);
    expect(names(offer.readable)).not.toContain("Epsilon");
    expect(names(offer.readable)).toContain("Zeta");
  });
});

describe("oauthAppOffer — spaces, and with options projects and kinds groups", () => {
  const permissions = ["entity.note.read", "entity.note.create"];
  const kindGroups = [{ permission: "entity.read", kinds: ["note", "task"] }];

  it("without options, each item is exactly its permission and spaces", async () => {
    const offer = await oauthAppOffer(OWNER, permissions);
    for (const item of offer)
      expect(Object.keys(item).sort()).toEqual(["permission", "workspaces"]);
    expect(offer.map((o) => o.workspaces.map((w) => w.workspaceName))).toEqual([
      ["Edit", "Own", "View"],
      ["Edit", "Own"],
    ]);
  });

  it("with projects: a read offers every visible project, a write only the writable ones", async () => {
    const [read, create] = await oauthAppOffer(OWNER, permissions, {
      projects: true,
      kindGroups,
    });
    expect(names(read!.projects!)).toEqual([
      "Alpha",
      "Beta",
      "Epsilon",
      "Eta",
      "Gamma",
      "Kappa",
    ]);
    expect(names(create!.projects!)).toEqual(["Alpha", "Epsilon", "Gamma"]);
    // The spaces are unchanged by the options.
    expect(read!.workspaces.map((w) => w.workspaceName)).toEqual([
      "Edit",
      "Own",
      "View",
    ]);
  });

  it("with kind groups: an item declared in a kinds entry carries it, another null", async () => {
    const [read, create] = await oauthAppOffer(OWNER, permissions, {
      kindGroups,
    });
    expect(read!.kindGroup).toEqual({
      permission: "entity.read",
      kinds: ["note", "task"],
    });
    expect(create!.kindGroup).toBeNull();
    expect(read!.projects).toBeUndefined();
  });
});

describe("kindGroupOf — the entry a permission was declared in (F4)", () => {
  it("finds the entry whose kinds expand to it, and nothing else", () => {
    const groups = [
      { permission: "entity.create", kinds: ["note"] },
      { permission: "entity.read", kinds: ["note", "task"] },
    ];
    expect(kindGroupOf("entity.task.read", groups)).toEqual({
      permission: "entity.read",
      kinds: ["note", "task"],
    });
    expect(kindGroupOf("entity.note.create", groups)).toEqual({
      permission: "entity.create",
      kinds: ["note"],
    });
    expect(kindGroupOf("entity.deal.read", groups)).toBeNull();
    expect(kindGroupOf("entity.read", groups)).toBeNull();
    expect(kindGroupOf("entity.task.read", [])).toBeNull();
  });

  // Rules out: a malformed cached row failing the consent (review of #1196).
  it("a malformed group names nothing and never throws", () => {
    const malformed = [
      null,
      "entity.read",
      { permission: "entity.read", kinds: null },
      { permission: "entity.read" },
      { permission: 42, kinds: ["note"] },
      { permission: "entity.read", kinds: [null, 3] },
      { permission: "entity.read", kinds: "note" },
    ];
    expect(() => kindGroupIndex(malformed)).not.toThrow();
    expect(kindGroupIndex(malformed).size).toBe(0);
    expect(kindGroupOf("entity.note.read", malformed)).toBeNull();
    expect(kindGroupIndex(null).size).toBe(0);
    // A good group beside malformed ones still answers.
    expect(
      kindGroupOf("entity.note.read", [
        ...malformed,
        { permission: "entity.read", kinds: ["note"] },
      ])
    ).toEqual({ permission: "entity.read", kinds: ["note"] });
  });

  // Rules out: a cached group trusted as written (it is expanded again).
  it("a group that does not expand names nothing", () => {
    expect(
      kindGroupOf("entity.note.read", [
        { permission: "entity.note.read", kinds: ["note"] },
        { permission: "playbook.read", kinds: ["note"] },
        { permission: "entity.read", kinds: ["Not A Slug"] },
      ])
    ).toBeNull();
  });
});
