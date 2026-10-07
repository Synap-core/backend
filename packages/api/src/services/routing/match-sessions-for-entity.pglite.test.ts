/**
 * `loadSessionCandidates` on PGlite — the REAL SQL. Rows where naive rules
 * disagree: another user's open session about the same entity (owner floor),
 * a CLOSED session about it, an open session that ALREADY has it as an input,
 * a session whose playbook is built for one of the entity's ROLES (facet), and
 * one whose playbook is built for an unrelated kind.
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions, playbooks, links } from "@synap/database";
import { loadSessionCandidates } from "./match-sessions-for-entity.js";

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
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const ME = "user-me";
const ENTITY = randomUUID();
const PB_TRACK = randomUUID();
const PB_ROLE = randomUUID();
const PB_OTHER = randomUUID();
const S: Record<string, string> = {};

async function session(
  key: string,
  opts: { user?: string; status?: string; subject?: string; playbook?: string }
) {
  S[key] = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, subject_entity_id, playbook_id, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, '{}'::jsonb, now(), now(), now())`,
    [
      S[key],
      opts.user ?? ME,
      `goal ${key}`,
      opts.status ?? "active",
      opts.subject ?? null,
      opts.playbook ?? null,
    ]
  );
}

beforeAll(async () => {
  for (const t of [focusSessions, playbooks, links]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  for (const [id, slug] of [
    [PB_TRACK, "track"],
    [PB_ROLE, "favourite"],
    [PB_OTHER, "invoice"],
  ] as const) {
    await q(
      `insert into playbooks (id, name, subject_profile) values ($1, $2, $3::jsonb)`,
      [id, `pb ${slug}`, JSON.stringify({ profileSlug: slug })]
    );
  }
  await session("about", { subject: ENTITY });
  await session("kind", { playbook: PB_TRACK, status: "paused" });
  await session("role", { playbook: PB_ROLE });
  await session("other", { playbook: PB_OTHER });
  await session("foreign", { subject: ENTITY, user: "someone-else" });
  await session("closed", { subject: ENTITY, status: "closed" });
  await session("linked", { playbook: PB_TRACK });
  await q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata, created_at)
     values ($1, 'session', $2, 'entity', $3, 'targets', '{}'::jsonb, now())`,
    [randomUUID(), S.linked, ENTITY]
  );
});

describe("loadSessionCandidates", () => {
  it("returns the caller's OPEN sessions about the entity or built for its kind/roles, minus those that already have it", async () => {
    const got = await loadSessionCandidates({
      userId: ME,
      entityId: ENTITY,
      profileSlug: "track",
      facetSlugs: ["favourite"],
    });
    const ids = new Set(got.map((c) => c.id));
    expect(ids).toEqual(new Set([S.about, S.kind, S.role]));
    const about = got.find((c) => c.id === S.about)!;
    expect(about).toMatchObject({
      kind: "session",
      subjectEntityId: ENTITY,
      subjectProfileSlug: null,
    });
    expect(got.find((c) => c.id === S.kind)!.subjectProfileSlug).toBe("track");
    expect(got.find((c) => c.id === S.role)!.subjectProfileSlug).toBe(
      "favourite"
    );
  });
});
