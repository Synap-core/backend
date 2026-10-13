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
}));

vi.mock("../../../utils/workspace-write-access.js", () => ({
  assertWorkspaceWrite: async () => undefined,
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
import { loadLibraryGroup, readLibraryGroups } from "../groups.js";
import { libraryHealth, searchLibrary } from "../search.js";
import { buildLibraryGroup, readNowLibraryItem } from "../build.js";

const USER = "user-library-1";
const OTHER = "user-library-2";

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const readUrl = async (url: string) => ({
  kind: "read" as const,
  title: `Title of ${new URL(url).pathname.slice(1) || url}`,
  author: "Ada",
  text: "Preview text",
  imageUrl: null,
  sourceUrl: url,
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
  let n = 0;
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
    readUrl,
    readBytes: async (key) => h.objects.get(key) ?? Buffer.alloc(0),
    submit: async (input) => {
      submitted.push(input);
      n += 1;
      return {
        proposalId: `11111111-1111-4111-8111-00000000000${n}`,
        applied: false,
      };
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
    ])
  );
});
beforeEach(async () => {
  h.objects.clear();
  await h.client!.exec(
    `delete from document_versions; delete from documents; delete from focus_sessions; delete from proposals; delete from library_groups; delete from entities;`
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

  it("Read now is one item at a time", async () => {
    await expect(
      addToLibrary({
        userId: USER,
        request: {
          items: [
            { kind: "url", url: "https://example.com/1" },
            { kind: "url", url: "https://example.com/2" },
          ],
          readNow: true,
        },
        deps: { readUrl },
      })
    ).rejects.toThrow(/one item at a time/);
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
