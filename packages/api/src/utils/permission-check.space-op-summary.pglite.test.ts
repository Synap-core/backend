/**
 * P1 — governed SPACE operations read as what they do, naming spaces, never ids.
 *
 * Two halves of ONE seam, both real code:
 *   - `resolveSpaceOpNames` on PGlite: the destination / previous space NAME is
 *     resolved server-side and FLOORED to the proposer's visibility
 *     (`userVisibleWhere`) — a proposer who cannot see a space gets no name, so
 *     a title it reads back can never be a name oracle.
 *   - `buildProposalSummary` fed exactly what `createProposal` feeds it (the
 *     door's own payload + `targetName` + the resolved names).
 *
 * The door payloads below are copied from the gate calls:
 *   workspaces.archive  → `workspaces` / archive|restore  `{ id, name }`
 *   workspaces.update   → `workspaces` / update           `{ id, name }`
 *   profiles.grantAccess→ `profile` / grant_access `{ profileId, targetWorkspaceId, slug, displayName }`
 *   entities.moveToWorkspace → `entity` / update   `{ id, toWorkspaceId }`
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
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const d = drizzle(client, { schema });
  return { ...actual, db: d, getDb: async () => d };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  buildProposalSummary,
  resolveSpaceOpNames,
} from "./permission-check.js";

const OWNER = randomUUID();
const OUTSIDER = randomUUID();
const WS_RADAR = randomUUID();
const WS_OPS = randomUUID();
const WS_CRM = randomUUID();
const PROFILE = randomUUID();
const ENTITY = randomUUID();
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

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

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  // Three PRIVATE spaces, all owned by OWNER. OUTSIDER is a member of Radar
  // only, so it can see Radar and nothing else.
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings) values
      ($1,'Radar',$4,'{}'::jsonb),($2,'Operations',$4,'{}'::jsonb),($3,'CRM',$4,'{}'::jsonb)`,
    [WS_RADAR, WS_OPS, WS_CRM, OWNER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), WS_RADAR, OUTSIDER]
  );
});

/** What `createProposal` feeds the summary: payload + targetName + names. */
async function titleFor(
  subjectType: string,
  action: string,
  targetId: string,
  data: Record<string, unknown>,
  userId: string,
  targetName?: string
): Promise<string> {
  const names = await resolveSpaceOpNames(
    subjectType,
    action,
    targetId,
    data,
    userId
  );
  return buildProposalSummary(subjectType, action, {
    ...data,
    ...(targetName ? { targetName } : {}),
    ...names,
  });
}

describe("space-op titles — the real payloads, names not ids", () => {
  it("archive / restore name the space (and carry no restore flag)", async () => {
    const data = { id: WS_RADAR, name: "Radar" };
    expect(
      await titleFor("workspace", "archive", WS_RADAR, data, OWNER, "Radar")
    ).toBe('Archive Space "Radar"');
    expect(
      await titleFor("workspace", "restore", WS_RADAR, data, OWNER, "Radar")
    ).toBe('Restore Space "Radar"');
  });

  it("share names the kind AND the destination space", async () => {
    const title = await titleFor(
      "profile",
      "grant_access",
      PROFILE,
      {
        profileId: PROFILE,
        targetWorkspaceId: WS_OPS,
        slug: "client",
        displayName: "Client",
      },
      OWNER,
      "Client"
    );
    expect(title).toBe('Share Kind "Client" with Space "Operations"');
    expect(title).not.toMatch(UUID);
  });

  it("move names the object and the destination space", async () => {
    const title = await titleFor(
      "entity",
      "update",
      ENTITY,
      { id: ENTITY, toWorkspaceId: WS_CRM },
      OWNER,
      "Acme deal"
    );
    expect(title).toBe('Move "Acme deal" to Space "CRM"');
    expect(title).not.toMatch(UUID);
  });

  it("rename says rename, from the current name to the new one", async () => {
    expect(
      await titleFor(
        "workspace",
        "update",
        WS_RADAR,
        { id: WS_RADAR, name: "Radar 2" },
        OWNER,
        "Radar 2"
      )
    ).toBe('Rename Space "Radar" to "Radar 2"');
  });

  it("a settings update is NOT a rename — it keeps the generic title", async () => {
    expect(
      await titleFor(
        "workspace",
        "update",
        WS_RADAR,
        { id: WS_RADAR, name: "Radar", settings: { a: 1 } },
        OWNER,
        "Radar"
      )
    ).toBe('Update Space "Radar"');
  });
});

describe("the name is FLOORED to the proposer's visibility", () => {
  it("a proposer who cannot see the destination gets 'another space', never its name or id", async () => {
    const share = await titleFor(
      "profile",
      "grant_access",
      PROFILE,
      {
        profileId: PROFILE,
        targetWorkspaceId: WS_OPS,
        slug: "client",
        displayName: "Client",
      },
      OUTSIDER,
      "Client"
    );
    expect(share).toBe('Share Kind "Client" with another space');
    expect(share).not.toContain("Operations");
    expect(share).not.toMatch(UUID);

    const move = await titleFor(
      "entity",
      "update",
      ENTITY,
      { id: ENTITY, toWorkspaceId: WS_CRM },
      OUTSIDER,
      "Acme deal"
    );
    expect(move).toBe('Move "Acme deal" to another space');
  });

  it("…while a space it CAN see is named (non-vacuity of the floor)", async () => {
    expect(
      await resolveSpaceOpNames(
        "entity",
        "update",
        ENTITY,
        { id: ENTITY, toWorkspaceId: WS_RADAR },
        OUTSIDER
      )
    ).toEqual({ toWorkspaceName: "Radar" });
  });

  it("queries nothing for a proposal that is not a space op", async () => {
    expect(
      await resolveSpaceOpNames(
        "entity",
        "update",
        ENTITY,
        { id: ENTITY, title: "x" },
        OWNER
      )
    ).toEqual({});
  });
});
