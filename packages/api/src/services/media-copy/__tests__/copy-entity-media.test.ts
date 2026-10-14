/**
 * The runner end to end against a scripted database: plan from the REAL row
 * shape (properties + systemData + the profile's uiHints), fetch (injected),
 * store (injected — the documents-row door, no entity), and the systemData
 * write-back. Also the reactor: the trigger fires only on an APPLIED entity
 * write, never on a proposal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  locked: undefined as Record<string, unknown> | undefined,
  sets: [] as unknown[],
}));

vi.mock("@synap/database", () => {
  const chain = (result: () => unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "leftJoin", "where"]) c[m] = () => c;
    c.limit = async () => result();
    c.for = async () => result();
    return c;
  };
  const tx = {
    select: () => chain(() => (state.locked ? [state.locked] : [])),
    update: () => ({
      set: (v: unknown) => {
        state.sets.push(v);
        return { where: async () => undefined };
      },
    }),
  };
  return {
    db: {
      select: () => chain(() => (state.row ? [state.row] : [])),
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    },
    eq: () => ({}),
    and: () => ({}),
    isNull: () => ({}),
    drizzleSql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      sql: strings.join("?"),
      values,
    }),
    entities: { systemData: "entities.system_data" },
    profiles: {},
  };
});
vi.mock("../../../routers/file-upload.js", () => ({
  storeDocumentFromBuffer: vi.fn(),
}));

import { runEntityMediaCopy } from "../copy-entity-media.js";
import { entityMediaCopyReactor } from "../media-copy-reactor.js";

const IMG = "https://cdn.test/a.png";
const PAGE = "https://cdn.test/page";

function entityRow(over: Record<string, unknown> = {}) {
  return {
    id: "e1",
    userId: "u1",
    workspaceId: "w1",
    title: "Post",
    properties: { url: PAGE, "media-urls": [IMG] },
    systemData: { other: "kept" },
    uiHints: {
      presentation: { family: "link", media: { source: { property: "url" } } },
    },
    ...over,
  };
}

beforeEach(() => {
  state.row = undefined;
  state.locked = undefined;
  state.sets = [];
});

describe("runEntityMediaCopy", () => {
  it("copies an image, records it on systemData.media, records the page as not_image", async () => {
    state.row = entityRow();
    state.locked = { systemData: { other: "kept" } };
    const fetchImage = vi.fn(async (url: string) =>
      url === IMG
        ? {
            ok: true as const,
            bytes: Buffer.from([1, 2, 3]),
            mime: "image/png" as const,
            width: 4,
            height: 2,
          }
        : { ok: false as const, reason: "not_image" as const }
    );
    const store = vi.fn(async () => ({ documentId: "doc-1" })) as never;

    const result = await runEntityMediaCopy(
      { entityId: "e1" },
      { fetchImage, store, now: () => new Date("2026-10-13T10:00:00Z") }
    );

    expect(result).toEqual({ status: "copied", copied: 1, failed: 1 });
    expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([PAGE, IMG]);
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        mimeType: "image/png",
        filename: "a.png",
      })
    );
    const set = state.sets[0] as {
      systemData: { sql: string; values: unknown[] };
    };
    // Two keys jsonb_set onto the CURRENT value — never a whole-object replace.
    expect(set.systemData.sql).toContain("jsonb_set(jsonb_set(COALESCE(");
    expect(set.systemData.sql).toContain("'{media}'");
    expect(set.systemData.sql).toContain("'{mediaCopyFailures}'");
    const [, media, failures] = set.systemData.values as [
      unknown,
      string,
      string,
    ];
    expect(JSON.parse(media)).toEqual([
      {
        documentId: "doc-1",
        mime: "image/png",
        bytes: 3,
        sourceUrl: IMG,
        width: 4,
        height: 2,
        copiedAt: "2026-10-13T10:00:00.000Z",
      },
    ]);
    expect(JSON.parse(failures)).toEqual([
      {
        sourceUrl: PAGE,
        reason: "not_image",
        attempts: 1,
        lastAttemptAt: "2026-10-13T10:00:00.000Z",
      },
    ]);
  });

  it("is idempotent: an already-copied sourceUrl is not fetched again", async () => {
    state.row = entityRow({
      properties: { "media-urls": [IMG] },
      uiHints: {},
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
    });
    const fetchImage = vi.fn();
    expect(
      await runEntityMediaCopy({ entityId: "e1" }, { fetchImage })
    ).toMatchObject({ status: "skipped" });
    expect(fetchImage).not.toHaveBeenCalled();
    expect(state.sets).toHaveLength(0);
  });

  it("a kind with no presentation and no media-urls is untouched", async () => {
    state.row = entityRow({ properties: { url: PAGE }, uiHints: {} });
    const fetchImage = vi.fn();
    expect(
      await runEntityMediaCopy({ entityId: "e1" }, { fetchImage })
    ).toMatchObject({ status: "skipped" });
    expect(fetchImage).not.toHaveBeenCalled();
  });

  it("an entity that does not exist (deleted, or never applied) fetches nothing", async () => {
    const fetchImage = vi.fn();
    expect(
      await runEntityMediaCopy({ entityId: "gone" }, { fetchImage })
    ).toMatchObject({ status: "skipped" });
    expect(fetchImage).not.toHaveBeenCalled();
  });
});

describe("entityMediaCopyReactor (the trigger)", () => {
  const base = { subjectId: "e1", userId: "u1", workspaceId: "w1" };
  it.each([
    ["entity", "create", true],
    ["entity", "update", true],
    ["entity", "delete", false],
    ["proposal", "created", false],
    ["proposal", "approved", false],
    ["document", "create", false],
  ])("%s.%s → %s", (subjectType, action, fires) => {
    expect(
      entityMediaCopyReactor.match!({ ...base, subjectType, action })
    ).toBe(fires);
  });

  it("enqueues one debounced job per entity", async () => {
    const send = vi.fn(async () => "job");
    await entityMediaCopyReactor.handler(
      { ...base, subjectType: "entity", action: "create" },
      { boss: { send } as never }
    );
    expect(send).toHaveBeenCalledWith(
      "entity-media-copy",
      { entityId: "e1" },
      expect.objectContaining({
        singletonKey: "entity-media-copy:e1",
        singletonNextSlot: true,
      })
    );
  });
});
