/**
 * `import.*` over tRPC — an import run IS a Library run (review 42 S1), so
 * every WRITE (stage, group, curate, attachFile, build, discard) refuses an
 * agent key or the IS internal key BEFORE any service runs; reads stay open.
 * The services are stubbed to record that they ran (own pglite suites).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const ran: string[] = [];
  const mark =
    (name: string, value: unknown = {}) =>
    async () => {
      ran.push(name);
      return value;
    };
  return { ran, mark };
});

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../services/imports/session.js", () => ({
  assertImportOpen: () => undefined,
  listOpenImportSessions: async () => {
    h.ran.push("list");
    return [];
  },
  loadImportSession: async () => ({
    id: "s",
    workspaceId: null,
    curation: { groups: [] },
  }),
  openImportSession: h.mark("open", { sessionId: "s" }),
}));
vi.mock("../services/imports/read-model.js", () => ({
  buildImportView: async () => ({}),
  countImportItems: async () => ({}),
}));
vi.mock("../services/imports/stage.js", () => ({
  stageImportItems: h.mark("stage", { staged: [], refused: [] }),
}));
vi.mock("../services/imports/group.js", () => ({
  groupImport: h.mark("group", {}),
}));
vi.mock("../services/imports/curate.js", () => ({
  curateImport: h.mark("curate"),
}));
vi.mock("../services/imports/attach.js", () => ({
  attachImportItemFile: h.mark("attach"),
}));
vi.mock("../services/imports/build.js", () => ({
  buildImportGroup: h.mark("build", {
    status: "proposed",
    read: 0,
    skipped: [],
  }),
  defaultImportBuildDeps: () => ({}),
}));
vi.mock("../services/imports/discard.js", () => ({
  discardImport: h.mark("discard", { discarded: 0 }),
}));

import { importRouter } from "./import.js";
import type { Context } from "../types/context.js";

const S = "00000000-0000-4000-8000-000000000001";
const caller = (extra: Record<string, unknown> = {}) =>
  importRouter.createCaller({
    authenticated: true,
    userId: "person-1",
    workspaceId: null,
    ...extra,
  } as unknown as Context);

const writes = (c: ReturnType<typeof caller>) => ({
  stage: () =>
    c.stage({ items: [{ kind: "url", url: "https://example.com" }] }),
  group: () => c.group({ sessionId: S }),
  curate: () =>
    c.curate({
      sessionId: S,
      ops: [{ op: "setDecision", itemIds: [S], decision: "keep" }],
    }),
  attachFile: () =>
    c.attachFile({
      sessionId: S,
      itemId: S,
      filename: "a.mp4",
      mimeType: "video/mp4",
      documentId: S,
    }),
  build: () => c.build({ sessionId: S, groupKey: "g" }),
  discard: () => c.discard({ sessionId: S }),
});

beforeEach(() => {
  h.ran.length = 0;
});

describe("import.* refuses an agent on every write", () => {
  for (const [who, extra] of [
    ["an agent key", { agentUserId: "agent-1" }],
    ["the IS internal key", { keyType: "is_internal" }],
  ] as const) {
    it(`${who}: stage, group, curate, attachFile, build, discard are FORBIDDEN; nothing ran`, async () => {
      for (const [name, call] of Object.entries(writes(caller(extra)))) {
        await expect(call(), name).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(h.ran).toEqual([]);
    });
  }

  it("a person reaches every write; list stays open to an agent", async () => {
    for (const call of Object.values(writes(caller()))) await call();
    expect(h.ran).toEqual(
      expect.arrayContaining([
        "stage",
        "group",
        "curate",
        "attach",
        "build",
        "discard",
      ])
    );
    h.ran.length = 0;
    await caller({ agentUserId: "agent-1" }).list({ limit: 5 });
    expect(h.ran).toEqual(["list"]);
  });
});
