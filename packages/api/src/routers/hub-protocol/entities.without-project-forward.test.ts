/**
 * "Not in a project" through the Hub `getEntities` forwarder: the regular
 * `entities.list` ignores the caller's active space (the ctx workspace) for
 * `withoutProject`, so an EXPLICIT `workspaceId` must reach the list as its
 * own input — otherwise a Hub/REST caller asking for one space's unfiled
 * things silently gets the whole pod.
 *
 * The REAL hub procedure; the regular `entities.list` is replaced by a spy on
 * its input. That the list ignores the ctx workspace is pinned on PGlite by
 * `routers/entities/without-project.pglite.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  listInput: null as Record<string, unknown> | null,
  ctxWorkspace: undefined as unknown,
}));

vi.mock("../../middleware/api-key-auth.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../middleware/api-key-auth.js")>();
  const { t } =
    await vi.importActual<typeof import("../../trpc.js")>("../../trpc.js");
  return { ...actual, scopedProcedure: () => t.procedure };
});
vi.mock("./utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils.js")>()),
  createHubProtocolCallerContext: async (
    userId: string,
    _scopes: string[],
    workspaceId: unknown
  ) => {
    h.ctxWorkspace = workspaceId;
    return { userId, workspaceId };
  },
}));
vi.mock("../entities.js", () => ({
  entitiesRouter: {
    createCaller: () => ({
      list: async (input: Record<string, unknown>) => {
        h.listInput = input;
        return { entities: [] };
      },
    }),
  },
}));

import { entitiesRouter as hubEntitiesRouter } from "./entities.js";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";

const caller = () =>
  hubEntitiesRouter.createCaller({
    userId: USER,
    scopes: ["hub-protocol.read"],
  } as never);

beforeEach(() => {
  h.listInput = null;
  h.ctxWorkspace = undefined;
});

describe("hub getEntities — withoutProject", () => {
  it("an explicit workspaceId reaches the list as its own input", async () => {
    await caller().getEntities({
      userId: USER,
      workspaceId: WS,
      withoutProject: true,
    });
    expect(h.listInput).toMatchObject({
      withoutProject: true,
      workspaceId: WS,
    });
  });

  it("no workspaceId ⇒ the list gets none (the whole floor)", async () => {
    await caller().getEntities({ userId: USER, withoutProject: true });
    expect(h.listInput).toMatchObject({ withoutProject: true });
    expect(h.listInput).not.toHaveProperty("workspaceId");
  });

  it("other reads keep the workspace on the ctx only, as before", async () => {
    await caller().getEntities({ userId: USER, workspaceId: WS });
    expect(h.ctxWorkspace).toBe(WS);
    expect(h.listInput).not.toHaveProperty("workspaceId");
  });
});
