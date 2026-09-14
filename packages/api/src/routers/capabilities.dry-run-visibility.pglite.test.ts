/**
 * SECURITY — `capabilities.dryRun` resolves verbs through `visibleSkillsWhere`:
 * never another user's private skill, never a non-member workspace's.
 *
 * Driven through the REAL router procedure on PGlite. Fixture verbs are
 * `kind:"declarative"`, so a RESOLVED verb returns `dry-run-unavailable` before
 * any IS call and an unresolved one returns `not_found` — the two outcomes are
 * the visibility verdict, with no network involved.
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return {
    ...actual,
    db: drizzle(client, { schema: { skills: schema.skills } as never }),
  };
});

// The tRPC read-only guard reads `sync_generation` via the relational API; it
// is not what this test is about, so the pod is simply writable.
vi.mock("../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { skills, workspaces, workspaceMembers } from "@synap/database/schema";
import { capabilitiesRouter } from "./capabilities.js";

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const raw = c.getSQLType();
    const isArray = raw.endsWith("[]");
    const base = raw.replace(/\[\]$/, "").replace(/\(.*\)/, "");
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp with time zone|timestamp)$/.test(
        base
      )
        ? base
        : "text";
    let def = "";
    if (c.hasDefault) {
      const d = c.default;
      if (isArray) def = " default '{}'";
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (typeof d === "string")
        def = ` default '${d.replace(/'/g, "''")}'`;
      else if (d && typeof d === "object" && !("queryChunks" in d))
        def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
      else if (type === "uuid") def = " default gen_random_uuid()";
      else if (type.startsWith("timestamp")) def = " default now()";
    }
    return `"${c.name}" ${type}${isArray ? "[]" : ""}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const USER = randomUUID();
const OTHER = randomUUID();
const WS_MEMBER = randomUUID();
const WS_STRANGER = randomUUID();

async function seedVerb(
  name: string,
  userId: string,
  scope: "pod" | "user" | "workspace",
  workspaceId: string | null = null
): Promise<void> {
  await h.client!.query(
    `insert into skills (id, user_id, workspace_id, slug, kind, scope, name, status, approved)
     values ($1,$2,$3,$4,'declarative',$5,$6,'active',true)`,
    [randomUUID(), userId, workspaceId, `verbs/${name}`, scope, name]
  );
}

beforeAll(async () => {
  for (const t of [skills, workspaces, workspaceMembers] as PgTable[]) {
    await h.client!.exec(ddlFor(t));
  }
  await h.client!.query(
    `insert into workspaces (id, owner_id, settings) values ($1,$2,'{}'::jsonb),($3,$2,'{}'::jsonb)`,
    [WS_MEMBER, OTHER, WS_STRANGER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id) values ($1,$2,$3)`,
    [randomUUID(), WS_MEMBER, USER]
  );
  await seedVerb("verb.other_private", OTHER, "user");
  await seedVerb("verb.mine", USER, "user");
  await seedVerb("verb.pod", OTHER, "pod");
  await seedVerb("verb.member_ws", OTHER, "workspace", WS_MEMBER);
  await seedVerb("verb.stranger_ws", OTHER, "workspace", WS_STRANGER);
});

const callerFor = (userId: string) =>
  capabilitiesRouter.createCaller({
    authenticated: true,
    userId,
  } as never);

async function outcome(userId: string, verbId: string, workspaceId: string) {
  const res = await callerFor(userId).dryRun({ verbId, workspaceId });
  return res.kind;
}

describe("SECURITY — capabilities.dryRun resolves verbs through the one skill lens", () => {
  it("another user's user-scope skill by NAME is unresolvable; the owner resolves it", async () => {
    expect(await outcome(USER, "verb.other_private", WS_MEMBER)).toBe(
      "not_found"
    );
    expect(await outcome(OTHER, "verb.other_private", WS_MEMBER)).toBe(
      "dry-run-unavailable"
    );
  });

  it("own and pod skills resolve", async () => {
    expect(await outcome(USER, "verb.mine", WS_MEMBER)).toBe(
      "dry-run-unavailable"
    );
    expect(await outcome(USER, "verb.pod", WS_MEMBER)).toBe(
      "dry-run-unavailable"
    );
  });

  it("input.workspaceId is membership-checked: a stranger workspace's skill does not resolve, a member workspace's does", async () => {
    expect(await outcome(USER, "verb.member_ws", WS_MEMBER)).toBe(
      "dry-run-unavailable"
    );
    expect(await outcome(USER, "verb.stranger_ws", WS_STRANGER)).toBe(
      "not_found"
    );
  });
});
