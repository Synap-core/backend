/**
 * Shared PGlite fixture for the collection-door (site) tests — NOT a test file.
 *
 * Every site test builds the same world: the Drizzle schema as bare tables (no
 * FKs; the shape the other sharing PGlite tests use), then the REAL 0276 + 0336
 * migrations (constraints, partial unique indexes, the revoke-is-permanent
 * trigger), then a handful of rows. The `vi.mock("@synap/database")` that
 * swaps in the PGlite client must stay in each test file (vitest hoists it);
 * this module only takes that client.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

export interface PgClient {
  exec: (sql: string) => Promise<unknown>;
  query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
}

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
      !c.primary && c.hasDefault
        ? type.startsWith("timestamp")
          ? " default now()"
          : type === "uuid"
            ? " default gen_random_uuid()"
            : ""
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

/** Every table of the schema, then the REAL 0276 + 0336 migrations. */
export async function createSiteSchema(client: PgClient): Promise<void> {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of [
    "0276_exposure_substrate.sql",
    "0336_site_collections.sql",
  ]) {
    await client.exec(
      readFileSync(
        path.resolve(here, `../../../../../database/migrations/${m}`),
        "utf8"
      )
    );
  }
}

const KIND = {
  guest: { read: "direct" as const, create: "proposal" as const },
  link: { read: "direct" as const, create: "proposal" as const },
};
const cell = (read: "direct" | "denied", fields: string[]) => ({
  read,
  create: "denied" as const,
  fields,
});

/** A complete exposure policy: entities and projects public as asked. */
export function sitePolicy(
  opts: {
    entityFields?: string[];
    projectFields?: string[];
    entityRead?: "direct" | "denied";
    projectRead?: "direct" | "denied";
  } = {}
) {
  return {
    version: 1 as const,
    kinds: {
      entity: {
        ...KIND,
        public: cell(
          opts.entityRead ?? "direct",
          opts.entityFields ?? ["title", "year", "venue"]
        ),
      },
      document: { ...KIND, public: cell("denied", []) },
      view: { ...KIND, public: cell("denied", []) },
      project: {
        ...KIND,
        public: cell(
          opts.projectRead ?? "direct",
          opts.projectFields ?? ["title"]
        ),
      },
    },
  };
}

/** A pod world builder over one PGlite client. */
export function siteWorld(client: PgClient) {
  const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
    client.query<T>(sql, params);

  return {
    q,
    async user(id: string, type: "human" | "agent" = "human") {
      await q(
        `insert into users (id, email, user_type, agent_metadata) values ($1,$2,$3,$4::jsonb)`,
        [id, `${id}@example.test`, type, type === "agent" ? "{}" : null]
      );
    },
    async podOwner(id: string) {
      await q(
        `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
        [randomUUID(), id]
      );
    },
    async workspace(
      id: string,
      ownerId: string,
      members: Array<[string, string]> = []
    ) {
      await q(
        `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
        [id, ownerId]
      );
      for (const [userId, role] of [[ownerId, "owner"], ...members] as Array<
        [string, string]
      >) {
        await q(
          `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,$4)`,
          [randomUUID(), id, userId, role]
        );
      }
    },
    async project(
      id: string,
      ownerId: string,
      workspaceId: string | null,
      name = "Lab"
    ) {
      await q(
        `insert into projects (id, user_id, workspace_id, name, description, status) values ($1,$2,$3,$4,'Internal plans','active')`,
        [id, ownerId, workspaceId, name]
      );
    },
    /** A profile; returns its id. */
    async profile(
      slug: string,
      kind: "kind" | "role" = "kind",
      scope: "workspace" | "pod" = "workspace"
    ): Promise<string> {
      const id = randomUUID();
      await q(
        `insert into profiles (id, slug, display_name, profile_kind, entity_scope, origin) values ($1,$2,$2,$3,$4,'authored')`,
        [id, slug, kind, scope]
      );
      return id;
    },
    /**
     * A record (entity) with a profile; `body` gives it a document with one
     * checkpoint. Returns its id and its document id.
     */
    async record(opts: {
      ownerId: string;
      workspaceId: string | null;
      profileId: string | null;
      title: string;
      properties?: Record<string, unknown>;
      body?: string;
      id?: string;
    }): Promise<{ id: string; documentId: string | null }> {
      const id = opts.id ?? randomUUID();
      let documentId: string | null = null;
      if (opts.body !== undefined) {
        documentId = randomUUID();
        await q(
          `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',1,1)`,
          [documentId, opts.ownerId, opts.workspaceId]
        );
        await this.checkpoint(documentId, 1, opts.body, opts.ownerId);
      }
      await q(
        `insert into entities (id, user_id, workspace_id, profile_id, title, document_id, properties) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [
          id,
          opts.ownerId,
          opts.workspaceId,
          opts.profileId,
          opts.title,
          documentId,
          JSON.stringify(opts.properties ?? {}),
        ]
      );
      return { id, documentId };
    },
    /** A new checkpoint of a document (a later version = what a republish pins). */
    async checkpoint(
      documentId: string,
      version: number,
      content: string,
      authorId: string
    ): Promise<string> {
      const id = randomUUID();
      await q(
        `insert into document_versions (id, document_id, version, content, author, author_id, created_at) values ($1,$2,$3,$4,'human',$5, now() + ($3::int * interval '1 second'))`,
        [id, documentId, version, content, authorId]
      );
      return id;
    },
    /** File a record into a project (the `belongs_to_project` edge). */
    async fileInto(entityId: string, projectId: string, userId: string) {
      await q(
        `insert into relations (id, user_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,'belongs_to_project')`,
        [randomUUID(), userId, entityId, projectId]
      );
    },
    async unfile(entityId: string, projectId: string) {
      await q(
        `delete from relations where type = 'belongs_to_project' and source_entity_id = $1 and target_entity_id = $2`,
        [entityId, projectId]
      );
    },
    /** The member rows of a site (every state). */
    async members(siteId: string) {
      const { rows } = await q<Record<string, any>>(
        `select * from resource_shares where site_share_id = $1 order by created_at`,
        [siteId]
      );
      return rows;
    },
  };
}

/** The `[code, message]` a rejected promise carries, or null when it resolved. */
export async function errOf(
  p: Promise<unknown>
): Promise<{ code?: string; message?: string } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

/** Any UUID-shaped token. */
export const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
