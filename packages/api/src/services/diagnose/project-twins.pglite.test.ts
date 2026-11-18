/**
 * `readProjectTwins` on real SQL (ticket 8e2c7018): the live entities that
 * answer recall in a project's place. Migration 0151 copied each project
 * entity into the `projects` table WITH THE SAME ID and left the entity row
 * behind; a reserved `project` profile can be re-activated by an old
 * template. Both shapes are reported, each with its reason; a soft-deleted
 * entity, an ordinary one and another user's are not.
 *
 * Real: the query, on PGlite tables generated from the Drizzle schema.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

const schema = await import("@synap/database/schema");
const { readProjectTwins } = await import("./schema-contract.js");

const ME = "user-me";
const OTHER = "user-other";
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

const q = (text: string, params?: unknown[]) => h.client!.query(text, params);

const PROJECT_PROFILE = randomUUID();
const NOTE_PROFILE = randomUUID();

async function entity(opts: {
  id?: string;
  user?: string;
  profileId: string;
  title: string;
  deleted?: boolean;
}): Promise<string> {
  const id = opts.id ?? randomUUID();
  await q(
    `insert into entities (id, user_id, profile_id, type, title, deleted_at) values ($1, $2, $3, 'x', $4, $5)`,
    [
      id,
      opts.user ?? ME,
      opts.profileId,
      opts.title,
      opts.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

beforeAll(async () => {
  for (const t of [schema.entities, schema.projects, schema.profiles]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into profiles (id, slug, display_name) values ($1, 'project', 'Project'), ($2, 'note', 'Note')`,
    [PROJECT_PROFILE, NOTE_PROFILE]
  );
}, 60_000);

describe("readProjectTwins", () => {
  it("reports an entity sharing a project's id and one of the reserved kind, with each reason", async () => {
    const projectId = randomUUID();
    await q(
      `insert into projects (id, user_id, name, status) values ($1, $2, 'Synap', 'active')`,
      [projectId, ME]
    );
    // The July twin: the project's id, the reserved kind.
    await entity({ id: projectId, profileId: PROJECT_PROFILE, title: "Synap" });
    // A `project` entity written after the reservation slipped (a template).
    const kindOnly = await entity({
      profileId: PROJECT_PROFILE,
      title: "Side project",
    });
    // Not twins: an ordinary note, a soft-deleted twin, another user's.
    await entity({ profileId: NOTE_PROFILE, title: "A note" });
    await entity({
      profileId: PROJECT_PROFILE,
      title: "Retired twin",
      deleted: true,
    });
    await entity({
      user: OTHER,
      profileId: PROJECT_PROFILE,
      title: "Theirs",
    });

    const twins = await readProjectTwins(ME);
    const byId = new Map(twins.map((t) => [t.entityId, t]));
    expect(twins).toHaveLength(2);
    expect(byId.get(projectId)?.reasons).toEqual([
      "id_is_a_project",
      "reserved_kind",
    ]);
    expect(byId.get(kindOnly)?.reasons).toEqual(["reserved_kind"]);
  });
});
