/**
 * "When did we last speak to them" (0359, CRM recall C-W2) on PGlite, through
 * the real drizzle statements:
 *  - the door only moves the value FORWARD, refuses the future, writes the
 *    column and its `properties.lastInteractionAt` projection together, and
 *    leaves `updated_at` / `version` alone (a bump is not an edit);
 *  - the evidence rule: a past meeting counts, a future one does not until
 *    the sweep runs after it; an undated note does not count, a dated one
 *    does; a sent touch counts (by `sentDate`, else its move to `sent`), a
 *    drafted one does not;
 *  - the operator rebuild is the one writer that lowers and clears.
 *
 * NOT COVERED: the reactor wiring and the jobs worker that call this
 * (`packages/events` side-effects test, `packages/jobs` worker test).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { entities } from "../../schema/entities.js";
import { relations } from "../../schema/relations.js";
import { events } from "../../schema/events.js";
import { noteInteraction } from "./note-interaction.js";
import {
  noteInteractionsFrom,
  rebuildLastInteraction,
} from "./interaction-evidence.js";

type Db = Parameters<typeof noteInteraction>[0];

/** Columns only: no constraints, so each row names just what it is about. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type =
      /^(text|uuid|jsonb|boolean|integer|timestamp)/.exec(t)?.[0] ?? "text";
    const dflt =
      c.name === "id"
        ? " default gen_random_uuid()"
        : type === "jsonb"
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type === "timestamp" ? "timestamptz" : type}${dflt}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const NOW = new Date("2026-10-26T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let client: PGlite;
let db: Db;
let n = 0;
const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

async function entity(
  type: string,
  properties: Record<string, unknown> = {},
  extra: { status?: string; lastInteractionAt?: Date } = {}
): Promise<string> {
  const eid = id();
  await client.query(
    `insert into entities (id, user_id, type, properties, status, last_interaction_at, version, updated_at)
     values ($1, 'u1', $2, $3, $4, $5, 1, '2026-01-01T00:00:00Z')`,
    [
      eid,
      type,
      JSON.stringify(properties),
      extra.status ?? null,
      extra.lastInteractionAt?.toISOString() ?? null,
    ]
  );
  return eid;
}

async function edge(type: string, source: string, target: string) {
  const rid = id();
  await client.query(
    `insert into relations (id, user_id, type, source_entity_id, target_entity_id) values ($1, 'u1', $2, $3, $4)`,
    [rid, type, source, target]
  );
  return rid;
}

async function moved(touch: string, to: string, at: Date) {
  await client.query(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id)
     values (gen_random_uuid(), $1, 'entity.transition.completed', $2, 'entity', $3, 'u1')`,
    [at.toISOString(), touch, JSON.stringify({ to, role: null })]
  );
}

async function row(eid: string) {
  const r = await client.query<{
    at: Date | null;
    projected: string | null;
    updated_at: Date;
    version: number;
  }>(
    `select last_interaction_at as at, properties->>'lastInteractionAt' as projected, updated_at, version from entities where id = $1`,
    [eid]
  );
  return r.rows[0]!;
}

beforeEach(async () => {
  client = new PGlite();
  for (const t of [entities, relations, events]) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  db = drizzle(client, {
    schema: { entities, relations, events },
  }) as unknown as Db;
});

describe("noteInteraction — the forward-only door", () => {
  it("moves forward, never back, and writes the projection with the column", async () => {
    const p = await entity("person");
    expect(
      (await noteInteraction(db, { entityIds: [p], at: ago(3), now: NOW }))
        .moved
    ).toEqual([p]);
    // An OLDER interaction reported late must not pull the value back.
    expect(
      (await noteInteraction(db, { entityIds: [p], at: ago(10), now: NOW }))
        .moved
    ).toEqual([]);
    let r = await row(p);
    expect(r.at?.toISOString()).toBe(ago(3).toISOString());
    expect(r.projected).toBe(ago(3).toISOString());

    await noteInteraction(db, { entityIds: [p], at: ago(1), now: NOW });
    r = await row(p);
    expect(r.at?.toISOString()).toBe(ago(1).toISOString());
    expect(r.projected).toBe(ago(1).toISOString());
  });

  it("refuses the future and leaves the row untouched", async () => {
    const p = await entity("person");
    const res = await noteInteraction(db, {
      entityIds: [p],
      at: new Date(NOW.getTime() + DAY),
      now: NOW,
    });
    expect(res).toEqual({ moved: [], refused: "future" });
    expect((await row(p)).at).toBeNull();
  });

  it("is not an edit: updated_at and version stay", async () => {
    const p = await entity("person");
    await noteInteraction(db, { entityIds: [p], at: ago(1), now: NOW });
    const r = await row(p);
    expect(r.updated_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(r.version).toBe(1);
  });
});

describe("the evidence rule (reactor, sweep, recompute)", () => {
  it("a past meeting counts for its attendee; a future one only once the sweep runs after it", async () => {
    const alice = await entity("person");
    const bob = await entity("person");
    const past = await entity("event", { startDate: ago(2).toISOString() });
    const future = await entity("event", {
      startDate: new Date(NOW.getTime() + 2 * DAY).toISOString(),
    });
    const e1 = await edge("attended_by", past, alice);
    const e2 = await edge("attended_by", future, bob);

    await noteInteractionsFrom(db, { relationIds: [e1, e2] }, NOW);
    expect((await row(alice)).at?.toISOString()).toBe(ago(2).toISOString());
    expect((await row(bob)).at).toBeNull();

    // Three days later the daily sweep reads the meeting that has now happened.
    const later = new Date(NOW.getTime() + 3 * DAY);
    await noteInteractionsFrom(
      db,
      { recordDatesFrom: new Date(later.getTime() - 7 * DAY) },
      later
    );
    expect((await row(bob)).at?.toISOString()).toBe(
      new Date(NOW.getTime() + 2 * DAY).toISOString()
    );
  });

  it("met_at reads the date of the event the person met at", async () => {
    const p = await entity("person");
    const conf = await entity("event", { startDate: ago(5).toISOString() });
    const e = await edge("met_at", p, conf);
    await noteInteractionsFrom(db, { relationIds: [e] }, NOW);
    expect((await row(p)).at?.toISOString()).toBe(ago(5).toISOString());
  });

  it("an undated note does not count; a dated one does (either direction)", async () => {
    const p = await entity("person");
    const q = await entity("person");
    const undated = await entity("note", { content: "imported" });
    const dated = await entity("note", { date: "2026-10-20" });
    const e1 = await edge("discussed_with", undated, p);
    const e2 = await edge("discussed_with", q, dated);
    await noteInteractionsFrom(db, { relationIds: [e1, e2] }, NOW);
    expect((await row(p)).at).toBeNull();
    expect((await row(q)).at?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });

  it("a mention is not an interaction", async () => {
    const p = await entity("person");
    const ev = await entity("event", { startDate: ago(1).toISOString() });
    const e = await edge("mentions", ev, p);
    await noteInteractionsFrom(db, { relationIds: [e] }, NOW);
    expect((await row(p)).at).toBeNull();
  });

  it("a sent touch counts by sentDate, else its move to sent; a draft never; a reply is later", async () => {
    const a = await entity("person");
    const b = await entity("person");
    const c = await entity("person");
    const dated = await entity(
      "outreach-touch",
      { sentDate: ago(4).toISOString() },
      { status: "sent" }
    );
    const undated = await entity("outreach-touch", {}, { status: "replied" });
    const draft = await entity(
      "outreach-touch",
      { sentDate: ago(1).toISOString() },
      { status: "drafted" }
    );
    await moved(undated, "sent", ago(6));
    await moved(undated, "replied", ago(2));
    await edge("sent_to", dated, a);
    await edge("sent_to", undated, b);
    await edge("sent_to", draft, c);

    await noteInteractionsFrom(db, { touchIds: [dated, undated, draft] }, NOW);
    expect((await row(a)).at?.toISOString()).toBe(ago(4).toISOString());
    expect((await row(b)).at?.toISOString()).toBe(ago(2).toISOString());
    expect((await row(c)).at).toBeNull();
  });

  it("the rebuild lowers a value the graph no longer supports and clears an orphan", async () => {
    const kept = await entity("person", {}, { lastInteractionAt: ago(1) });
    const orphan = await entity(
      "person",
      { lastInteractionAt: ago(1).toISOString() },
      { lastInteractionAt: ago(1) }
    );
    const never = await entity("person", { lastInteractionAt: "2020-01-01" });
    const ev = await entity("event", { startDate: ago(9).toISOString() });
    await edge("attended_by", ev, kept);

    const dry = await rebuildLastInteraction(db, { apply: false, now: NOW });
    expect(dry).toEqual({
      set: 1,
      lowered: 1,
      cleared: 1,
      unchanged: 0,
      applied: false,
    });
    expect((await row(kept)).at?.toISOString()).toBe(ago(1).toISOString());

    await rebuildLastInteraction(db, { apply: true, now: NOW });
    expect((await row(kept)).at?.toISOString()).toBe(ago(9).toISOString());
    expect((await row(kept)).projected).toBe(ago(9).toISOString());
    expect(await row(orphan)).toMatchObject({ at: null, projected: null });
    // No column value and no evidence: a stored property is left as it was.
    expect((await row(never)).projected).toBe("2020-01-01");

    expect(
      await rebuildLastInteraction(db, { apply: false, now: NOW })
    ).toMatchObject({ set: 0, cleared: 0, unchanged: 1 });
  });
});
