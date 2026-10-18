/**
 * The LIBRARY core on a real Postgres (PGlite), driven through the service
 * doors and read back from the rows:
 *   - add: items append to ONE "Kept from <device>, <day>" run; a link kept
 *     again (even from another device) is the same item; a share-time note is
 *     a capture linked to the item;
 *   - a Library item is never a row of "my captures" — before or after Build;
 *   - list: newest first, keyset-paged with no loss across rows staged in the
 *     same millisecond; lens / status / group / archived / text filters;
 *   - curate: atomic (a bad op writes nothing); groups, membership, merge,
 *     suggestions, archive;
 *   - groups: counts and "new since built"; per-import groups are adopted once;
 *   - build: first build marks the group built and records the proposal; a
 *     rebuild reads ONLY the items staged after it; nothing new ⇒ refused;
 *   - health: unread, groups waiting, oldest wait;
 *   - owner floor: another person's group / item reads NOT_FOUND.
 *
 * Stubbed, and why: `@synap/storage` (in-memory); `openRunSession` (it queries
 * through @synap/database's own connection — the stub inserts the same
 * metadata the real door writes); the workspace write floor (membership table
 * not stood up; contract kept); the IS and the submit door are injected deps.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  objects: new Map<string, Buffer>(),
  /** Spaces the person can no longer write (the write floor's contract). */
  deniedSpaces: new Set<string>(),
  /** search-index jobs the Library queued (`@synap/jobs` stubbed below). */
  searchJobs: [] as Array<{ operation: string; documentId: string }>,
}));

vi.mock("../../../utils/workspace-write-access.js", async () => {
  const { TRPCError } = await import("@trpc/server");
  return {
    assertWorkspaceWrite: async (
      _db: unknown,
      _userId: string,
      row: { workspaceId: string | null }
    ) => {
      if (row.workspaceId && h.deniedSpaces.has(row.workspaceId)) {
        throw new TRPCError({ code: "FORBIDDEN", message: "not a member" });
      }
    },
  };
});

vi.mock("@synap/jobs", () => ({
  getBoss: () => ({
    send: async (
      queue: string,
      data: { operation?: string; documentId?: string }
    ) => {
      if (queue === "search-index") {
        h.searchJobs.push({
          operation: data.operation!,
          documentId: data.documentId!,
        });
      }
      return "job";
    },
  }),
}));

vi.mock("@synap/storage", () => ({
  storage: {
    buildPath: (userId: string, kind: string, id: string, ext: string) =>
      `${userId}/${kind}/${id}.${ext}`,
    upload: async (key: string, body: Buffer | string) => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      h.objects.set(key, buf);
      return { url: `mem://${key}`, path: key, size: buf.length };
    },
    downloadBuffer: async (key: string) =>
      h.objects.get(key) ?? Buffer.alloc(0),
    delete: async (key: string) => void h.objects.delete(key),
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, {
    schema: { focusSessions: actual.focusSessions as never },
  });
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
    openRunSession: async (input: {
      userId: string;
      goal: string;
      title?: string | null;
      workspaceId?: string | null;
      source: string;
      extraMetadata?: Record<string, unknown>;
      origin?: string;
    }) => {
      const metadata = { source: input.source, ...(input.extraMetadata ?? {}) };
      const { rows } = await client.query<{ id: string }>(
        `insert into focus_sessions (user_id, goal, title, status, workspace_id, origin, metadata)
         values ($1, $2, $3, 'active', $4, $5, $6::jsonb) returning id`,
        [
          input.userId,
          input.goal,
          input.title ?? null,
          input.workspaceId ?? null,
          input.origin ?? "agent",
          JSON.stringify(metadata),
        ]
      );
      return { sessionId: rows[0]!.id, reused: false };
    },
  };
});

import { db, documents } from "@synap/database";
import {
  documentVersions,
  entities,
  focusSessions,
  libraryGroups,
  proposals,
  workspaces,
} from "@synap/database/schema";
import { pgliteSchemaDdl } from "../../../__tests__/pglite-ddl.js";
import { ownCapturesWhere } from "../../captures/capture-scope.js";
import type { ImportBuildDeps } from "../../imports/build.js";
import type { SubmitCaptureGraphInput } from "../../capture-agent/submit-capture-graph.js";
import { loadImportSession, openImportSession } from "../../imports/session.js";
import { stageImportItems } from "../../imports/stage.js";
import { curateImport } from "../../imports/curate.js";
import { addToLibrary, libraryRunTitle } from "../add.js";
import { listLibraryItems } from "../read-model.js";
import { curateLibrary } from "../curate.js";
import {
  insertLibraryGroup,
  loadLibraryGroup,
  readLibraryGroups,
} from "../groups.js";
import { libraryHealth, searchLibrary } from "../search.js";
import { buildLibraryGroup, readNowLibraryItem } from "../build.js";
import { applyLibraryOrganize, proposeLibraryOrganize } from "../organize.js";
import { buildProposalSummary } from "../../../utils/permission-check.js";
import type { UrlRead } from "@synap-core/types/url-read";

const USER = "user-library-1";
const OTHER = "user-library-2";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const readUrl = async (url: string): Promise<UrlRead> => ({
  status: "ok",
  sourceUrl: url,
  title: `Title of ${new URL(url).pathname.slice(1) || url}`,
  author: "Ada",
  text: "Preview text",
  via: {
    id: "builtin:article",
    name: "test",
    billed: false,
    readAt: "2026-10-15T00:00:00.000Z",
  },
});

async function keep(
  urls: string[],
  extra: { device?: string; note?: string; userId?: string } = {}
) {
  return addToLibrary({
    userId: extra.userId ?? USER,
    request: {
      items: urls.map((url) => ({ kind: "url" as const, url })),
      ...(extra.device ? { device: extra.device } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    },
    deps: { readUrl },
  });
}

async function myCaptureIds(userId = USER): Promise<string[]> {
  const rows = await db
    .select({ id: documents.id })
    .from(documents)
    .where(ownCapturesWhere(userId));
  return rows.map((r) => r.id);
}

function buildDeps(submitted: SubmitCaptureGraphInput[]): ImportBuildDeps {
  return {
    structure: async ({ text }) => ({
      entities: [
        {
          tempId: "t1",
          profileSlug: "note",
          title: text.split("\n")[0]!.replace("Title: ", ""),
        },
      ],
      relations: [],
    }),
    instructionsFor: async (explicit) => explicit || undefined,
    generate: async () => ({}),
    readBytes: async (key) => h.objects.get(key) ?? Buffer.alloc(0),
    // Files a REAL proposal row: "built for this group" is derived from the
    // bundle's status. Approved here (a review that went through); the
    // update-mode suite files pending ones.
    submit: async (input) => {
      submitted.push(input);
      const { rows } = await q<{ id: string }>(
        `insert into proposals (status, proposal_type, target_type, target_id, data, subject_user_id)
         values ('approved', 'create', 'entity', gen_random_uuid(), '{}'::jsonb, $1) returning id`,
        [USER]
      );
      return { proposalId: rows[0]!.id, applied: false };
    },
  };
}

async function newGroup(name: string, itemIds: string[], note?: string) {
  const r = await curateLibrary({
    userId: USER,
    ops: [{ op: "group.create", name, itemIds, ...(note ? { note } : {}) }],
  });
  return r.createdGroupIds[0]!;
}

beforeAll(async () => {
  await h.client!.exec(
    pgliteSchemaDdl([
      focusSessions,
      documents,
      documentVersions,
      proposals,
      libraryGroups,
      entities,
      workspaces,
    ])
  );
  // The schema DDL helper emits columns only; the per-person key index is
  // what the group insert's ON CONFLICT leans on (migration 0328).
  await h.client!.exec(
    `create unique index library_groups_user_key_unique on library_groups (user_id, key)`
  );
});
beforeEach(async () => {
  h.objects.clear();
  await h.client!.exec(
    `delete from document_versions; delete from documents; delete from focus_sessions; delete from proposals; delete from library_groups; delete from entities; delete from workspaces;`
  );
});

describe("add", () => {
  it("appends to ONE open run per device and day, named for the person", async () => {
    const a = await keep(["https://example.com/a"], { device: "relay" });
    const b = await keep(["https://example.com/b"], { device: "relay" });
    expect(b.runId).toBe(a.runId);
    const day = new Date().toISOString().slice(0, 10);
    const { rows } = await q<{ title: string; metadata: any }>(
      `select title, metadata from focus_sessions where id = $1`,
      [a.runId]
    );
    expect(rows[0]!.title).toBe(libraryRunTitle("relay", day));
    expect(rows[0]!.title).toMatch(/^Kept from your phone, \d+ \w{3}$/);
    expect(rows[0]!.metadata.libraryRun).toMatchObject({
      device: "relay",
      day,
    });
    // Another device is another run.
    const c = await keep(["https://example.com/c"], { device: "browser" });
    expect(c.runId).not.toBe(a.runId);
  });

  it("a link kept again — even from another device — is the same item", async () => {
    const a = await keep(["https://example.com/same"], { device: "relay" });
    const b = await keep(["https://example.com/same"], { device: "browser" });
    expect(b.staged).toEqual([
      { itemId: a.staged[0]!.itemId, deduplicated: true },
    ]);
    const page = await listLibraryItems({ userId: USER, input: {} });
    expect(page.items).toHaveLength(1);
  });

  it("a share-time note is a capture (the person's words), linked to the item", async () => {
    const r = await keep(["https://example.com/recipe"], {
      note: "try this on Sunday",
    });
    expect(r.captureNoteId).toBeTruthy();
    expect(await myCaptureIds()).toEqual([r.captureNoteId]);
    const page = await listLibraryItems({ userId: USER, input: {} });
    expect(page.items[0]!.captureNoteId).toBe(r.captureNoteId);
  });

  it("a Read now that fails keeps the item and SAYS it failed", async () => {
    const r = await addToLibrary({
      userId: USER,
      request: {
        items: [{ kind: "url", url: "https://example.com/x" }],
        readNow: true,
      },
      deps: { readUrl },
      readNow: async () => {
        throw new Error("IS down");
      },
    });
    expect(r.staged).toHaveLength(1);
    expect(r.readNowFailed).toBe("IS down");
    expect(r.readNowProposalId).toBeUndefined();
  });
});

describe("a Library item is never a capture or document row", () => {
  it("before AND after its group is built", async () => {
    const r = await keep(["https://example.com/one"]);
    const id = r.staged[0]!.itemId;
    expect(await myCaptureIds()).toEqual([]);
    // Build clears the staged marker; the item must STILL not be a capture.
    await q(
      `update documents set metadata = metadata #- '{intakeSource,pending}' where id = $1`,
      [id]
    );
    expect(await myCaptureIds()).toEqual([]);
    // Control: the same row without `importItem` IS a capture — so it is the
    // Library predicate that keeps it out.
    await q(
      `update documents set metadata = metadata - 'importItem' where id = $1`,
      [id]
    );
    expect(await myCaptureIds()).toEqual([id]);
  });
});

describe("list", () => {
  it("pages newest first with no loss across rows staged in the same millisecond", async () => {
    const r = await keep(
      Array.from({ length: 7 }, (_, i) => `https://example.com/p${i}`)
    );
    // Same millisecond, different microseconds — a JS Date cursor loses these.
    const ids = r.staged.map((s) => s.itemId);
    for (const [i, id] of ids.entries()) {
      await q(
        `update documents set created_at = '2026-10-13 10:00:00.123000+00'::timestamptz + ($2 || ' microseconds')::interval where id = $1`,
        [id, String(i * 7)]
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const p = await listLibraryItems({
        userId: USER,
        input: { limit: 3, ...(cursor ? { cursor } : {}) },
      });
      seen.push(...p.items.map((i) => i.id));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(seen).toEqual([...ids].reverse());
  });

  it("filters by group, ungrouped, status, archive and text", async () => {
    const r = await keep([
      "https://example.com/bread",
      "https://example.com/cake",
      "https://www.instagram.com/reel/9",
    ]);
    const [bread, cake, reel] = r.staged.map((s) => s.itemId);
    const g = await newGroup("Baking", [bread!]);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{importRead}', '{"status":"read","summary":"A sourdough method","suggestedActions":[]}') where id = $1`,
      [bread]
    );
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.archive", itemIds: [cake!] }],
    });
    const ids = async (
      input: Parameters<typeof listLibraryItems>[0]["input"]
    ) =>
      (await listLibraryItems({ userId: USER, input })).items.map((i) => i.id);
    expect(await ids({ groupId: g })).toEqual([bread]);
    expect(await ids({ groupId: "ungrouped" })).toEqual([reel]);
    expect(await ids({ status: "needs_file" })).toEqual([reel]);
    expect(await ids({ status: "read" })).toEqual([bread]);
    expect(await ids({ archived: true })).toEqual([cake]);
    expect(await ids({ q: "sourdough" })).toEqual([bread]);
    const view = (
      await listLibraryItems({ userId: USER, input: { groupId: g } })
    ).items[0]!;
    expect(view.read).toMatchObject({
      status: "read",
      summary: "A sourdough method",
    });
    expect(view.groupIds).toEqual([g]);
    expect(view.runId).toBe(r.runId);
  });
});

describe("reader stamp and copied media reach the item view", () => {
  it("lists `read.reader`, `media` (in order) and `mediaFailed` from the stored metadata", async () => {
    const r = await keep(["https://www.instagram.com/p/ABC/"]);
    const id = r.staged[0]!.itemId;
    const reader = {
      id: "capture_social_post",
      name: "Apify",
      verbId: "capture_social_post",
      billed: true,
      readAt: "2026-10-15T00:00:00.000Z",
    };
    const copy = (order: number, kind: "image" | "video") => ({
      documentId: `00000000-0000-4000-8000-00000000000${order}`,
      mime: kind === "video" ? "video/mp4" : "image/jpeg",
      bytes: 100,
      sourceUrl: `https://cdn.test/${order}`,
      copiedAt: "2026-10-15T00:00:00.000Z",
      kind,
      order,
    });
    await q(
      `update documents set metadata = metadata
         || jsonb_build_object('importRead', $2::jsonb, 'importMedia', $3::jsonb, 'importMediaFailed', 1)
       where id = $1`,
      [
        id,
        JSON.stringify({ status: "read", suggestedActions: [], reader }),
        JSON.stringify([copy(1, "video"), copy(0, "image")]),
      ]
    );
    const view = (
      await listLibraryItems({ userId: USER, input: {} })
    ).items.find((i) => i.id === id)!;
    expect(view.read.reader).toEqual(reader);
    expect(view.media?.map((m) => [m.order, m.kind])).toEqual([
      [0, "image"],
      [1, "video"],
    ]);
    expect(view.mediaFailed).toBe(1);
  });
});

describe("curate — a group's Build target space (group.update workspaceId)", () => {
  const WS = "00000000-0000-4000-8000-0000000000c1";
  const ARCHIVED = "00000000-0000-4000-8000-0000000000c2";
  const space = (id: string, name: string, archived = false) =>
    q(
      `insert into workspaces (id, name, owner_id, archived_at) values ($1, $2, $3, $4)`,
      [id, name, USER, archived ? new Date() : null]
    );
  const targetOf = async (groupId: string) =>
    (
      await q<{ workspace_id: string | null }>(
        `select workspace_id from library_groups where id = $1`,
        [groupId]
      )
    ).rows[0]!.workspace_id;

  it("sets, reads back on the group view, and clears with null", async () => {
    await space(WS, "Content");
    const r = await keep(["https://example.com/t1"]);
    const g = await newGroup("Posts", [r.staged[0]!.itemId]);
    const set = await curateLibrary({
      userId: USER,
      ops: [{ op: "group.update", groupId: g, workspaceId: WS }],
    });
    expect(await targetOf(g)).toBe(WS);
    expect(set.groups.find((x) => x.id === g)?.workspaceId).toBe(WS);
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.update", groupId: g, workspaceId: null }],
    });
    expect(await targetOf(g)).toBeNull();
  });

  it("a space the person cannot write is FORBIDDEN and nothing is written", async () => {
    await space(WS, "Content");
    const r = await keep(["https://example.com/t2"]);
    const g = await newGroup("Posts", [r.staged[0]!.itemId]);
    h.deniedSpaces.add(WS);
    try {
      await expect(
        curateLibrary({
          userId: USER,
          ops: [
            { op: "group.update", groupId: g, name: "Renamed" },
            { op: "group.update", groupId: g, workspaceId: WS },
          ],
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      h.deniedSpaces.delete(WS);
    }
    expect(await targetOf(g)).toBeNull();
    const { rows } = await q<{ name: string }>(
      `select name from library_groups where id = $1`,
      [g]
    );
    expect(rows[0]!.name).toBe("Posts");
  });

  it("an archived or unknown space is refused", async () => {
    await space(ARCHIVED, "Old", true);
    const r = await keep(["https://example.com/t3"]);
    const g = await newGroup("Posts", [r.staged[0]!.itemId]);
    for (const workspaceId of [
      ARCHIVED,
      "00000000-0000-4000-8000-0000000000c9",
    ]) {
      await expect(
        curateLibrary({
          userId: USER,
          ops: [{ op: "group.update", groupId: g, workspaceId }],
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect(await targetOf(g)).toBeNull();
  });
});

describe("curate", () => {
  it("applies groups, membership, merge, suggestions and notes", async () => {
    const r = await keep(["https://example.com/a", "https://example.com/b"]);
    const [a, b] = r.staged.map((s) => s.itemId);
    const films = await newGroup("Films", [a!], "watch on Fridays");
    const docs = await newGroup("Docs", [b!]);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{importCuration,suggestedGroupIds}', $2::jsonb) where id = $1`,
      [b, JSON.stringify([films])]
    );
    let page = await listLibraryItems({ userId: USER, input: {} });
    expect(page.items.find((i) => i.id === b)!.suggestedGroupIds).toEqual([
      films,
    ]);
    await curateLibrary({
      userId: USER,
      ops: [
        { op: "suggestion.accept", itemId: b!, groupId: films },
        { op: "item.note", itemId: a!, note: "the long cut" },
        { op: "group.update", groupId: films, outputs: ["things", "list"] },
        { op: "group.merge", fromId: docs, intoId: films },
      ],
    });
    page = await listLibraryItems({ userId: USER, input: { groupId: films } });
    expect(page.items.map((i) => i.id).sort()).toEqual([a, b].sort());
    expect(page.items.find((i) => i.id === b)!.suggestedGroupIds).toEqual([]);
    expect(page.items.find((i) => i.id === a)!.note).toBe("the long cut");
    const merged = await loadLibraryGroup({ userId: USER, groupId: docs });
    expect(merged.archivedAt).not.toBeNull();
    const kept = await loadLibraryGroup({ userId: USER, groupId: films });
    expect(kept.note).toBe("watch on Fridays");
    expect(kept.outputs).toEqual(["things", "list"]);
    // Clearing a note removes it.
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.note", itemId: a!, note: "" }],
    });
    page = await listLibraryItems({ userId: USER, input: { groupId: films } });
    expect(page.items.find((i) => i.id === a)!.note).toBeUndefined();
  });

  it("archiving a group prunes it from every item's suggestions", async () => {
    const r = await keep(["https://example.com/s1", "https://example.com/s2"]);
    const [s1, s2] = r.staged.map((s) => s.itemId);
    const trips = await newGroup("Trips", []);
    const books = await newGroup("Books", []);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{importCuration,suggestedGroupIds}', $2::jsonb) where id = ANY($1::uuid[])`,
      [[s1, s2], JSON.stringify([trips, books])]
    );
    // The op names NO item: the pod finds the ones still suggesting it.
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.archive", groupId: trips }],
    });
    const { rows } = await q<{ s: string[] }>(
      `select metadata -> 'importCuration' -> 'suggestedGroupIds' as s from documents where id = ANY($1::uuid[])`,
      [[s1, s2]]
    );
    expect(rows.map((row) => row.s)).toEqual([[books], [books]]);
  });

  it("is atomic: a bad op writes nothing", async () => {
    const r = await keep(["https://example.com/a"]);
    const a = r.staged[0]!.itemId;
    await expect(
      curateLibrary({
        userId: USER,
        ops: [
          { op: "group.create", name: "Kept", itemIds: [a] },
          {
            op: "item.note",
            itemId: "00000000-0000-4000-8000-000000000000",
            note: "x",
          },
        ],
      })
    ).rejects.toThrow(/Edit #2: no item/);
    expect((await readLibraryGroups({ userId: USER })).groups).toEqual([]);
    const page = await listLibraryItems({ userId: USER, input: {} });
    expect(page.items[0]!.groupIds).toEqual([]);
  });

  it("never reaches another person's item or group", async () => {
    const mine = await keep(["https://example.com/m"]);
    const theirs = await keep(["https://example.com/t"], { userId: OTHER });
    const myGroup = await newGroup("Mine", [mine.staged[0]!.itemId]);
    await expect(
      curateLibrary({
        userId: OTHER,
        ops: [{ op: "group.update", groupId: myGroup, name: "Hijack" }],
      })
    ).rejects.toThrow(/no group/);
    await expect(
      curateLibrary({
        userId: USER,
        ops: [{ op: "item.archive", itemIds: [theirs.staged[0]!.itemId] }],
      })
    ).rejects.toThrow(/no item/);
    await expect(
      loadLibraryGroup({ userId: OTHER, groupId: myGroup })
    ).rejects.toThrow(/Group not found/);
  });
});

describe("groups", () => {
  it("counts items, reads and what is new since built; adopts per-import groups once", async () => {
    // A per-import group, made before the Library existed.
    const { sessionId } = await openImportSession({
      userId: USER,
      origin: "relay",
    });
    const session = await loadImportSession({ userId: USER, sessionId });
    const staged = await stageImportItems({
      userId: USER,
      session,
      items: [
        { kind: "url", url: "https://example.com/old1" },
        { kind: "url", url: "https://www.tiktok.com/@a/video/1" },
      ],
      deps: { readUrl },
    });
    await curateImport({
      userId: USER,
      sessionId,
      ops: [
        {
          op: "createGroup",
          name: "Old group",
          itemIds: staged.staged.map((s) => s.itemId),
        },
        { op: "setGroupNote", groupKey: "old-group", note: "carry me" },
      ],
    });
    const first = await readLibraryGroups({ userId: USER });
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0]).toMatchObject({
      name: "Old group",
      note: "carry me",
      origin: "user",
      counts: { items: 2, read: 0, notRead: 1, needsFile: 1, newSinceBuilt: 2 },
    });
    // Idempotent: a second read adopts nothing new.
    const second = await readLibraryGroups({ userId: USER });
    expect(second.groups.map((g) => g.id)).toEqual([first.groups[0]!.id]);
    expect(second.ungrouped).toBe(0);
  });
});

describe("build", () => {
  it("first build marks the group built; a rebuild reads ONLY what is new; nothing new is refused", async () => {
    const r = await keep(["https://example.com/a", "https://example.com/b"]);
    const g = await newGroup(
      "Reading",
      r.staged.map((s) => s.itemId),
      "summarise"
    );
    const submitted: SubmitCaptureGraphInput[] = [];
    const deps = buildDeps(submitted);

    const first = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(first.status).toBe("proposed");
    expect(submitted[0]!.sourceDocumentIds!.sort()).toEqual(
      r.staged.map((s) => s.itemId).sort()
    );
    let row = await loadLibraryGroup({ userId: USER, groupId: g });
    expect(row.builtAt).not.toBeNull();
    expect(row.buildingAt).toBeNull();
    expect(row.buildProposalIds).toEqual([first.proposalId]);
    let groups = await readLibraryGroups({ userId: USER });
    expect(groups.groups[0]!.counts.newSinceBuilt).toBe(0);

    const again = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(again).toMatchObject({ status: "refused", reason: "nothing_new" });
    row = await loadLibraryGroup({ userId: USER, groupId: g });
    expect(row.buildingAt).toBeNull();

    // A new item joins the built group.
    const c = await keep(["https://example.com/c"]);
    const cId = c.staged[0]!.itemId;
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.items", groupId: g, add: [cId] }],
    });
    groups = await readLibraryGroups({ userId: USER });
    expect(groups.groups[0]!.counts.newSinceBuilt).toBe(1);
    const rebuild = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(rebuild.status).toBe("proposed");
    expect(submitted[1]!.sourceDocumentIds).toEqual([cId]);
    row = await loadLibraryGroup({ userId: USER, groupId: g });
    expect(row.buildProposalIds).toEqual([
      first.proposalId,
      rebuild.proposalId,
    ]);
  });

  it("a second build while one holds the group is refused", async () => {
    const r = await keep(["https://example.com/a"]);
    const g = await newGroup("Busy", [r.staged[0]!.itemId]);
    await q(`update library_groups set building_at = now() where id = $1`, [g]);
    const res = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => buildDeps([]),
    });
    expect(res).toMatchObject({
      status: "refused",
      reason: "already_building",
    });
  });

  it("Read now files the item alone — no group container", async () => {
    const r = await keep(["https://example.com/now"]);
    const submitted: SubmitCaptureGraphInput[] = [];
    const res = await readNowLibraryItem({
      userId: USER,
      itemId: r.staged[0]!.itemId,
      depsFor: () => buildDeps(submitted),
    });
    expect(res.status).toBe("proposed");
    expect(submitted[0]!.entities.map((e) => e.ref)).not.toContain("group");
    expect(submitted[0]!.relations ?? []).toEqual([]);
    const page = await listLibraryItems({ userId: USER, input: {} });
    expect(page.items[0]!.builtAt).toBeTruthy();
  });
});

describe("search and health", () => {
  it("one search spans captures and the Library", async () => {
    await keep(["https://example.com/sourdough"], {
      note: "sourdough for Sunday",
    });
    const res = await searchLibrary({
      userId: USER,
      q: "sourdough",
      limit: 10,
    });
    expect(res.captures.map((c) => c.title)).toEqual(["sourdough for Sunday"]);
    expect(res.items.map((i) => i.source.url)).toEqual([
      "https://example.com/sourdough",
    ]);
    expect(
      (await searchLibrary({ userId: OTHER, q: "sourdough", limit: 10 })).items
    ).toEqual([]);
  });

  it("health counts unread, groups waiting and the oldest wait", async () => {
    const empty = await libraryHealth({ userId: USER });
    expect(empty).toEqual({
      unread: 0,
      groupsWaiting: 0,
      oldestWaitDays: null,
    });
    const r = await keep(["https://example.com/a", "https://example.com/b"]);
    const [a] = r.staged.map((s) => s.itemId);
    await newGroup("Waiting", [a!]);
    await q(
      `update documents set created_at = now() - interval '5 days' where id = $1`,
      [a]
    );
    const health = await libraryHealth({ userId: USER });
    expect(health).toEqual({ unread: 2, groupsWaiting: 1, oldestWaitDays: 5 });
  });
});

describe("relay's needs", () => {
  it("a share split over several calls links ONE note to every item", async () => {
    const first = await keep(["https://example.com/s1"], {
      note: "for the trip",
    });
    const second = await addToLibrary({
      userId: USER,
      request: {
        items: [{ kind: "url", url: "https://example.com/s2" }],
        captureNoteId: first.captureNoteId!,
      },
      deps: { readUrl },
    });
    expect(second.captureNoteId).toBe(first.captureNoteId);
    const page = await listLibraryItems({ userId: USER, input: {} });
    expect(page.items.map((i) => i.captureNoteId)).toEqual([
      first.captureNoteId,
      first.captureNoteId,
    ]);
    expect(await myCaptureIds()).toEqual([first.captureNoteId]);
    const { rows } = await q<{ metadata: any }>(
      `select metadata from documents where id = $1`,
      [first.captureNoteId]
    );
    expect(rows[0]!.metadata.libraryNoteFor.sort()).toEqual(
      [first.staged[0]!.itemId, second.staged[0]!.itemId].sort()
    );
    // Someone else's note is not a door.
    await expect(
      addToLibrary({
        userId: OTHER,
        request: {
          items: [{ kind: "url", url: "https://example.com/s3" }],
          captureNoteId: first.captureNoteId!,
        },
        deps: { readUrl },
      })
    ).rejects.toThrow(/Note not found/);
  });

  it("group counts carry the unrun chips; curate answers with the group views", async () => {
    const r = await keep(["https://example.com/c1", "https://example.com/c2"]);
    const [c1, c2] = r.staged.map((s) => s.itemId);
    await q(
      `update documents set metadata = jsonb_set(metadata, '{importRead}', $2::jsonb) where id = $1`,
      [
        c1,
        JSON.stringify({
          status: "read",
          suggestedActions: [
            {
              id: "date-0",
              kind: "date",
              label: "x",
              value: {},
              confidence: 1,
              source: "rule",
            },
            {
              id: "task-0",
              kind: "task",
              label: "y",
              value: {},
              confidence: 1,
              source: "rule",
              proposalId: "p",
            },
          ],
        }),
      ]
    );
    const res = await curateLibrary({
      userId: USER,
      ops: [{ op: "group.create", name: "Chips", itemIds: [c1!, c2!] }],
    });
    expect(res.groups).toHaveLength(1);
    expect(res.groups[0]).toMatchObject({
      id: res.createdGroupIds[0],
      name: "Chips",
      counts: { items: 2, read: 1, actions: 1 },
    });
  });

  it("groups narrow to a lens", async () => {
    const WS = "00000000-0000-4000-8000-0000000000aa";
    const inWs = await addToLibrary({
      userId: USER,
      request: {
        items: [{ kind: "url", url: "https://example.com/w" }],
        workspaceId: WS,
      },
      deps: { readUrl },
    });
    const out = await keep(["https://example.com/o"]);
    await newGroup("In space", [inWs.staged[0]!.itemId]);
    await newGroup("Elsewhere", [out.staged[0]!.itemId]);
    const all = await readLibraryGroups({ userId: USER });
    expect(all.groups.map((g) => g.name).sort()).toEqual([
      "Elsewhere",
      "In space",
    ]);
    const lensed = await readLibraryGroups({
      userId: USER,
      lens: { workspaceId: WS },
    });
    expect(lensed.groups.map((g) => g.name)).toEqual(["In space"]);
  });
});

describe("rebuild = update mode", () => {
  /** A submit door that files REAL pending proposals, like the pod's. */
  function filingDeps(submitted: SubmitCaptureGraphInput[]) {
    const deps = buildDeps(submitted);
    return {
      ...deps,
      submit: async (input: SubmitCaptureGraphInput) => {
        submitted.push(input);
        const { rows } = await q<{ id: string }>(
          `insert into proposals (status, proposal_type, target_type, target_id, data, subject_user_id)
           values ('pending', 'create', 'entity', gen_random_uuid(), '{}'::jsonb, $1) returning id`,
          [USER]
        );
        return { proposalId: rows[0]!.id, applied: false };
      },
    } satisfies ImportBuildDeps;
  }
  /** Approving a bundle materializes its container; the stamp names it. */
  async function approve(proposalId: string, containerId: string) {
    await q(
      `insert into entities (id, user_id, title, properties) values ($1, $2, 'Reading', '{}'::jsonb)
       on conflict (id) do nothing`,
      [containerId, USER]
    );
    await q(
      `update proposals set status = 'approved', data = $2::jsonb where id = $1`,
      [
        proposalId,
        JSON.stringify({
          materialized: { byOp: { group: { entityId: containerId } } },
        }),
      ]
    );
  }
  async function addTo(groupId: string, url: string) {
    const r = await keep([url]);
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.items", groupId, add: [r.staged[0]!.itemId] }],
    });
  }

  it("reuses the group's container on every rebuild — never a twin; waits while the last bundle is pending", async () => {
    const r = await keep(["https://example.com/r1"]);
    const g = await newGroup("Reading", [r.staged[0]!.itemId]);
    const submitted: SubmitCaptureGraphInput[] = [];
    const deps = filingDeps(submitted);

    const first = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(first.status).toBe("proposed");
    expect(submitted[0]!.entities.map((e) => e.ref)).toContain("group");
    expect(
      (await loadLibraryGroup({ userId: USER, groupId: g })).containerEntityId
    ).toBeNull();

    // A rebuild while the first bundle waits would twin it: refused, claim released.
    await addTo(g, "https://example.com/r2");
    const waiting = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(waiting).toMatchObject({
      status: "refused",
      reason: "previous_build_pending",
    });
    expect(
      (await loadLibraryGroup({ userId: USER, groupId: g })).buildingAt
    ).toBeNull();

    // Approved: the rebuild resolves the container from the stamp, reuses it, records it.
    const container = "00000000-0000-4000-8000-00000000c0c0";
    await approve(first.proposalId!, container);
    const second = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(second.status).toBe("proposed");
    expect(submitted[1]!.entities.map((e) => e.ref)).not.toContain("group");
    expect(JSON.stringify(submitted[1])).toContain(container);
    expect(
      (await loadLibraryGroup({ userId: USER, groupId: g })).containerEntityId
    ).toBe(container);

    // And again: the recorded container, still no twin.
    await approve(second.proposalId!, container);
    await addTo(g, "https://example.com/r3");
    const third = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => deps,
    });
    expect(third.status).toBe("proposed");
    expect(submitted[2]!.entities.map((e) => e.ref)).not.toContain("group");
    expect(JSON.stringify(submitted[2])).toContain(container);
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from entities`
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe("what a rebuild reads — per item, per group, from the bundle's status", () => {
  async function groupOf(urls: string[], name = "Shelf") {
    const r = await keep(urls);
    const ids = r.staged.map((s) => s.itemId);
    return { g: await newGroup(name, ids), ids };
  }
  const waiting = async (g: string) =>
    (await readLibraryGroups({ userId: USER })).groups.find((x) => x.id === g)!
      .counts.newSinceBuilt;

  it("an OLD item that joins a built group waits, and the next build reads it", async () => {
    const early = await keep(["https://example.com/kept-long-ago"]);
    const { g, ids } = await groupOf(["https://example.com/a"]);
    const submitted: SubmitCaptureGraphInput[] = [];
    await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => buildDeps(submitted),
    });
    expect(await waiting(g)).toBe(0);
    // Kept BEFORE the build, joins after: created_at < built_at.
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.items", groupId: g, add: [early.staged[0]!.itemId] }],
    });
    expect(await waiting(g)).toBe(1);
    expect((await libraryHealth({ userId: USER })).groupsWaiting).toBe(1);
    const again = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => buildDeps(submitted),
    });
    expect(again.status).toBe("proposed");
    expect(submitted[1]!.sourceDocumentIds).toEqual([early.staged[0]!.itemId]);
    expect(ids).toHaveLength(1);
  });

  for (const status of ["rejected", "reverted"] as const) {
    it(`a ${status} bundle leaves its items unbuilt — the next build reads them again`, async () => {
      const { g, ids } = await groupOf([
        "https://example.com/x",
        "https://example.com/y",
      ]);
      const submitted: SubmitCaptureGraphInput[] = [];
      const first = await buildLibraryGroup({
        userId: USER,
        groupId: g,
        depsFor: () => buildDeps(submitted),
      });
      expect(await waiting(g)).toBe(0);
      await q(`update proposals set status = $2 where id = $1`, [
        first.proposalId,
        status,
      ]);
      expect(await waiting(g)).toBe(2);
      const again = await buildLibraryGroup({
        userId: USER,
        groupId: g,
        depsFor: () => buildDeps(submitted),
      });
      expect(again.status).toBe("proposed");
      expect([...submitted[1]!.sourceDocumentIds!].sort()).toEqual(
        [...ids].sort()
      );
    });
  }

  it("an item added to the group WHILE a build runs is not stranded", async () => {
    const late = await keep(["https://example.com/late"]);
    const { g, ids } = await groupOf(["https://example.com/m"]);
    const submitted: SubmitCaptureGraphInput[] = [];
    const deps = buildDeps(submitted);
    const racing: ImportBuildDeps = {
      ...deps,
      submit: async (input) => {
        // The person drops another item into the group mid-build.
        await curateLibrary({
          userId: USER,
          ops: [
            { op: "group.items", groupId: g, add: [late.staged[0]!.itemId] },
          ],
        });
        return deps.submit(input);
      },
    };
    await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => racing,
    });
    expect(submitted[0]!.sourceDocumentIds).toEqual(ids);
    expect(await waiting(g)).toBe(1);
    await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => buildDeps(submitted),
    });
    expect(submitted[1]!.sourceDocumentIds).toEqual([late.staged[0]!.itemId]);
  });

  it('a group whose last bundle waits names it ("Open the review"), and the refusal does too', async () => {
    const { g } = await groupOf(["https://example.com/p"]);
    const submitted: SubmitCaptureGraphInput[] = [];
    const pending: ImportBuildDeps = {
      ...buildDeps(submitted),
      submit: async (input) => {
        submitted.push(input);
        const { rows } = await q<{ id: string }>(
          `insert into proposals (status, proposal_type, target_type, target_id, data, subject_user_id)
           values ('pending', 'create', 'entity', gen_random_uuid(), '{}'::jsonb, $1) returning id`,
          [USER]
        );
        return { proposalId: rows[0]!.id, applied: false };
      },
    };
    const first = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => pending,
    });
    const view = (await readLibraryGroups({ userId: USER })).groups.find(
      (x) => x.id === g
    )!;
    expect(view.pendingBuildProposalId).toBe(first.proposalId);
    await addTo(g);
    const refusedNow = await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => pending,
    });
    expect(refusedNow).toMatchObject({
      status: "refused",
      reason: "previous_build_pending",
      proposalId: first.proposalId,
    });
    async function addTo(groupId: string) {
      const r = await keep(["https://example.com/p2"]);
      await curateLibrary({
        userId: USER,
        ops: [{ op: "group.items", groupId, add: [r.staged[0]!.itemId] }],
      });
    }
  });
});

describe("hardening", () => {
  it("a forged cursor is BAD_REQUEST, never a database error", async () => {
    const forge = (c: unknown, i: unknown) =>
      Buffer.from(JSON.stringify({ c, i })).toString("base64url");
    for (const cursor of [
      forge("2026-10-13 10:00:00.123+00", "not-a-uuid"),
      forge("2026-02-30 10:00:00+00", "00000000-0000-4000-8000-000000000001"),
      forge("yesterday", "00000000-0000-4000-8000-000000000001"),
      "%%%",
    ]) {
      await expect(
        listLibraryItems({ userId: USER, input: { cursor } })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });

  it("a key taken between the read and the insert takes the next suffix, never a 500", async () => {
    // PGlite runs one statement at a time, so the race is staged: the first
    // read of taken keys is STALE (empty) while "films" already exists.
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.create", name: "Films" }],
    });
    let stale = true;
    const racing = new Proxy(db, {
      get(target, prop) {
        if (prop === "select" && stale) {
          stale = false;
          return () => ({ from: () => ({ where: async () => [] }) });
        }
        const v = (target as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === "function"
          ? (v as (...args: unknown[]) => unknown).bind(target)
          : v;
      },
    }) as typeof db;
    const row = await insertLibraryGroup({
      database: racing,
      userId: USER,
      name: "Films",
      origin: "user",
    });
    expect(stale).toBe(false);
    expect(row.key).toBe("films-2");
  });

  it("adopting an import group that was built marks its items built — no twin rebuild", async () => {
    const { sessionId } = await openImportSession({
      userId: USER,
      origin: "relay",
    });
    const session = await loadImportSession({ userId: USER, sessionId });
    const staged = await stageImportItems({
      userId: USER,
      session,
      items: [{ kind: "url", url: "https://example.com/built-before" }],
      deps: { readUrl },
    });
    await curateImport({
      userId: USER,
      sessionId,
      ops: [
        {
          op: "createGroup",
          name: "Done",
          itemIds: staged.staged.map((s) => s.itemId),
        },
      ],
    });
    // The import's own Build ran: marker cleared, group stamped built.
    await q(
      `update documents set metadata = metadata #- '{intakeSource,pending}' where id = $1`,
      [staged.staged[0]!.itemId]
    );
    await q(
      `update focus_sessions set metadata = jsonb_set(metadata, '{importCuration,groups,0,builtAt}', to_jsonb(now()::text)) where id = $1`,
      [sessionId]
    );
    const { groups } = await readLibraryGroups({ userId: USER });
    expect(groups[0]!.name).toBe("Done");
    expect(groups[0]!.counts.newSinceBuilt).toBe(0);
  });
});

describe("adoption is not a scan on every read", () => {
  it("once clean, reads skip the scan until an import's curation is written again", async () => {
    const { sessionId } = await openImportSession({
      userId: USER,
      origin: "relay",
    });
    const session = await loadImportSession({ userId: USER, sessionId });
    const staged = await stageImportItems({
      userId: USER,
      session,
      items: [{ kind: "url", url: "https://example.com/memo" }],
      deps: { readUrl },
    });
    await curateImport({
      userId: USER,
      sessionId,
      ops: [
        {
          op: "createGroup",
          name: "First",
          itemIds: staged.staged.map((s) => s.itemId),
        },
      ],
    });
    expect(
      (await readLibraryGroups({ userId: USER })).groups.map((g) => g.name)
    ).toEqual(["First"]);
    // A group appears WITHOUT the one curation writer: the memo says clean,
    // so the read does not scan for it (proof the scan is skipped).
    await q(
      `update focus_sessions set metadata = jsonb_set(metadata, '{importCuration,groups}',
         (metadata -> 'importCuration' -> 'groups') || '[{"key":"sneaky","name":"Sneaky","origin":"user","outputs":[]}]'::jsonb) where id = $1`,
      [sessionId]
    );
    expect(
      (await readLibraryGroups({ userId: USER })).groups.map((g) => g.name)
    ).toEqual(["First"]);
    // The writer marks the person dirty: the next read adopts.
    await curateImport({
      userId: USER,
      sessionId,
      ops: [{ op: "renameGroup", groupKey: "sneaky", name: "Sneaky one" }],
    });
    expect(
      (await readLibraryGroups({ userId: USER })).groups
        .map((g) => g.name)
        .sort()
    ).toEqual(["First", "Sneaky one"]);
  });
});

describe("lifecycle (review 40/42/43)", () => {
  it("a reused run re-checks the space's write gate: access removed mid-day stops the next keep", async () => {
    const WS = "00000000-0000-4000-8000-0000000000bb";
    const keepIn = () =>
      addToLibrary({
        userId: USER,
        request: {
          items: [{ kind: "url", url: `https://example.com/${Math.random()}` }],
          workspaceId: WS,
        },
        deps: { readUrl },
      });
    const first = await keepIn();
    h.deniedSpaces.add(WS);
    try {
      await expect(keepIn()).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      h.deniedSpaces.delete(WS);
    }
    const again = await keepIn();
    expect(again.runId).toBe(first.runId);
  });

  it("delete hides an item, restore brings it back; an item a bundle was built from cannot be deleted", async () => {
    const r = await keep([
      "https://example.com/del",
      "https://example.com/cited",
    ]);
    const [del, cited] = r.staged.map((s) => s.itemId) as [string, string];
    const g = await newGroup("Cited", [cited]);
    await buildLibraryGroup({
      userId: USER,
      groupId: g,
      depsFor: () => buildDeps([]),
    });
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.delete", itemIds: [del] }],
    });
    const ids = async () =>
      (await listLibraryItems({ userId: USER, input: {} })).items
        .map((i) => i.id)
        .sort();
    expect(await ids()).toEqual([cited]);
    expect(
      (await searchLibrary({ userId: USER, q: "del", limit: 10 })).items
    ).toEqual([]);
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.restore", itemIds: [del] }],
    });
    expect(await ids()).toEqual([cited, del].sort());
    await expect(
      curateLibrary({
        userId: USER,
        ops: [{ op: "item.delete", itemIds: [cited] }],
      })
    ).rejects.toThrow(/source of something you built/);
    // Past the undo window a deleted item is gone for good.
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.delete", itemIds: [del] }],
    });
    await q(
      `update documents set deleted_at = now() - interval '31 days' where id = $1`,
      [del]
    );
    await expect(
      curateLibrary({
        userId: USER,
        ops: [{ op: "item.restore", itemIds: [del] }],
      })
    ).rejects.toThrow(/no item/);
  });

  it("seen, note, grouping and re-keep restart the auto-archive clock; group.unarchive brings a group back", async () => {
    const r = await keep(["https://example.com/clock"]);
    const id = r.staged[0]!.itemId;
    const seenAt = async () => {
      const { rows } = await q<{ s: string | null }>(
        `select metadata #>> '{importCuration,seenAt}' as s from documents where id = $1`,
        [id]
      );
      return rows[0]!.s;
    };
    const reset = () =>
      q(
        `update documents set metadata = metadata #- '{importCuration,seenAt}' where id = $1`,
        [id]
      );
    for (const ops of [
      [{ op: "item.seen", itemIds: [id] }],
      [{ op: "item.note", itemId: id, note: "later" }],
    ] as const) {
      await reset();
      await curateLibrary({ userId: USER, ops: ops as never });
      expect(await seenAt()).toBeTruthy();
    }
    await reset();
    const g = await newGroup("Clock", [id]);
    expect(await seenAt()).toBeTruthy();
    await reset();
    await keep(["https://example.com/clock"]);
    expect(await seenAt()).toBeTruthy();
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.archive", groupId: g }],
    });
    await curateLibrary({
      userId: USER,
      ops: [{ op: "group.unarchive", groupId: g }],
    });
    expect(
      (await loadLibraryGroup({ userId: USER, groupId: g })).archivedAt
    ).toBeNull();
  });

  it("a merge keeps BOTH notes and both outputs; group.create respects the group cap", async () => {
    const a = await newGroup("A", [], "keep the recipes");
    const b = await newGroup("B", [], "only vegetarian");
    await curateLibrary({
      userId: USER,
      ops: [
        { op: "group.update", groupId: b, outputs: ["things", "list"] },
        { op: "group.merge", fromId: b, intoId: a },
      ],
    });
    const into = await loadLibraryGroup({ userId: USER, groupId: a });
    expect(into.note).toBe("keep the recipes\n\nonly vegetarian");
    expect(into.outputs).toEqual(["things", "list"]);
    const { IMPORT_LIMITS } = await import("@synap-core/types/imports");
    await expect(
      curateLibrary({
        userId: USER,
        ops: Array.from({ length: IMPORT_LIMITS.groupsMax }, (_, i) => ({
          op: "group.create" as const,
          name: `G${i}`,
        })),
      })
    ).rejects.toThrow(/at most 40 groups/);
  });
});

describe("a Library run is not a batch to discard", () => {
  it("discardImport refuses a Library run and leaves its items kept", async () => {
    const { discardImport } = await import("../../imports/discard.js");
    const r = await keep([
      "https://example.com/kept-1",
      "https://example.com/kept-2",
    ]);
    await expect(
      discardImport({
        userId: USER,
        sessionId: r.runId,
        closeSession: async () => undefined,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(
      (await listLibraryItems({ userId: USER, input: {} })).items
    ).toHaveLength(2);
  });
});

describe("search rows follow the Library", () => {
  it("regrouping re-indexes the item (its row names its first group); delete removes it; restore brings it back", async () => {
    const r = await keep(["https://example.com/search-row"]);
    const id = r.staged[0]!.itemId;
    h.searchJobs.length = 0;
    await newGroup("Search", [id]);
    expect(h.searchJobs).toContainEqual({
      operation: "upsert",
      documentId: id,
    });
    h.searchJobs.length = 0;
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.delete", itemIds: [id] }],
    });
    expect(h.searchJobs).toEqual([{ operation: "delete", documentId: id }]);
    h.searchJobs.length = 0;
    await curateLibrary({
      userId: USER,
      ops: [{ op: "item.restore", itemIds: [id] }],
    });
    expect(h.searchJobs).toEqual([{ operation: "upsert", documentId: id }]);
  });
});

describe("an agent PROPOSES Library organisation; approval applies it through the same code", () => {
  const AGENT = "agent-org-1";
  type GateOpts = Record<string, unknown> & { data: Record<string, unknown> };
  function recordingGate() {
    const calls: GateOpts[] = [];
    const gate = (async (opts: GateOpts) => {
      calls.push(opts);
      return {
        granted: false,
        proposalId: "11111111-2222-4333-8444-555555555555",
        proposalType: "organize",
        summary: "",
        reasoning: "",
        reviewPath: "/open/p",
        reviewUrl: "https://pod.test/open/p",
      };
    }) as never;
    return { gate, calls };
  }
  const groupCount = async () =>
    (await q<{ n: number }>(`select count(*)::int as n from library_groups`))
      .rows[0]!.n;

  /** Store the proposal the gate would have filed, then approve it for real. */
  async function approveStored(data: Record<string, unknown>) {
    const id = crypto.randomUUID();
    const stored = {
      requestId: id,
      targetType: "library",
      changeType: "organize",
      data,
    };
    await q(
      `insert into proposals (id, target_type, target_id, proposal_type, status, data, subject_user_id, agent_user_id)
       values ($1, 'library', $5, 'organize', 'pending', $2::jsonb, $3, $4)`,
      [id, JSON.stringify(stored), USER, AGENT, USER]
    );
    const { approveLibraryOrganize } =
      await import("../../../routers/proposals/executors/library.js");
    const res = await approveLibraryOrganize({
      proposal: {
        id,
        targetType: "library",
        targetId: id,
        proposalType: "organize",
        workspaceId: null,
        agentUserId: AGENT,
        subjectUserId: USER,
        data: stored,
      },
      payload: stored,
      userId: USER,
      input: { proposalId: id },
      ctx: {},
      deps: {
        reportProposalOutcome: () => undefined,
        emitProposalReviewed: () => undefined,
      },
    } as never);
    const status = (
      await q<{ status: string }>(
        `select status from proposals where id = $1`,
        [id]
      )
    ).rows[0]!.status;
    return { res, status };
  }

  it("files ONE governed proposal (forcePropose, library/organize) and changes NOTHING; approval creates the group with its items", async () => {
    const kept = await keep(["https://example.com/a", "https://example.com/b"]);
    const ids = kept.staged.map((s) => s.itemId);
    const { gate, calls } = recordingGate();
    const res = await proposeLibraryOrganize({
      userId: USER,
      caller: { agentUserId: AGENT },
      ops: [
        {
          op: "group.create",
          name: "Reading list",
          note: "Weekend",
          itemIds: ids,
        },
      ],
      reasoning: "Two articles on the same topic",
      gate,
    });
    expect(res).toEqual({
      status: "proposed",
      proposalId: "11111111-2222-4333-8444-555555555555",
      reviewUrl: "https://pod.test/open/p",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      userId: USER,
      agentUserId: AGENT,
      subjectType: "library",
      action: "organize",
      forcePropose: true,
      source: "intelligence",
      reasoning: "Two articles on the same topic",
    });
    const data = calls[0]!.data;
    expect(data.items).toHaveLength(2);
    expect(data.summary).toBe('Create group "Reading list" with 2 items');
    expect(buildProposalSummary("library", "organize", data)).toBe(
      'Organize Library: Create group "Reading list" with 2 items'
    );
    // Nothing applied before approval.
    expect(await groupCount()).toBe(0);

    const { res: applied, status } = await approveStored(data);
    expect(status).toBe("approved");
    expect(applied).toMatchObject({
      success: true,
      effect: { applied: "verified", subject: "library_groups" },
    });
    const { groups } = await readLibraryGroups({ userId: USER });
    expect(groups.map((g) => [g.name, g.note, g.counts.items])).toEqual([
      ["Reading list", "Weekend", 2],
    ]);
  });

  it("group.items / group.update (note) on an existing group apply through curate on approval", async () => {
    const kept = await keep(["https://example.com/c", "https://example.com/d"]);
    const [c, d] = kept.staged.map((s) => s.itemId) as [string, string];
    const groupId = await newGroup("Recipes", [c]);
    const { gate, calls } = recordingGate();
    await proposeLibraryOrganize({
      userId: USER,
      caller: { keyType: "is_internal" },
      ops: [
        { op: "group.items", groupId, add: [d], remove: [c] },
        { op: "group.update", groupId, note: "Only mains" },
      ],
      gate,
    });
    expect(calls[0]!.data.summary).toBe(
      'Add 1 item to "Recipes", Remove 1 item from "Recipes"; Update group "Recipes": set its note'
    );
    const before = (await readLibraryGroups({ userId: USER })).groups[0]!;
    expect(before.note ?? null).toBeNull();
    await approveStored(calls[0]!.data);
    const { items } = await listLibraryItems({
      userId: USER,
      input: { groupId },
    });
    expect(items.map((i) => i.id)).toEqual([d]);
    expect((await readLibraryGroups({ userId: USER })).groups[0]!.note).toBe(
      "Only mains"
    );
  });

  it("a build request runs the SAME Build on approval (its bundle goes to review as always)", async () => {
    const kept = await keep(["https://example.com/e"]);
    const groupId = await newGroup(
      "To build",
      kept.staged.map((s) => s.itemId)
    );
    const submitted: SubmitCaptureGraphInput[] = [];
    const out = await applyLibraryOrganize({
      ownerUserId: USER,
      ops: [{ op: "group.build", groupId }],
      depsFor: () => buildDeps(submitted),
    });
    expect(out.curate).toBeNull();
    expect(out.builds).toHaveLength(1);
    expect(out.builds[0]!.result.status).toBe("proposed");
    expect(submitted).toHaveLength(1);
  });

  it("refuses: a person (they organise directly), a group or item that is not theirs; the gate is never asked", async () => {
    const theirs = await keep(["https://example.com/x"], { userId: OTHER });
    const { gate, calls } = recordingGate();
    await expect(
      proposeLibraryOrganize({
        userId: USER,
        caller: {},
        ops: [{ op: "group.create", name: "Mine" }],
        gate,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      proposeLibraryOrganize({
        userId: USER,
        caller: { agentUserId: AGENT },
        ops: [
          {
            op: "group.create",
            name: "Steal",
            itemIds: [theirs.staged[0]!.itemId],
          },
        ],
        gate,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      proposeLibraryOrganize({
        userId: USER,
        caller: { agentUserId: AGENT },
        ops: [{ op: "group.build", groupId: crypto.randomUUID() }],
        gate,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toEqual([]);
  });

  it("a gate that would EXECUTE for an agent is refused, never applied", async () => {
    await expect(
      proposeLibraryOrganize({
        userId: USER,
        caller: { agentUserId: AGENT },
        ops: [{ op: "group.create", name: "Auto" }],
        gate: (async () => ({ granted: true })) as never,
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await groupCount()).toBe(0);
  });
});
