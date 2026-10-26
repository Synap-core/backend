/**
 * A SYSTEM role a template declares (e.g. `contact`) is visible in that
 * template's space (founder decision 2, 2026-10-26) — through the REAL
 * `reconcileWorkspaceFromDefinition` (the update door `synap templates update`
 * and every boot reconcile run) and the REAL reach builders, on PGlite.
 *
 * Pinned:
 *  - before the apply, nobody reading through the space reaches the person
 *    who wears the system role (no implicit all-spaces grant: the gap);
 *  - the apply writes the `profile_workspace_access` grant, and then a
 *    space-pinned key (`podSharedEntityIdsForSpaces`, what grant-read.ts
 *    `spaceReach` composes) and a MEMBER of the space
 *    (`podSharedEntityIdsFor`) both reach that pod-wide person;
 *  - a system role the template does NOT declare stays invisible, and the
 *    grant lands in the applying space only;
 *  - a re-apply is idempotent (one grant row);
 *  - a dry-run writes nothing.
 *
 * Harness: same derived-schema PGlite as `reconcile-presentation.pglite.test.ts`.
 * Cannot see: production Postgres, the HTTP door (`GET /entities`) above the
 * builders — `entities.app-space-reach.pglite.test.ts` pins that the door
 * composes them.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("../schema/index.js");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("../client-pg.js", async () => {
  const db = await h.init();
  return { db, sql: undefined, getDb: async () => db };
});

import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import { reconcileWorkspaceFromDefinition } from "./reconcile-workspace-from-definition.js";
import {
  podSharedEntityIdsFor,
  podSharedEntityIdsForSpaces,
} from "./facet-visibility.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

type ColumnLike = {
  name: string;
  primary: boolean;
  hasDefault: boolean;
  default: unknown;
  getSQLType(): string;
};

function defaultFor(c: ColumnLike, type: string): string {
  if (!c.hasDefault) return "";
  const d = c.default;
  if (type.endsWith("[]")) return " default '{}'";
  if (typeof d === "number" || typeof d === "boolean") return ` default ${d}`;
  if (typeof d === "string") return ` default '${d.replace(/'/g, "''")}'`;
  if (d && typeof d === "object" && !("queryChunks" in d)) {
    return ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
  }
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = (cfg.columns as unknown as ColumnLike[]).map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = async <T = any>(sql: string, params?: unknown[]) =>
  (await h.client!.query<T>(sql, params)).rows;

const OWNER = "owner-declared-role";
const TEAMMATE = "teammate-declared-role";
const CRM = randomUUID();
const BRAND = randomUUID();
const PERSON_KIND = randomUUID();
const CONTACT_ROLE = randomUUID(); // system role, declared by the template
const VIP_ROLE = randomUUID(); // system role, NOT declared
const ALICE = randomUUID(); // pod-wide person wearing `contact`
const BOB = randomUUID(); // pod-wide person wearing `vip`

/** The declaration as the catalog writes it (marketing.yaml `contact`). */
const CONTACT_DECL = {
  slug: "contact",
  displayName: "Contact",
  profileKind: "role",
  applicableKinds: ["person"],
};

beforeAll(async () => {
  await h.init();
  for (const value of Object.values(schema)) {
    if (value instanceof PgTable) {
      try {
        await h.client!.exec(ddlFor(value));
      } catch {
        // A table PGlite cannot express is not one this door reads.
      }
    }
  }
  await h.client!.exec(`
    create unique index if not exists profile_properties_pk
      on profile_properties (profile_id, property_def_id);
    create unique index if not exists profile_workspace_access_pk
      on profile_workspace_access (profile_id, workspace_id);
  `);
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from entity_facets; delete from entities; delete from profile_properties;
     delete from property_defs; delete from profile_workspace_access; delete from profiles;
     delete from workspace_members; delete from pod_members; delete from workspaces;`
  );
  for (const [id, name] of [
    [CRM, "CRM"],
    [BRAND, "Brand"],
  ]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
       values ($1, $2, $3, '{}'::jsonb, now(), now())`,
      [id, name, OWNER]
    );
  }
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), OWNER, randomUUID(), TEAMMATE]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), CRM, TEAMMATE]
  );
  const seedProfile = (id: string, slug: string, kind: string) =>
    q(
      `insert into profiles (id, slug, display_name, scope, profile_kind, applicable_kinds,
         entity_scope, origin, is_active, ui_hints, created_at, updated_at)
       values ($1, $2, $2, 'system', $3, $4, 'pod', 'core', true, '{}'::jsonb, now(), now())`,
      [id, slug, kind, kind === "role" ? ["person"] : []]
    );
  await seedProfile(PERSON_KIND, "person", "kind");
  await seedProfile(CONTACT_ROLE, "contact", "role");
  await seedProfile(VIP_ROLE, "vip", "role");
  for (const [entity, role] of [
    [ALICE, CONTACT_ROLE],
    [BOB, VIP_ROLE],
  ]) {
    await q(
      `insert into entities (id, profile_id, user_id, workspace_id, title, created_at, updated_at)
       values ($1, $2, $3, null, 'p', now(), now())`,
      [entity, PERSON_KIND, OWNER]
    );
    // A system role's facet is stored pod-wide (storedFacetWorkspaceId → NULL).
    await q(
      `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties, metadata)
       values ($1, $2, $3, $4, null, '{}'::jsonb, '{}'::jsonb)`,
      [randomUUID(), entity, role, OWNER]
    );
  }
});

const apply = (workspaceId: string, dryRun = false) =>
  reconcileWorkspaceFromDefinition({
    workspaceId,
    userId: OWNER,
    definition: { profiles: [CONTACT_DECL] } as never,
    dryRun,
  });

const reach = async (query: PromiseLike<{ id: string }[]>) =>
  (await query).map((r) => r.id).sort();

const grantsOf = (profileId: string) =>
  q<{ workspace_id: string }>(
    `select workspace_id from profile_workspace_access where profile_id = $1`,
    [profileId]
  );

describe("a template-declared SYSTEM role is visible in the template's space", () => {
  it("before the apply the space reaches nobody wearing it (the gap)", async () => {
    expect(await reach(podSharedEntityIdsForSpaces([CRM]))).toEqual([]);
    expect(await reach(podSharedEntityIdsFor(TEAMMATE))).toEqual([]);
  });

  it("the apply grants the role to the space; a space key and a member then reach its wearer", async () => {
    const report = await apply(CRM);
    expect(report.profiles.conflicts).toEqual([]);
    expect(report.profiles.reused).toContain("contact");
    expect(report.profiles.added).not.toContain("contact"); // reused, not minted

    expect(await grantsOf(CONTACT_ROLE)).toEqual([{ workspace_id: CRM }]);
    expect(await reach(podSharedEntityIdsForSpaces([CRM]))).toEqual([ALICE]);
    expect(await reach(podSharedEntityIdsFor(TEAMMATE))).toEqual([ALICE]);
  });

  it("an undeclared system role stays invisible, and other spaces gain nothing", async () => {
    await apply(CRM);
    expect(await grantsOf(VIP_ROLE)).toEqual([]);
    expect(await reach(podSharedEntityIdsForSpaces([CRM]))).not.toContain(BOB);
    expect(await reach(podSharedEntityIdsForSpaces([BRAND]))).toEqual([]);
  });

  it("a re-apply is idempotent: one grant row, same reach", async () => {
    await apply(CRM);
    await apply(CRM);
    expect(await grantsOf(CONTACT_ROLE)).toEqual([{ workspace_id: CRM }]);
    expect(await reach(podSharedEntityIdsForSpaces([CRM]))).toEqual([ALICE]);
  });

  it("a dry-run writes no grant", async () => {
    await apply(CRM, true);
    expect(await grantsOf(CONTACT_ROLE)).toEqual([]);
  });
});
