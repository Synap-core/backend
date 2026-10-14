/**
 * The media-copy backfill on PGlite: real `entities` / `profiles` /
 * `pod_settings` rows, the real scope query, the runner's real plan, and a
 * recording `send` in place of pg-boss.
 *
 * Rows that rule out a wrong rule:
 *   - a LINK kind's declared `url` is its page → never enqueued (a backfill that
 *     read "any declared property" would request every bookmarked page);
 *   - an already-copied URL and a permanent refusal → not enqueued (the plan,
 *     not "has a URL", decides);
 *   - a kind with NO presentation but a `media-urls` property → enqueued (the
 *     scope is not only "declaring profiles");
 *   - a soft-deleted entity → not enqueued;
 *   - a crash mid-run resumes AFTER the last fully-enqueued batch, not at 0 and
 *     not past the failed batch, and the spread continues from the stored tail;
 *   - the completed stamp short-circuits ONLY for the coverage it scanned: a
 *     kind that gains a media declaration re-opens the scan.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});
vi.mock("@synap/events", () => ({
  getBoss: () => {
    throw new Error("the test injects send — pg-boss must not be reached");
  },
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  backfillEntityMediaCopies,
  readBackfillMarker,
  type BackfillSend,
} from "../backfill-media-copy.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : type === "jsonb" && c.notNull
          ? " default '{}'::jsonb"
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const USER = randomUUID();
const IMG = "https://cdn.test/cover.png";

/** Ids ascend in insertion order, so batches are predictable. */
let seq = 0;
const nextId = () =>
  `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

async function profile(uiHints: unknown): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into profiles (id, slug, display_name, ui_hints) values ($1, $2, $3, $4)`,
    [id, `p-${id.slice(0, 8)}`, "P", JSON.stringify(uiHints)]
  );
  return id;
}

async function entity(
  profileId: string,
  properties: Record<string, unknown>,
  opts: { systemData?: unknown; deleted?: boolean } = {}
): Promise<string> {
  const id = nextId();
  await q(
    `insert into entities (id, user_id, profile_id, title, properties, system_data, deleted_at)
     values ($1, $2, $3, 'x', $4, $5, $6)`,
    [
      id,
      USER,
      profileId,
      JSON.stringify(properties),
      JSON.stringify(opts.systemData ?? {}),
      opts.deleted ? new Date() : null,
    ]
  );
  return id;
}

function recorder(failOnCall?: number) {
  const calls: Array<{ entityId: string; startAfter: Date; key: string }> = [];
  let n = 0;
  const send: BackfillSend = async (_queue, data, options) => {
    n++;
    if (failOnCall !== undefined && n === failOnCall)
      throw new Error("pg-boss down");
    calls.push({
      entityId: data.entityId,
      startAfter: options.startAfter,
      key: options.singletonKey,
    });
    return "job";
  };
  return { send, calls };
}

const NOW = new Date("2026-10-14T10:00:00Z");
const MEDIA = {
  presentation: { family: "media", media: { source: { property: "cover" } } },
};
const LINK = {
  presentation: { family: "link", media: { source: { property: "url" } } },
};

beforeAll(async () => {
  await h.client!.exec(
    [schema.profiles, schema.entities, schema.podSettings]
      .map((t) => ddlFor(t as PgTable))
      .join("\n")
  );
});

beforeEach(async () => {
  await h.client!.exec(
    `delete from entities; delete from profiles; delete from pod_settings;`
  );
  await q(`insert into pod_settings (settings) values ($1)`, [
    JSON.stringify({ sibling: { kept: true } }),
  ]);
});

describe("backfillEntityMediaCopies", () => {
  it("enqueues exactly the entities the runner's plan says owe media, spaced apart", async () => {
    const pMedia = await profile(MEDIA);
    const pLink = await profile(LINK);
    const pNone = await profile({});

    const owesCover = await entity(pMedia, { cover: IMG });
    await entity(
      pMedia,
      { cover: IMG },
      {
        systemData: {
          media: [
            {
              documentId: "d",
              mime: "image/png",
              bytes: 1,
              sourceUrl: IMG,
              copiedAt: "t",
            },
          ],
        },
      }
    );
    await entity(pLink, { url: "https://site.test/page" });
    const owesCaptured = await entity(pNone, {
      "media-urls": ["https://cdn.test/slide.jpg"],
    });
    await entity(pMedia, { cover: IMG }, { deleted: true });
    await entity(
      pMedia,
      { cover: "https://cdn.test/refused.png" },
      {
        systemData: {
          mediaCopyFailures: [
            {
              sourceUrl: "https://cdn.test/refused.png",
              reason: "not_image",
              attempts: 1,
              lastAttemptAt: "t",
            },
          ],
        },
      }
    );
    await entity(pMedia, { cover: "not a url" });
    await entity(pNone, { title: "no media at all" });

    const { send, calls } = recorder();
    const result = await backfillEntityMediaCopies({
      send,
      now: () => NOW,
      spacingSeconds: 6,
    });

    expect(calls.map((c) => c.entityId)).toEqual([owesCover, owesCaptured]);
    expect(calls.map((c) => c.startAfter.toISOString())).toEqual([
      "2026-10-14T10:00:00.000Z",
      "2026-10-14T10:00:06.000Z",
    ]);
    expect(calls[0]!.key).toBe(`entity-media-copy-backfill:${owesCover}`);
    expect(result).toMatchObject({ status: "completed", enqueued: 2 });

    const marker = await readBackfillMarker();
    expect(marker).toMatchObject({
      enqueued: 2,
      completedAt: NOW.toISOString(),
      nextStartAt: "2026-10-14T10:00:12.000Z",
    });
    // Only its own key on the singleton row: sibling settings survive.
    const [row] = (
      await q<{ settings: Record<string, unknown> }>(
        `select settings from pod_settings`
      )
    ).rows;
    expect(row!.settings.sibling).toEqual({ kept: true });
  });

  it("is idempotent: a completed stamp for the same coverage sends nothing", async () => {
    const pMedia = await profile(MEDIA);
    await entity(pMedia, { cover: IMG });
    await backfillEntityMediaCopies({ send: recorder().send, now: () => NOW });

    const again = recorder();
    const result = await backfillEntityMediaCopies({
      send: again.send,
      now: () => NOW,
    });
    expect(result.status).toBe("already-complete");
    expect(again.calls).toHaveLength(0);
  });

  it("a crash resumes after the last fully-enqueued batch and keeps the spread", async () => {
    const pMedia = await profile(MEDIA);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await entity(pMedia, { cover: IMG }));

    // Batch 1 = ids[0..1] (sends 1–2), batch 2 = ids[2..3]: send #4 fails.
    const first = recorder(4);
    await expect(
      backfillEntityMediaCopies({
        send: first.send,
        now: () => NOW,
        batchSize: 2,
        spacingSeconds: 6,
      })
    ).rejects.toThrow("pg-boss down");

    const stalled = await readBackfillMarker();
    expect(stalled).toMatchObject({ cursor: ids[1], enqueued: 2 });
    expect(stalled!.completedAt).toBeUndefined();

    const later = new Date("2026-10-14T10:00:01Z");
    const second = recorder();
    const result = await backfillEntityMediaCopies({
      send: second.send,
      now: () => later,
      batchSize: 2,
      spacingSeconds: 6,
    });
    // ids[2] is re-sent (its batch never completed) — the singleton slot
    // absorbs it in pg-boss; nothing before the cursor is.
    expect(second.calls.map((c) => c.entityId)).toEqual(ids.slice(2));
    // The spread resumes at the persisted tail, not at "now".
    expect(second.calls[0]!.startAfter.toISOString()).toBe(
      "2026-10-14T10:00:12.000Z"
    );
    expect(result).toMatchObject({
      status: "completed",
      enqueued: 5,
      resumedFrom: ids[1],
    });
  });

  it("a kind that gains a media declaration re-opens a completed scan", async () => {
    const pMedia = await profile(MEDIA);
    const pLater = await profile({});
    await entity(pMedia, { cover: IMG });
    const laterOwes = await entity(pLater, { photo: IMG });

    const first = recorder();
    await backfillEntityMediaCopies({ send: first.send, now: () => NOW });
    expect(first.calls).toHaveLength(1);

    await q(`update profiles set ui_hints = $1 where id = $2`, [
      JSON.stringify({
        presentation: {
          family: "record",
          media: { source: { property: "photo" } },
        },
      }),
      pLater,
    ]);

    const second = recorder();
    const result = await backfillEntityMediaCopies({
      send: second.send,
      now: () => NOW,
    });
    expect(result.status).toBe("completed");
    // The first entity still owes (the job has not run here) and is re-sent;
    // the newly declared kind's entity is now in scope.
    expect(second.calls.map((c) => c.entityId)).toContain(laterOwes);
  });
});
