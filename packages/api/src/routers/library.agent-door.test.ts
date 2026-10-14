/**
 * `library.*` over tRPC — nothing an agent sends lands in the Library
 * (CAPTURE_LIBRARY_PLAN §1). Every WRITE (add, curate, readNow, build,
 * runAction) refuses an agent key or the IS's internal key BEFORE any service
 * runs — the same rule as the Hub door (`services/library/agent-door.ts`).
 * A person's call reaches the service; reads stay open. A rebuild refused
 * while the last bundle waits is a CONFLICT naming that bundle.
 *
 * Stubbed, and why: the Library services (own pglite suites) record that they
 * ran; the read-only / audit middlewares (own suites) pass through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  ran: [] as string[],
  buildResult: null as unknown,
}));

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../services/library/add.js", () => ({
  addToLibrary: async () => {
    h.ran.push("add");
    return { runId: "r", staged: [], refused: [] };
  },
  startKeptItemReads: async () => undefined,
}));
vi.mock("../services/library/curate.js", () => ({
  curateLibrary: async () => {
    h.ran.push("curate");
    return {
      createdGroupIds: [],
      changedGroupIds: [],
      changedItemIds: [],
      groups: [],
    };
  },
}));
vi.mock("../services/library/build.js", () => ({
  buildLibraryGroup: async () => {
    h.ran.push("build");
    return h.buildResult;
  },
  readNowLibraryItem: async () => {
    h.ran.push("readNow");
    return { status: "proposed", read: 1, skipped: [] };
  },
}));
vi.mock("../services/library/run-action.js", () => ({
  LibraryActionError: class extends Error {},
  runLibraryAction: async () => {
    h.ran.push("runAction");
    return { proposalId: "p", status: "proposed" };
  },
}));
vi.mock("../services/library/groups.js", () => ({
  adoptImportGroups: async () => 0,
  groupViews: async () => ({ views: [], counts: new Map() }),
  loadLibraryGroup: async () => ({}),
  readLibraryGroups: async () => {
    h.ran.push("groups");
    return { groups: [], ungrouped: 0, archived: 0 };
  },
}));

import { LibraryAddInputSchema, libraryRouter } from "./library.js";
import type { Context } from "../types/context.js";

const ID = "00000000-0000-4000-8000-000000000001";

function caller(extra: Record<string, unknown> = {}) {
  return libraryRouter.createCaller({
    authenticated: true,
    userId: "person-1",
    workspaceId: null,
    ...extra,
  } as unknown as Context);
}

const writes = (c: ReturnType<typeof caller>) => ({
  add: () => c.add({ items: [{ kind: "url", url: "https://example.com" }] }),
  curate: () => c.curate({ ops: [{ op: "item.archive", itemIds: [ID] }] }),
  readNow: () => c.readNow({ itemId: ID }),
  build: () => c.build({ groupId: ID }),
  runAction: () => c.runAction({ itemId: ID, actionId: "date-0" }),
});

beforeEach(() => {
  h.ran.length = 0;
  h.buildResult = { status: "proposed", read: 1, skipped: [] };
});

describe("library.* refuses an agent on every write", () => {
  for (const [who, extra] of [
    ["an agent key", { agentUserId: "agent-1" }],
    ["the IS internal key", { keyType: "is_internal" }],
  ] as const) {
    it(`${who}: add, curate, readNow, build and runAction are FORBIDDEN, and nothing ran`, async () => {
      const doors = writes(caller(extra));
      for (const [name, call] of Object.entries(doors)) {
        await expect(call(), name).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
      expect(h.ran).toEqual([]);
    });
  }

  it("a person reaches every write; reads stay open to an agent", async () => {
    for (const call of Object.values(writes(caller()))) await call();
    expect(h.ran.sort()).toEqual([
      "add",
      "build",
      "curate",
      "readNow",
      "runAction",
    ]);
    h.ran.length = 0;
    await caller({ agentUserId: "agent-1" }).groups({});
    expect(h.ran).toEqual(["groups"]);
  });
});

describe("library.build while the last bundle waits", () => {
  it("is a CONFLICT that names the waiting bundle", async () => {
    h.buildResult = {
      status: "refused",
      reason: "previous_build_pending",
      proposalId: "11111111-1111-4111-8111-111111111111",
      read: 0,
      skipped: [],
    };
    await expect(caller().build({ groupId: ID })).rejects.toMatchObject({
      code: "CONFLICT",
      cause: {
        reasonCode: "PREVIOUS_BUILD_PENDING",
        pendingProposalId: "11111111-1111-4111-8111-111111111111",
      },
    });
  });
});

describe("library.add input (both doors share the schema)", () => {
  it("Read now is one item at a time — refused before anything is staged", async () => {
    const two = {
      items: [
        { kind: "url", url: "https://example.com/1" },
        { kind: "url", url: "https://example.com/2" },
      ],
      readNow: true,
    };
    expect(LibraryAddInputSchema.safeParse(two).success).toBe(false);
    expect(
      LibraryAddInputSchema.safeParse({ ...two, items: two.items.slice(0, 1) })
        .success
    ).toBe(true);
    await expect(caller().add(two as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.ran).toEqual([]);
  });
});
