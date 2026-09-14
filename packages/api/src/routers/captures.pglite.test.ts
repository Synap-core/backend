/**
 * `captures.list` / `captures.get` driven through the REAL procedures on PGlite:
 * the real `scopedDb` documents rule, the owner narrow, cursor paging, the
 * derived status and producedCount, and the detail's produced/runs.
 *
 * The owner-floor fixture is DISCRIMINATING: user B is a member of the
 * workspace A's capture lives in, so the `documents` VisibilityRule alone
 * ADMITS the row (asserted directly) — only the owner narrow hides it.
 *
 * Stubbed: nothing on the read path. Tables are generated from the Drizzle
 * definitions (non-basic column types collapse to text).
 *
 * NOT covered: the stored-file branch of `raw` (a bytes-only file ref) and
 * `readDocumentVersionContent` reading a version from storage (both versions
 * here are inline).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
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
  return {
    ...actual,
    db: drizzle(client, {
      schema: {
        documents: actual.documents as never,
        entities: actual.entities as never,
        focusSessions: actual.focusSessions as never,
      },
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  documents,
  documentVersions,
  entities,
  entityFacets,
  relations,
  projectMembers,
  workspaces,
  workspaceMembers,
  podMembers,
  focusSessions,
  links,
  messages,
  profiles,
} from "@synap/database";
import { capturesRouter } from "./captures.js";
import { AccessContext, scopedDb } from "../access/index.js";

const A = "user-a";
const B = "user-b";
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

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  capturesRouter.createCaller({ authenticated: true, userId } as never);

async function capture(opts: {
  userId?: string;
  workspaceId?: string | null;
  sessionId?: string | null;
  text?: string;
  degraded?: boolean;
  /** `null` = no door key at all. */
  door?: string | null;
  kind?: string;
  at?: string;
  intake?: boolean;
}): Promise<string> {
  const id = randomUUID();
  const metadata =
    opts.intake === false
      ? {}
      : {
          intakeSource: {
            version: 1,
            kind: opts.kind ?? "text",
            contentHash: randomUUID(),
            sessionId: opts.sessionId ?? null,
            ...(opts.door === null ? {} : { door: opts.door ?? "capture" }),
            ...(opts.degraded
              ? { degraded: { reason: "spend_guard", at: "t" } }
              : {}),
          },
        };
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, metadata, created_at, updated_at)
     values ($1, $2, $3, 'src', 'markdown', $4::jsonb, $5, $5)`,
    [
      id,
      opts.userId ?? A,
      opts.workspaceId ?? null,
      JSON.stringify(metadata),
      opts.at ?? new Date().toISOString(),
    ]
  );
  await q(
    `insert into document_versions (id, document_id, version, content) values ($1, $2, 1, $3)`,
    [randomUUID(), id, opts.text ?? "hello   world"]
  );
  return id;
}

async function session(
  opts: { channelId?: string | null; at?: string } = {}
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status, channel_id, metadata, created_at, updated_at)
     values ($1, $2, 'Capture', 'active', $3, '{}'::jsonb, $4, $4)`,
    [id, A, opts.channelId ?? null, opts.at ?? new Date().toISOString()]
  );
  return id;
}

async function entity(opts: { deleted?: boolean; profileId?: string } = {}) {
  const id = randomUUID();
  await q(
    `insert into entities (id, user_id, title, profile_id, deleted_at) values ($1, $2, 'Made thing', $3, $4)`,
    [
      id,
      A,
      opts.profileId ?? null,
      opts.deleted ? new Date().toISOString() : null,
    ]
  );
  return id;
}

const edge = (
  fromType: string,
  fromId: string,
  toType: string,
  toId: string,
  linkType: string
) =>
  q(
    `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata) values ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
    [randomUUID(), fromType, fromId, toType, toId, linkType]
  );

describe("captures API", () => {
  beforeAll(async () => {
    for (const t of [
      documents,
      documentVersions,
      entities,
      entityFacets,
      relations,
      projectMembers,
      workspaces,
      workspaceMembers,
      podMembers,
      focusSessions,
      links,
      messages,
      profiles,
    ]) {
      await h.client!.exec(ddlFor(t as unknown as PgTable));
    }
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from documents; delete from document_versions; delete from entities; delete from focus_sessions; delete from links; delete from messages; delete from profiles; delete from workspaces; delete from workspace_members;"
    );
  });

  it("owner floor: B cannot list or get A's capture, even in a shared workspace the documents rule admits", async () => {
    const ws = randomUUID();
    await q(
      `insert into workspaces (id, owner_id, name) values ($1, $2, 'Shared')`,
      [ws, A]
    );
    for (const u of [A, B]) {
      await q(
        `insert into workspace_members (id, workspace_id, user_id, role) values ($1, $2, $3, 'editor')`,
        [randomUUID(), ws, u]
      );
    }
    const mine = await capture({ workspaceId: ws });
    await capture({ intake: false }); // a plain document is not a capture

    // The fixture discriminates: the access rule alone lets B see the row.
    const viaRule = await scopedDb(AccessContext.from({ userId: B })).findMany<{
      id: string;
    }>(documents, { columns: { id: true } });
    expect(viaRule.map((r) => r.id)).toContain(mine);

    expect((await caller(A).list({})).items.map((i) => i.documentId)).toEqual([
      mine,
    ]);
    expect((await caller(B).list({})).items).toEqual([]);
    await expect(caller(B).get({ documentId: mine })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      caller(A).get({ documentId: randomUUID() })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("list shows only user capture kinds — an unknown (machine) kind is not listed, yet get resolves it", async () => {
    const listed = await Promise.all(
      ["text", "url", "file", "import_item"].map((kind) => capture({ kind }))
    );
    const machine = await capture({ kind: "sync_record" });

    const ids = (await caller(A).list({})).items.map((i) => i.documentId);
    expect(new Set(ids)).toEqual(new Set(listed));
    expect(ids).not.toContain(machine);
    expect((await caller(A).get({ documentId: machine })).kind).toBe(
      "sync_record"
    );
  });

  it("door: a known door passes through; an unknown or absent door is null, never the raw value", async () => {
    const calcom = await capture({ door: "calcom.webhook" });
    const unknown = await capture({ door: "some.future.door" });
    const absent = await capture({ door: null });
    const byId = new Map(
      (await caller(A).list({})).items.map((i) => [i.documentId, i.door])
    );
    expect(byId.get(calcom)).toBe("calcom.webhook");
    expect(byId.get(unknown)).toBeNull();
    expect(byId.get(absent)).toBeNull();
  });

  it("cursor pages newest-first with a createdAt tie, no duplicates, and ends with a null cursor", async () => {
    const tie = "2026-09-14T10:00:00.000Z";
    const ids = [
      await capture({ at: "2026-09-14T09:00:00.000Z" }),
      await capture({ at: tie }),
      await capture({ at: tie }),
      await capture({ at: "2026-09-14T11:00:00.000Z" }),
      await capture({ at: "2026-09-14T12:00:00.000Z" }),
    ];
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await caller(A).list({ limit: 2, cursor });
      seen.push(...page.items.map((i) => i.documentId));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice(0, 2)).toEqual([ids[4], ids[3]]);
    expect(seen[4]).toBe(ids[0]);
    await expect(
      caller(A).list({ cursor: "not-a-cursor" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("derives status and producedCount per row, and the status filter uses the same derivation", async () => {
    // document edge (live) + a deleted target that must not count; degraded marker too
    const structured = await capture({
      degraded: true,
      text: "a ".repeat(300),
    });
    await edge("document", structured, "entity", await entity(), "produced");
    await edge(
      "document",
      structured,
      "entity",
      await entity({ deleted: true }),
      "produced"
    );

    const saved = await capture({ degraded: true });
    const plain = await capture({});

    const channelId = randomUUID();
    const asked = await capture({ sessionId: await session({ channelId }) });
    await q(
      `insert into messages (id, channel_id, metadata) values ($1, $2, $3::jsonb)`,
      [
        randomUUID(),
        channelId,
        JSON.stringify({
          capturePart: { kind: "capture_question", status: "open" },
        }),
      ]
    );

    // TRANSITIONAL fallback: no document edge ⇒ the source's session edges count.
    const legacySession = await session();
    const legacy = await capture({ sessionId: legacySession });
    await edge("session", legacySession, "entity", await entity(), "produced");

    const byId = new Map(
      (await caller(A).list({})).items.map((i) => [i.documentId, i])
    );
    expect(byId.get(structured)).toMatchObject({
      status: "structured",
      producedCount: 1,
      degradedReason: "spend_guard",
      door: "capture",
    });
    expect(byId.get(structured)!.preview.length).toBe(200);
    expect(byId.get(saved)).toMatchObject({
      status: "saved_without_ai",
      producedCount: 0,
    });
    expect(byId.get(plain)).toMatchObject({
      status: "not_structured",
      preview: "hello world",
    });
    expect(byId.get(asked)!.status).toBe("needs_answer");
    expect(byId.get(legacy)).toMatchObject({
      status: "structured",
      producedCount: 1,
    });

    const filtered = await caller(A).list({ status: "saved_without_ai" });
    expect(filtered.items.map((i) => i.documentId)).toEqual([saved]);
    expect(filtered.nextCursor).toBeNull();
  });

  it("get returns the full raw, what it made (with kind), and the run plus its rerun", async () => {
    const run = await session({ at: "2026-09-14T09:00:00.000Z" });
    const rerun = await session({ at: "2026-09-14T10:00:00.000Z" });
    await edge("session", rerun, "session", run, "spawned_from");
    const doc = await capture({ sessionId: run, text: "the whole raw body" });
    const profileId = randomUUID();
    await q(`insert into profiles (id, slug) values ($1, 'task')`, [profileId]);
    const made = await entity({ profileId });
    await edge("document", doc, "entity", made, "produced");

    const detail = await caller(A).get({ documentId: doc });
    expect(detail.raw).toEqual({ text: "the whole raw body", file: null });
    expect(detail.produced).toEqual([
      { entityId: made, title: "Made thing", kind: "task" },
    ]);
    expect(detail.runs.map((r) => [r.sessionId, r.spawnedFrom])).toEqual([
      [run, null],
      [rerun, run],
    ]);
    expect(detail.status).toBe("structured");
  });
});
