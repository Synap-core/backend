/**
 * Library KEEP-ALIVE on PGlite (tables generated from the Drizzle schema),
 * through the real SQL of `runLibraryKeepAlive`. Only the notification door is
 * injected (its own tests cover suppression windows and delivery).
 *
 * Pins: the quiet auto-archive touches ONLY ungrouped, unbuilt items unseen for
 * N days (and stays off at 0); the weekly suggestion names each person's
 * LONGEST-waiting group and nothing already built; resurfacing finds kept items
 * that name a project worked on this week; the pod setting turns the
 * suggestions off.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import type { db as DatabaseHandle } from "@synap/database";
import { readLibraryKeepAlive, runLibraryKeepAlive } from "../keep-alive.js";
import { signalFromNotification } from "../../signals/needs-you-union.js";
import { pushTarget } from "../../../notifications/NotificationService.js";
import { getNotificationDef } from "../../../notifications/registry.js";

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

const NOW = new Date("2026-10-13T12:00:00Z");
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 86_400_000).toISOString();

const A = "user-a";
const B = "user-b";
let client: PGlite;
let database: typeof DatabaseHandle;

async function item(args: {
  user: string;
  title: string;
  keptDaysAgo: number;
  curation?: Record<string, unknown>;
  read?: Record<string, unknown>;
  runId?: string;
}): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into documents (id, user_id, title, type, storage_url, storage_key, size, metadata, created_at, updated_at)
     values ($1, $2, $3, 'text', '', '', 0, $4::jsonb, $5::timestamptz, $5::timestamptz)`,
    [
      id,
      args.user,
      args.title,
      JSON.stringify({
        importItem: { kind: "url" },
        intakeSource: { sessionId: args.runId ?? null },
        importCuration: args.curation ?? {},
        ...(args.read ? { importRead: args.read } : {}),
      }),
      daysAgo(args.keptDaysAgo),
    ]
  );
  return id;
}

async function curationOf(id: string) {
  const {
    rows: [row],
  } = await client.query<{ c: Record<string, unknown> }>(
    `select metadata -> 'importCuration' as c from documents where id = $1`,
    [id]
  );
  return row!.c;
}

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  database = drizzle(client, { schema }) as unknown as typeof DatabaseHandle;
}, 120_000);

describe("library keep-alive", () => {
  it("reads the pod setting with defaults (ON, 90 days) and refuses malformed values", () => {
    expect(readLibraryKeepAlive(null)).toEqual({
      enabled: true,
      archiveAfterDays: 90,
    });
    expect(
      readLibraryKeepAlive({
        libraryKeepAlive: { enabled: false, archiveAfterDays: -3 },
      })
    ).toEqual({ enabled: false, archiveAfterDays: 90 });
  });

  it("archives only ungrouped, unbuilt items unseen for 90 days; suggests the longest-waiting group; resurfaces for this week's project", async () => {
    const groupOld = randomUUID();
    const groupNew = randomUUID();
    const groupBuilt = randomUUID();
    for (const [id, name, builtAt, keyName] of [
      [groupOld, "Recipes", null, "recipes"],
      [groupNew, "Trips", null, "trips"],
      [groupBuilt, "Books", daysAgo(1), "books"],
    ] as const) {
      await client.query(
        `insert into library_groups (id, user_id, key, name, origin, outputs, build_proposal_ids, built_at)
         values ($1, $2, $3, $4, 'user', '[]'::jsonb, '[]'::jsonb, $5::timestamptz)`,
        [id, A, keyName, name, builtAt]
      );
    }
    const stale = await item({ user: A, title: "Old link", keptDaysAgo: 120 });
    const seenRecently = await item({
      user: A,
      title: "Opened last week",
      keptDaysAgo: 120,
      curation: { seenAt: daysAgo(7) },
    });
    const grouped = await item({
      user: A,
      title: "Pasta",
      keptDaysAgo: 200,
      curation: { groupIds: [groupOld] },
    });
    await item({
      user: A,
      title: "Lisbon",
      keptDaysAgo: 10,
      curation: { groupIds: [groupNew] },
    });
    // Built group: its member predates built_at — nothing waits.
    await item({
      user: A,
      title: "Dune",
      keptDaysAgo: 5,
      curation: { groupIds: [groupBuilt] },
    });
    // Person C's only group is built, its member read by that Build: nothing waits.
    const groupC = randomUUID();
    await client.query(
      `insert into library_groups (id, user_id, key, name, origin, outputs, build_proposal_ids, built_at)
       values ($1, 'user-c', 'films', 'Films', 'user', '[]'::jsonb, '[]'::jsonb, $2::timestamptz)`,
      [groupC, daysAgo(2)]
    );
    await item({
      user: "user-c",
      title: "Alien",
      keptDaysAgo: 30,
      curation: { groupIds: [groupC] },
    });
    const built = await item({
      user: A,
      title: "Built one",
      keptDaysAgo: 150,
      curation: { builtAt: daysAgo(100) },
    });
    const young = await item({ user: A, title: "New link", keptDaysAgo: 3 });

    // This week's work: project "Kitchen remodel", one live session.
    const project = randomUUID();
    await client.query(
      `insert into projects (id, user_id, name, status) values ($1, $2, 'Kitchen remodel', 'active')`,
      [project, A]
    );
    await client.query(
      `insert into focus_sessions (id, user_id, project_id, status, goal, metadata, updated_at)
       values ($1, $2, $3, 'active', 'g', '{}'::jsonb, $4::timestamptz)`,
      [randomUUID(), A, project, daysAgo(1)]
    );
    const related = await item({
      user: A,
      title: "Tiles",
      keptDaysAgo: 30,
      read: {
        status: "read",
        summary: "Ideas for a kitchen remodel on a budget",
      },
    });

    const notify = vi.fn(async () => randomUUID());
    const result = await runLibraryKeepAlive({ database, now: NOW, notify });

    expect(result.archived).toBe(1);
    expect((await curationOf(stale)).archivedAt).toBe(NOW.toISOString());
    for (const kept of [seenRecently, grouped, built, young, related]) {
      expect((await curationOf(kept)).archivedAt).toBeUndefined();
    }

    const calls = notify.mock.calls.map(
      (c) => (c as unknown as [Record<string, unknown>])[0]
    );
    const suggestion = calls.find((c) => c.type === "library.build_suggestion");
    expect(suggestion).toMatchObject({
      userId: A,
      sourceId: groupOld,
      groupKey: `library.build_suggestion:${A}`,
      data: { groupName: "Recipes", waiting: 1, waitDays: 200 },
    });
    // One per person, and none for a group with nothing new since built.
    expect(
      calls
        .filter((c) => c.type === "library.build_suggestion")
        .map((c) => c.userId)
    ).toEqual([A]);

    // REACHABILITY: each notification, stored as the door stores it, is a
    // union row that OPENS something — and its push carries the same door.
    const doorOf = (input: Record<string, unknown>) => {
      const def = getNotificationDef(input.type as string)!;
      const signal = signalFromNotification({
        id: "n1",
        title: "t",
        category: def.category,
        sourceType: input.sourceType as string,
        sourceId: input.sourceId as string,
        createdAt: NOW,
        type: input.type as string,
        actions: def.actions,
      });
      return {
        union: signal.target,
        push: pushTarget(def, input as never),
      };
    };
    expect(doorOf(suggestion!)).toEqual({
      union: { kind: "library_group", id: groupOld },
      push: { kind: "library_group", id: groupOld },
    });

    const resurface = calls.find((c) => c.type === "library.resurface");
    expect(resurface).toMatchObject({
      userId: A,
      sourceId: project,
      data: { projectName: "Kitchen remodel", count: 1, titles: "Tiles" },
    });
    expect(doorOf(resurface!)).toEqual({
      union: { kind: "library", id: project },
      push: { kind: "library", id: project },
    });
  });

  it("the pod setting turns the suggestions off and the archive off at 0", async () => {
    await client.query(
      `insert into pod_settings (id, settings) values ($1, $2::jsonb)`,
      [
        randomUUID(),
        JSON.stringify({
          libraryKeepAlive: { enabled: false, archiveAfterDays: 0 },
        }),
      ]
    );
    const stale = await item({ user: B, title: "Old", keptDaysAgo: 400 });
    const notify = vi.fn(async () => randomUUID());
    const result = await runLibraryKeepAlive({ database, now: NOW, notify });
    expect(result).toMatchObject({ archived: 0, suggested: 0, resurfaced: 0 });
    expect(notify).not.toHaveBeenCalled();
    expect((await curationOf(stale)).archivedAt).toBeUndefined();
  });
});
