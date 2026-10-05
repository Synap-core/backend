/**
 * ONE SPACE PER DOMAIN — `checkOneSpacePerDomain` on PGlite, against the REAL
 * idempotent create (`createWorkspaceFromDefinitionIdempotent`, step 1 key hit
 * + step 1b legacy fallback) so "would this request REUSE?" is the same
 * answer the create gives, never a re-guess.
 *
 * Founder rule (2026-10-05): a space is a domain installed once; a project
 * filters it. An AGENT asking for a second space of a live domain is refused
 * with a typed `exists`; a HUMAN (incl. a named `--as` instance) proceeds with
 * the same guidance as a note. First installs and re-installs are unaffected.
 *
 * Stubbed exactly as `workspace-named-instance.pglite.test.ts` (the create
 * inserts the workspace + owner membership rows only). Not covered here: the
 * doors' wiring (packages.instance-name / workspace.create-status /
 * workspaces.from-definition-governance tests).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
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
  const { randomUUID: uuid } = await import("node:crypto");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    reconcileWorkspaceFromDefinition: async () => ({}),
    // The create: one workspace row + an owner membership — all the
    // idempotency queries read.
    createWorkspaceFromDefinition: async (input: {
      userId: string;
      workspaceName?: string;
      packageSlug?: string;
    }) => {
      const id = uuid();
      await client.query(
        `insert into workspaces (id, name, owner_id, package_slug, settings) values ($1,$2,$3,$4,'{}'::jsonb)`,
        [
          id,
          input.workspaceName ?? "Template",
          input.userId,
          input.packageSlug ?? null,
        ]
      );
      await client.query(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
        [uuid(), id, input.userId]
      );
      return { workspaceId: id };
    },
  };
});
vi.mock("@synap/jobs", () => ({
  getBoss: () => ({ send: async () => undefined }),
}));
vi.mock("./capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: async () => null,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  checkOneSpacePerDomain,
  createWorkspaceFromDefinitionIdempotent,
  workspaceInstanceKey,
} from "./workspace-creation-service.js";
import { ONE_SPACE_PER_DOMAIN_RULE } from "./one-space-per-domain.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const SLUG = "content-studio";
const definition = { workspaceName: "Content Studio" } as never;
const AGENT = "agent-1";

function install(userId: string, instanceName?: string) {
  return createWorkspaceFromDefinitionIdempotent({
    definition,
    userId,
    packageSlug: SLUG,
    proposalId: workspaceInstanceKey(SLUG, instanceName),
    workspaceName: instanceName ?? "Content Studio",
  });
}

function verdict(
  userId: string,
  opts: { agent?: boolean; instanceName?: string; freehandName?: string }
) {
  return checkOneSpacePerDomain({
    userId,
    agentUserId: opts.agent ? AGENT : undefined,
    ...(opts.freehandName !== undefined
      ? { workspaceName: opts.freehandName }
      : {
          packageSlug: SLUG,
          idempotencyKey: workspaceInstanceKey(SLUG, opts.instanceName),
          workspaceName: opts.instanceName,
        }),
  });
}

beforeAll(async () => {
  for (const t of [schema.workspaces, schema.workspaceMembers]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
});

describe("one space per domain — template installs (PGlite)", () => {
  it("first install (no live space) is unaffected — create, no note, even for an agent", async () => {
    const U = randomUUID();
    expect(await verdict(U, { agent: true })).toEqual({ action: "create" });
    expect(
      await verdict(U, { agent: true, instanceName: "Architech" })
    ).toEqual({ action: "create" });
  });

  it("an AGENT's second Content space (named instance) is REFUSED with a typed exists + the guidance", async () => {
    const U = randomUUID();
    const first = await install(U);
    const v = await verdict(U, { agent: true, instanceName: "Architech" });
    expect(v.action).toBe("refuse");
    if (v.action !== "refuse") return;
    expect(v.reply).toMatchObject({
      status: "exists",
      workspaceId: first.workspaceId,
      workspaceName: "Content Studio",
      matchedBy: "template",
    });
    expect(v.reply.guidance).toContain("`project_use_workspace`");
    expect(v.reply.guidance).toContain("`file_into_project`");
    expect(v.reply.guidance).toContain(ONE_SPACE_PER_DOMAIN_RULE);
  });

  it("a HUMAN's named `--as` instance is ALLOWED, with the same guidance as a note", async () => {
    const U = randomUUID();
    const first = await install(U);
    const v = await verdict(U, { instanceName: "Architech" });
    expect(v).toMatchObject({
      action: "create",
      note: { existingWorkspaceId: first.workspaceId },
    });
    if (v.action === "create")
      expect(v.note?.guidance).toContain(ONE_SPACE_PER_DOMAIN_RULE);
  });

  it("re-installs REUSE, so they are never refused — singleton and an existing named instance", async () => {
    const U = randomUUID();
    await install(U);
    await install(U, "Architech"); // a human made it earlier
    expect(await verdict(U, { agent: true })).toEqual({ action: "create" });
    expect(
      await verdict(U, { agent: true, instanceName: "architech" })
    ).toEqual({ action: "create" });
  });

  it("an agent's UNNAMED install when only a named instance lives → refused (it would mint a second space)", async () => {
    const U = randomUUID();
    const named = await install(U, "Architech");
    const v = await verdict(U, { agent: true });
    expect(v).toMatchObject({
      action: "refuse",
      reply: { workspaceId: named.workspaceId },
    });
    // …and the real create agrees it would have minted a new space.
    const r = await install(U);
    expect(r.created).toBe(true);
  });

  it("a legacy unkeyed singleton is ADOPTED by the create, so an agent re-install is not refused", async () => {
    const U = randomUUID();
    const legacy = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, package_slug, settings) values ($1,'Content Studio',$2,$3,'{}'::jsonb)`,
      [legacy, U, SLUG]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), legacy, U]
    );
    expect(await verdict(U, { agent: true })).toEqual({ action: "create" });
    // …but a named instance beside it is a second space.
    expect(
      (await verdict(U, { agent: true, instanceName: "Architech" })).action
    ).toBe("refuse");
  });

  it("an ARCHIVED space does not hold the domain", async () => {
    const U = randomUUID();
    const first = await install(U);
    await q(`update workspaces set archived_at = now() where id = $1`, [
      first.workspaceId,
    ]);
    expect(
      await verdict(U, { agent: true, instanceName: "Architech" })
    ).toEqual({ action: "create" });
  });

  it("another user's space does not hold MY domain", async () => {
    await install(randomUUID());
    expect(
      await verdict(randomUUID(), { agent: true, instanceName: "Architech" })
    ).toEqual({ action: "create" });
  });
});

describe("one space per domain — freehand create_workspace by name (PGlite)", () => {
  it("an agent naming a space after a live domain space (any case/spacing) is refused, matchedBy name", async () => {
    const U = randomUUID();
    const first = await install(U);
    const v = await verdict(U, {
      agent: true,
      freehandName: "  content STUDIO ",
    });
    expect(v).toMatchObject({
      action: "refuse",
      reply: {
        status: "exists",
        workspaceId: first.workspaceId,
        matchedBy: "name",
      },
    });
  });

  it("a human gets the note, and an unrelated name is untouched", async () => {
    const U = randomUUID();
    await install(U);
    expect((await verdict(U, { freehandName: "Content Studio" })).action).toBe(
      "create"
    );
    expect(
      (await verdict(U, { freehandName: "Content Studio" })) as {
        note?: unknown;
      }
    ).toHaveProperty("note");
    expect(await verdict(U, { agent: true, freehandName: "Podcasts" })).toEqual(
      {
        action: "create",
      }
    );
  });

  it("a name equal to a FREEHAND (non-template) space is not a domain duplicate", async () => {
    const U = randomUUID();
    const id = randomUUID();
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'Scratch',$2,'{}'::jsonb)`,
      [id, U]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), id, U]
    );
    expect(await verdict(U, { agent: true, freehandName: "Scratch" })).toEqual({
      action: "create",
    });
  });
});
