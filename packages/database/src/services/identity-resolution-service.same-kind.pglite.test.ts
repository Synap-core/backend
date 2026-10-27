/**
 * A strong identity match never crosses kinds — on a real Postgres (PGlite):
 * the REAL extractor → the REAL write door (`registerIdentitySignals`) → the
 * REAL resolver (`resolveIdentity`).
 *
 * The bug (founder's pod, 2026-10-27): a capture of a NEW person "Tristan
 * Monthiller" carrying `website: https://www.monthimmo.fr` resolved STRONG onto
 * the company Month'Immo, which owns that website signal — the graph linked the
 * person op onto the company, so approving would have merged a person into a
 * company. Pinned here:
 *  - a different-kind owner is NOT a strong match; it is an advisory
 *    `crossKindCandidates` entry (only when `userScope` admits it), not a
 *    name `candidate`;
 *  - the same kind, the bookmark family, a role's applicable kinds and
 *    `alsoKinds` still resolve strong;
 *  - with no `kindSlug`, any owner resolves strong, as before.
 *
 * ENGINE: PGlite, tables built from their drizzle definitions (enums as text,
 * constraints dropped; the (type, value) unique key added back — the write
 * door's onConflictDoNothing depends on it). Same setup as the url test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL, eq } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "../schema/index.js";
import {
  entities,
  entityIdentitySignals,
  entityPropertyIndex,
  profiles,
  propertyDefs,
} from "../schema/index.js";
import {
  extractIdentitySignals,
  registerIdentitySignals,
  resolveIdentity,
} from "./identity-resolution-service.js";

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

const USER = "same-kind-identity-user";
let pg: PGlite;

let db: any;

beforeAll(async () => {
  pg = new PGlite();
  // The weak (name) path also reads property_defs + entity_property_index.
  for (const t of [
    entities,
    entityIdentitySignals,
    profiles,
    propertyDefs,
    entityPropertyIndex,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  await pg.exec(
    `CREATE UNIQUE INDEX entity_identity_signals_type_value_idx
       ON entity_identity_signals (signal_type, signal_value);`
  );
  db = drizzle(pg, { schema });
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await pg.exec(
    `delete from entity_identity_signals; delete from entities; delete from profiles;`
  );
});

/** One capture: insert the row, then the write door registers its signals. */
async function captureAs(
  kind: string,
  title: string,
  properties: Record<string, unknown>
): Promise<string> {
  const id = randomUUID();
  await pg.query(
    `insert into entities (id, user_id, type, title, properties)
       values ($1, $2, $3, $4, $5::jsonb)`,
    [id, USER, kind, title, JSON.stringify(properties)]
  );
  await registerIdentitySignals(
    db,
    id,
    extractIdentitySignals(properties, { kind }),
    "test"
  );
  return id;
}

async function defineRole(slug: string, applicableKinds: string[] | null) {
  await pg.query(
    `insert into profiles (id, slug, display_name, profile_kind, applicable_kinds)
       values ($1, $2, $3, 'role', $4)`,
    [randomUUID(), slug, slug, applicableKinds]
  );
}

/** The caller's visibility floor (the weak path and cross-kind naming need one). */
const ownScope = () => eq(entities.userId, USER);

describe("resolveIdentity — a strong match never crosses kinds", () => {
  it("a NEW person carrying their company's website is not the company: no strong match, the company is a cross-kind candidate", async () => {
    const company = await captureAs("company", "Month'Immo", {
      website: "https://monthimmo.fr",
    });
    const properties = { website: "https://www.monthimmo.fr" };
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "person",
      name: "Tristan Monthiller",
      signals: extractIdentitySignals(properties, { kind: "person" }),
      userScope: ownScope(),
    });
    expect(res.match).not.toBe("strong");
    expect(res.entity).toBeUndefined();
    expect(res.crossKindCandidates.map((c) => c.id)).toEqual([company]);
    // Not a NAME candidate: callers tell "same title" from "same signal".
    expect(res.candidates).toEqual([]);
  });

  it("names the other-kind owner only when the caller's scope admits it", async () => {
    await captureAs("company", "Month'Immo", {
      website: "https://monthimmo.fr",
    });
    const signals = extractIdentitySignals(
      { website: "https://monthimmo.fr" },
      { kind: "person" }
    );
    const unscoped = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "person",
      signals,
    });
    expect(unscoped.match).toBeNull();
    expect(unscoped.crossKindCandidates).toEqual([]);

    const otherUser = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "person",
      signals,
      userScope: eq(entities.userId, "someone-else"),
    });
    expect(otherUser.crossKindCandidates).toEqual([]);
  });

  it("the same kind still resolves strong (company ↔ company, same website)", async () => {
    const company = await captureAs("company", "Month'Immo", {
      website: "https://monthimmo.fr",
    });
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "company",
      signals: extractIdentitySignals(
        { website: "https://www.monthimmo.fr/" },
        { kind: "company" }
      ),
      userScope: ownScope(),
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(company);
    expect(res.crossKindCandidates).toEqual([]);
  });

  it("the bookmark family is one subject: a bookmark resolves onto the article owning the url", async () => {
    const article = await captureAs("article", "A post", {
      url: "https://blog.x.com/post",
    });
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "bookmark",
      signals: extractIdentitySignals(
        { url: "https://blog.x.com/post?utm_source=feed" },
        { kind: "bookmark" }
      ),
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(article);
  });

  it("with no kindSlug any owner resolves strong, as before", async () => {
    const company = await captureAs("company", "Month'Immo", {
      website: "https://monthimmo.fr",
    });
    const res = await resolveIdentity(db, {
      userId: USER,
      signals: extractIdentitySignals({ website: "https://monthimmo.fr" }),
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(company);
  });

  it("when one call's signals belong to two subjects, the owner of the requested kind wins", async () => {
    // Company first → earliest-created; the person must still win.
    const company = await captureAs("company", "Month'Immo", {
      website: "https://monthimmo.fr",
    });
    const person = await captureAs("person", "Tristan Monthiller", {
      email: "tristan@monthimmo.fr",
    });
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "person",
      signals: extractIdentitySignals(
        { email: "tristan@monthimmo.fr", website: "https://monthimmo.fr" },
        { kind: "person" }
      ),
      userScope: ownScope(),
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(person);
    expect(res.entity?.id).not.toBe(company);
  });

  it("a role slug resolves strong onto a kind the role may sit on, and only those", async () => {
    await defineRole("client", ["person"]);
    const person = await captureAs("person", "Ada", {
      email: "ada@example.com",
    });
    await captureAs("company", "Acme", { email: "hello@acme.com" });

    const onPerson = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "client",
      signals: [{ type: "email", value: "ada@example.com" }],
    });
    expect(onPerson.match).toBe("strong");
    expect(onPerson.entity?.id).toBe(person);

    const onCompany = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "client",
      signals: [{ type: "email", value: "hello@acme.com" }],
    });
    expect(onCompany.match).not.toBe("strong");
  });

  it("a role with no applicable kinds sits on any kind", async () => {
    await defineRole("partner", null);
    const company = await captureAs("company", "Acme", {
      email: "hello@acme.com",
    });
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "partner",
      signals: [{ type: "email", value: "hello@acme.com" }],
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(company);
  });

  it("alsoKinds (a multi-kind role rewritten onto one kind) count as the same subject", async () => {
    const person = await captureAs("person", "Ada", {
      email: "ada@example.com",
    });
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "company",
      alsoKinds: ["company", "person"],
      signals: [{ type: "email", value: "ada@example.com" }],
    });
    expect(res.match).toBe("strong");
    expect(res.entity?.id).toBe(person);
  });

  it("merges the strong cross-kind owner with the weak path's same-title rows, once each", async () => {
    // Same title AND owns the signal: named once.
    const both = await captureAs("company", "Tristan Monthiller", {
      website: "https://monthimmo.fr",
    });
    const titleOnly = await captureAs("note", "Tristan Monthiller", {});
    const res = await resolveIdentity(db, {
      userId: USER,
      kindSlug: "person",
      name: "Tristan Monthiller",
      signals: extractIdentitySignals(
        { website: "https://monthimmo.fr" },
        { kind: "person" }
      ),
      userScope: ownScope(),
    });
    expect(res.match).toBeNull();
    const ids = res.crossKindCandidates.map((c) => c.id);
    expect(ids.sort()).toEqual([both, titleOnly].sort());
  });
});
