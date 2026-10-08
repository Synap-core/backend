/**
 * The run door's subject-KIND check (`assertRunSubjectMatchesPlaybook`) on a
 * real Postgres (PGlite): kind, profile ancestor and live facet each satisfy
 * it; a different kind is refused with the typed error; nothing-to-judge
 * cases pass through.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getDb: async () => holder.db };
});

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  entities,
  profiles,
  entityFacets,
  profileWorkspaceAccess,
  workspaceMembers,
  workspaces,
  podMembers,
} from "@synap/database";
import {
  assertRunSubjectMatchesPlaybook,
  SubjectKindMismatchError,
} from "./assert-subject-kind.js";

const USER = "user-1";
const WS = randomUUID();
const P_EVENT = randomUUID();
const P_WEBINAR = randomUUID();
const P_PERSON = randomUUID();
const P_LEAD = randomUUID();
const POST = randomUUID();
const WEBINAR = randomUUID();
const PERSON_LEAD = randomUUID();
const PERSON = randomUUID();

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

beforeAll(async () => {
  const client = new PGlite();
  for (const t of [
    entities,
    profiles,
    entityFacets,
    profileWorkspaceAccess,
    workspaceMembers,
    workspaces,
    podMembers,
  ]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  const prof = (id: string, slug: string, parent: string | null) =>
    client.query(
      `insert into profiles (id, slug, display_name, parent_profile_id, scope, is_active) values ($1,$2,$2,$3,'system',true)`,
      [id, slug, parent]
    );
  await prof(P_EVENT, "event", null);
  await prof(P_WEBINAR, "webinar", P_EVENT);
  await prof(P_PERSON, "person", null);
  await prof(P_LEAD, "lead", null);
  const ent = (id: string, type: string, profileId: string | null) =>
    client.query(
      `insert into entities (id, user_id, workspace_id, type, profile_id, title) values ($1,$2,$3,$4,$5,'x')`,
      [id, USER, WS, type, profileId]
    );
  await ent(POST, "post", null);
  await ent(WEBINAR, "webinar", P_WEBINAR);
  await ent(PERSON_LEAD, "person", P_PERSON);
  await ent(PERSON, "person", P_PERSON);
  await client.query(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id) values ($1,$2,$3,$4,$5)`,
    [randomUUID(), PERSON_LEAD, P_LEAD, USER, WS]
  );
  holder.db = drizzle(client);
});

const check = (subjectId: string | null, profileSlug?: string) =>
  assertRunSubjectMatchesPlaybook({
    subjectId,
    subjectProfile: profileSlug ? { profileSlug } : null,
    userId: USER,
    workspaceId: WS,
  });

describe("assertRunSubjectMatchesPlaybook", () => {
  it("passes a subject of the playbook's kind", async () => {
    await expect(check(POST, "post")).resolves.toBeUndefined();
  });

  it("passes a subject whose kind EXTENDS the playbook's (webinar → event)", async () => {
    await expect(check(WEBINAR, "event")).resolves.toBeUndefined();
  });

  it("passes a subject wearing the kind as a live facet (person as lead)", async () => {
    await expect(check(PERSON_LEAD, "lead")).resolves.toBeUndefined();
  });

  it("REFUSES a subject of another kind, typed and readable", async () => {
    const err = await check(PERSON, "post").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SubjectKindMismatchError);
    const e = err as SubjectKindMismatchError;
    expect(e.code).toBe("BAD_REQUEST");
    expect(e.reasonCode).toBe("SUBJECT_KIND_MISMATCH");
    expect(e.expected).toBe("post");
    expect(e.actual).toEqual(["person"]);
    // In the person's words: the vocabulary nouns, no quoted slugs.
    expect(e.message).toBe(
      "This template runs on a post, but the subject you chose is a person. Pick a post, or run a template made for this kind."
    );
    // A plain person is NOT a lead (the facet is per entity).
    await expect(check(PERSON, "lead")).rejects.toBeInstanceOf(
      SubjectKindMismatchError
    );
  });

  it("does not judge: no subject, no kind, or an id that is not an entity", async () => {
    await expect(check(null, "post")).resolves.toBeUndefined();
    await expect(check(PERSON)).resolves.toBeUndefined();
    await expect(check(randomUUID(), "post")).resolves.toBeUndefined();
  });
});
