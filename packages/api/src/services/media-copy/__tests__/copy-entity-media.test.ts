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
  deleteBody: vi.fn(async (_p: { documentId: string }) => undefined),
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
    eventRepository: {},
    EntityBodyService: class {
      deleteBody = state.deleteBody;
    },
  };
});
vi.mock("../../../routers/file-upload.js", () => ({
  storeDocumentFromBuffer: vi.fn(),
}));
// The three pipes a copy must NOT go through (they feed the reactor back), and
// the one it must: the realtime bridge for direct writes.
const pipes = vi.hoisted(() => ({
  realtime: vi.fn(),
  sideEffects: vi.fn(async (_payload: unknown) => undefined),
  auditLog: vi.fn(async () => null),
}));
vi.mock("../../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: pipes.realtime,
}));
vi.mock("@synap/events", () => ({
  registerReactor: vi.fn(),
  emitSideEffects: pipes.sideEffects,
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: pipes.auditLog }));

import { runEntityMediaCopy } from "../copy-entity-media.js";
import { entityMediaCopyReactor } from "../media-copy-reactor.js";

const IMG = "https://cdn.test/a.png";
const PAGE = "https://cdn.test/page";
const BROKEN = "https://cdn.test/not-an-image";

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
  state.deleteBody.mockClear();
  pipes.realtime.mockClear();
  pipes.sideEffects.mockClear();
  pipes.auditLog.mockClear();
});

describe("runEntityMediaCopy", () => {
  it("copies an image, records a refusal, and never fetches a link's page", async () => {
    state.row = entityRow({
      properties: { url: PAGE, "media-urls": [IMG, BROKEN] },
    });
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
    // The link's declared `url` is the page it links to: never requested.
    expect(fetchImage.mock.calls.map((c) => c[0])).toEqual([IMG, BROKEN]);
    expect(store).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        workspaceId: "w1",
        mimeType: "image/png",
        filename: "a.png",
        // A background copy is the pod's, never a human upload.
        storedBySystem: true,
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
        sourceUrl: BROKEN,
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

describe("after a copy: clients refetch, the reactor never re-fires", () => {
  const okImage = vi.fn(async () => ({
    ok: true as const,
    bytes: Buffer.from([1]),
    mime: "image/png" as const,
  }));

  it("announces ONE realtime entity:updated and nothing through the event store or the fan-out", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = { systemData: {} };
    const store = vi.fn(async () => ({ documentId: "doc-1" })) as never;

    await runEntityMediaCopy(
      { entityId: "e1" },
      { fetchImage: okImage, store }
    );

    expect(pipes.realtime).toHaveBeenCalledTimes(1);
    expect(pipes.realtime).toHaveBeenCalledWith({
      eventType: "entity.update.completed",
      subjectId: "e1",
      userId: "u1",
      data: { entityId: "e1", workspaceId: "w1" },
    });
    // The loop: the media-copy reactor listens on the side-effect fan-out for
    // entity.update. Nothing the copy does may reach it — nor the event log
    // (whose `.completed` rows feed automations and the timeline).
    const reachedReactor = pipes.sideEffects.mock.calls.some(([payload]) =>
      entityMediaCopyReactor.match!(payload as never)
    );
    expect(reachedReactor).toBe(false);
    expect(pipes.sideEffects).not.toHaveBeenCalled();
    expect(pipes.auditLog).not.toHaveBeenCalled();
  });

  it("a pod-wide entity is announced to its owner's room (no workspaceId)", async () => {
    state.row = entityRow({
      workspaceId: null,
      properties: { "media-urls": [IMG] },
      uiHints: {},
    });
    state.locked = { systemData: {} };
    await runEntityMediaCopy(
      { entityId: "e1" },
      {
        fetchImage: okImage,
        store: vi.fn(async () => ({ documentId: "d" })) as never,
      }
    );
    expect(pipes.realtime).toHaveBeenCalledWith(
      expect.objectContaining({ data: { entityId: "e1" } })
    );
  });

  it("a run that copied nothing announces nothing", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = { systemData: {} };
    await runEntityMediaCopy(
      { entityId: "e1" },
      {
        fetchImage: vi.fn(async () => ({
          ok: false as const,
          reason: "not_image" as const,
        })),
      }
    );
    expect(pipes.realtime).not.toHaveBeenCalled();
  });
});

describe("a stored copy the entity does not hold is discarded (no orphan blob)", () => {
  const okImage = vi.fn(async () => ({
    ok: true as const,
    bytes: Buffer.from([1]),
    mime: "image/png" as const,
  }));
  const storeAs = (documentId: string) =>
    vi.fn(async () => ({ documentId })) as never;

  it("a recorded copy is kept", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = { systemData: {} };
    const discard = vi.fn(async () => undefined);
    const r = await runEntityMediaCopy(
      { entityId: "e1" },
      { fetchImage: okImage, store: storeAs("doc-new"), discard }
    );
    expect(r).toMatchObject({ copied: 1 });
    expect(discard).not.toHaveBeenCalled();
  });

  it("a concurrent run recorded the same sourceUrl first: this run's blob is discarded", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = {
      systemData: {
        media: [
          {
            documentId: "doc-winner",
            mime: "image/png",
            bytes: 1,
            sourceUrl: IMG,
            copiedAt: "t",
          },
        ],
      },
    };
    const discard = vi.fn(async () => undefined);
    const r = await runEntityMediaCopy(
      { entityId: "e1" },
      { fetchImage: okImage, store: storeAs("doc-loser"), discard }
    );
    expect(discard).toHaveBeenCalledWith("doc-loser");
    expect(r).toMatchObject({ copied: 0 });
    expect(pipes.realtime).not.toHaveBeenCalled();
  });

  it("the entity vanished before the record: the blob is discarded", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = undefined;
    const discard = vi.fn(async () => undefined);
    await runEntityMediaCopy(
      { entityId: "e1" },
      { fetchImage: okImage, store: storeAs("doc-x"), discard }
    );
    expect(discard).toHaveBeenCalledWith("doc-x");
  });

  it("a failed record discards the blob and still fails the run", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = { systemData: {} };
    const discard = vi.fn(async () => undefined);
    const realSets = state.sets;
    state.sets = {
      push: () => {
        throw new Error("write failed");
      },
    } as never;
    await expect(
      runEntityMediaCopy(
        { entityId: "e1" },
        { fetchImage: okImage, store: storeAs("doc-y"), discard }
      )
    ).rejects.toThrow("write failed");
    state.sets = realSets;
    expect(discard).toHaveBeenCalledWith("doc-y");
  });

  it("the default discard is the body door's deleteBody", async () => {
    state.row = entityRow({ properties: { "media-urls": [IMG] }, uiHints: {} });
    state.locked = undefined;
    await runEntityMediaCopy(
      { entityId: "e1" },
      { fetchImage: okImage, store: storeAs("doc-z") }
    );
    expect(state.deleteBody).toHaveBeenCalledWith({ documentId: "doc-z" });
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
