/**
 * The design door's write half: what reaches the governed entity door, and
 * what never does. The ops themselves are `@synap-core/types/design-board`'s
 * suite; this proves the door around them: the catalog is required, a stale
 * read is refused, a design past its review becomes a revision, a review the
 * outer gate asked for is forced on the entity door, and a refusal writes
 * nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  catalogRows: [] as Array<{ metadata: unknown }>,
  designRows: [] as Array<Record<string, unknown>>,
  projectRows: [] as Array<{ projectId: string }>,
  creates: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  callerCtx: [] as Array<Record<string, unknown>>,
  createReply: {
    id: "new-design",
    updatedAt: "2026-11-19T10:00:00.000Z",
  } as Record<string, unknown>,
  updateReply: { id: "d1", updatedAt: "2026-11-19T10:00:00.000Z" } as Record<
    string,
    unknown
  >,
  /** What the app's kit read answers (app-kit.ts has its own suite). */
  appKit: null as null | ((appId: string) => unknown),
  appKitCalls: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { capabilities } = await import("@synap/database/schema");
  const rowsFor = (table: unknown) =>
    table === capabilities
      ? h.catalogRows
      : table === actual.relations
        ? h.projectRows
        : h.designRows;
  const chain = (table: unknown) => {
    const rows = () => rowsFor(table);
    const tail = {
      limit: async () => rows(),
      orderBy: () => ({ limit: async () => rows() }),
    };
    return { where: () => tail };
  };
  return {
    ...actual,
    getWorkspaceMembership: async () => ({ role: "owner" }),
    db: { select: () => ({ from: (table: unknown) => chain(table) }) },
  };
});
vi.mock("../../access/entity-read-floor.js", () => ({
  entityReadVisibleWhere: () => undefined,
}));
vi.mock("../installed-template-space.js", () => ({
  installedTemplateSpace: async () => ({
    id: "space-builder",
    name: "Builder",
  }),
}));
vi.mock("../lifecycle/board-lens.js", () => ({
  resolveProfileLifecycle: async () => ({}),
  toLifecycleWire: () => ({
    profileSlug: "ui-design",
    property: "design-status",
    options: [
      { key: "draft", label: "Draft", category: "open", humanOnly: false },
      {
        key: "in-review",
        label: "In review",
        category: "active",
        humanOnly: false,
      },
      {
        key: "approved",
        label: "Approved",
        category: "active",
        humanOnly: true,
      },
      {
        key: "implemented",
        label: "Implemented",
        category: "done",
        humanOnly: false,
      },
    ],
    initialStatus: "draft",
  }),
}));
vi.mock("./app-kit.js", () => ({
  readAppKit: async (_userId: string, appId: string) => {
    h.appKitCalls.push(appId);
    return h.appKit ? h.appKit(appId) : { status: "none", appId };
  },
}));
vi.mock("../../routers/entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => {
      h.callerCtx.push(ctx);
      return {
        create: async (input: Record<string, unknown>) => {
          h.creates.push(input);
          return h.createReply;
        },
        update: async (input: Record<string, unknown>) => {
          h.updates.push(input);
          return h.updateReply;
        },
      };
    },
  },
}));

const { applyDesign, readDesign, designCatalog } =
  await import("./design-door.js");

const CATALOG = {
  kitId: "synap",
  hash: "h-1",
  components: {
    SpatialButton: { variant: { kind: "select", options: ["primary"] } },
  },
  layout: {
    Section: { children: { kind: "slot" } },
    Text: { text: { kind: "text" } },
  },
};
const UPDATED = "2026-11-19T09:00:00.000Z";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function board(content: unknown[] = []) {
  return {
    format: "synap-board/2",
    frames: [
      {
        id: "d",
        name: "Home",
        x: 0,
        y: 0,
        w: 1440,
        h: 900,
        page: { root: { props: {} }, content },
      },
    ],
  };
}

function design(props: Record<string, unknown> = {}) {
  return {
    id: "d1",
    title: "Home",
    type: "ui-design",
    workspaceId: "space-builder",
    properties: {
      "design-json": board([{ type: "Section", props: { id: "sec" } }]),
      "design-status": "draft",
      "schema-version": 3,
      "design-app": "app-1",
      "target-surface": "Synap › Home",
      critique: [{ id: "f1" }],
      ...props,
    },
    updatedAt: new Date(UPDATED),
  };
}

const ctx = { userId: "owner-1", workspaceId: null, agentUserId: AGENT };
const addText = {
  op: "add_block",
  frameId: "d",
  parentId: "sec",
  type: "Text",
  props: { text: "Hi" },
};

beforeEach(() => {
  h.catalogRows = [{ metadata: { designCatalog: CATALOG } }];
  h.designRows = [design()];
  h.projectRows = [];
  h.creates.length = 0;
  h.updates.length = 0;
  h.callerCtx.length = 0;
  h.createReply = { id: "new-design", updatedAt: "2026-11-19T10:00:00.000Z" };
  h.updateReply = { id: "d1", updatedAt: "2026-11-19T10:00:00.000Z" };
  h.appKit = null;
  h.appKitCalls.length = 0;
});

describe("design.apply writes through the governed entity door", () => {
  it("a change to a working design: ONE update of the board, as the agent, with the ops' changes", async () => {
    const r = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [addText],
    });
    expect(r).toMatchObject({
      status: "applied",
      designId: "d1",
      catalogHash: "h-1",
      componentsUsed: ["Section", "Text"],
    });
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({
      id: "d1",
      agentUserId: AGENT,
      properties: {
        "schema-version": 3,
        "components-used": ["Section", "Text"],
      },
    });
    expect(h.updates[0]).not.toHaveProperty("forcePropose");
    // Never the status: that is the lifecycle door's.
    expect(h.updates[0]!.properties).not.toHaveProperty("design-status");
  });

  it("the outer gate asked for review: the entity door is told forcePropose, and its proposal is the answer", async () => {
    h.updateReply = {
      status: "proposed",
      proposalId: "p-1",
      reviewUrl: "/open/p-1",
    };
    const r = await applyDesign(
      { ...ctx, mustPropose: true },
      { designId: "d1", baseUpdatedAt: UPDATED, ops: [addText] }
    );
    expect(h.updates[0]).toMatchObject({
      forcePropose: true,
      agentUserId: AGENT,
    });
    expect(r).toMatchObject({
      status: "proposed",
      proposalId: "p-1",
      designId: "d1",
    });
  });

  it("a review asked for with no agent identity is refused before anything is written", async () => {
    await expect(
      applyDesign(
        { userId: "owner-1", workspaceId: null, mustPropose: true },
        { designId: "d1", baseUpdatedAt: UPDATED, ops: [addText] }
      )
    ).rejects.toThrow(/needs review/);
    expect(h.updates).toHaveLength(0);
  });

  it("a design changed since it was read is a conflict, never overwritten", async () => {
    const r = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: "2026-11-19T08:00:00.000Z",
      ops: [addText],
    });
    expect(r).toMatchObject({ status: "conflict", updatedAt: UPDATED });
    expect(h.updates).toHaveLength(0);
    const missing = await applyDesign(ctx, { designId: "d1", ops: [addText] });
    expect(missing).toMatchObject({
      status: "refused",
      reasons: [{ kind: "bad-op" }],
    });
  });

  it("an op the catalog refuses writes nothing and names the op, the reason and the hash", async () => {
    const r = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [addText, { op: "add_block", frameId: "d", type: "Carousel" }],
    });
    expect(r).toMatchObject({
      status: "refused",
      opIndex: 1,
      reasons: [{ kind: "unknown-type", type: "Carousel" }],
      catalogHash: "h-1",
    });
    expect(h.updates).toHaveLength(0);
  });

  it("a stored design the catalog cannot fully place is refused until acceptDrops, then written without those parts", async () => {
    h.designRows = [
      design({
        "design-json": board([
          { type: "Section", props: { id: "sec" } },
          { type: "Gone", props: { id: "g" } },
        ]),
      }),
    ];
    const r = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [addText],
    });
    expect(r).toMatchObject({
      status: "refused",
      opIndex: null,
      reasons: [{ kind: "unknown-type", type: "Gone" }],
    });
    expect(h.updates).toHaveLength(0);
    const ok = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [addText],
      acceptDrops: true,
    });
    expect(ok).toMatchObject({
      status: "applied",
      dropped: [{ kind: "unknown-type", type: "Gone" }],
    });
  });

  it("a design past its review is never written: the change is a revision in draft, copying the request, not the outcome", async () => {
    h.designRows = [design({ "design-status": "approved" })];
    h.projectRows = [{ projectId: "proj-1" }];
    const r = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [addText],
    });
    expect(r).toMatchObject({
      status: "revised",
      designId: "new-design",
      revisedFrom: "d1",
    });
    expect(h.updates).toHaveLength(0);
    expect(h.creates[0]).toMatchObject({
      profileSlug: "ui-design",
      title: "Home (revision)",
      projectId: "proj-1",
      targetWorkspaceId: "space-builder",
      agentUserId: AGENT,
      properties: {
        "design-status": "draft",
        "design-app": "app-1",
        "target-surface": "Synap › Home",
      },
    });
    expect(h.creates[0]!.properties).not.toHaveProperty("critique");
  });

  it("create_design first: a new design in the designs' space, for the app, in the initial status, filled by the rest", async () => {
    const r = await applyDesign(ctx, {
      ops: [
        {
          op: "create_design",
          title: "Settings",
          appId: "11111111-1111-4111-8111-111111111111",
          projectId: "22222222-2222-4222-8222-222222222222",
        },
        { op: "add_frame", preset: "desktop", id: "d" },
        { op: "add_block", frameId: "d", type: "Section" },
      ],
    });
    expect(r).toMatchObject({ status: "created", designId: "new-design" });
    if (r.status !== "created") return;
    expect(r.changes.map((c) => c.opIndex)).toEqual([1, 2]);
    expect(h.creates[0]).toMatchObject({
      title: "Settings",
      targetWorkspaceId: "space-builder",
      projectId: "22222222-2222-4222-8222-222222222222",
      properties: {
        "design-app": "11111111-1111-4111-8111-111111111111",
        "design-status": "draft",
        "design-scope": "page",
        "schema-version": 3,
      },
    });
    const refused = await applyDesign(ctx, {
      ops: [
        { op: "create_design", title: "X" },
        { op: "add_frame", preset: "watch" },
      ],
    });
    expect(refused).toMatchObject({
      status: "refused",
      opIndex: 1,
      reasons: [{ kind: "bad-preset" }],
    });
    expect(await applyDesign(ctx, { ops: [addText] })).toMatchObject({
      status: "refused",
      opIndex: 0,
    });
  });
});

describe("no catalog installed: an error, never an empty catalog", () => {
  it("design.catalog and design.apply refuse, naming how to install it; design.read still reads, and says so", async () => {
    h.catalogRows = [];
    await expect(designCatalog("owner-1")).rejects.toThrow(/not installed/);
    await expect(
      applyDesign(ctx, {
        designId: "d1",
        baseUpdatedAt: UPDATED,
        ops: [addText],
      })
    ).rejects.toThrow(/not installed/);
    const read = await readDesign(ctx, "d1");
    expect(read.catalog).toMatchObject({
      kitId: null,
      hash: null,
      note: expect.stringMatching(/not installed/),
    });
    expect(read.design).toMatchObject({
      id: "d1",
      updatedAt: UPDATED,
      editable: { editable: true },
    });
  });

  it("a catalog the pod cannot read is refused, not read as empty", async () => {
    h.catalogRows = [{ metadata: { designCatalog: { kitId: "synap" } } }];
    await expect(designCatalog("owner-1")).rejects.toThrow(/cannot read/);
  });

  it("design.read with the catalog: outline per frame with its width class and columns", async () => {
    const read = await readDesign(ctx, "d1");
    expect(read.catalog).toEqual({ kitId: "synap", hash: "h-1" });
    expect(read.frames).toEqual([
      {
        id: "d",
        name: "Home",
        w: 1440,
        h: 900,
        widthClass: "expanded",
        columns: 12,
        blocks: [{ id: "sec", type: "Section" }],
      },
    ]);
  });
});

const { TRPCError } = await import("@trpc/server");

const CRM_KIT = {
  kitId: "crm",
  hash: "sha256:kit",
  components: {
    Button: {
      variant: { kind: "select", options: ["default", "outline"] },
      children: { kind: "slot" },
    },
  },
  layout: {},
  canvas: { components: { Button: { category: "button", defaults: {} } } },
  kit: {
    react: "19",
    files: {
      js: { entityId: "f-js", sha256: "a".repeat(64), bytes: 10 },
      css: { entityId: "f-css", sha256: "b".repeat(64), bytes: 20 },
    },
  },
};
const withKit = () => {
  h.appKit = (appId) => ({
    status: "kit",
    appId,
    catalogFileId: "f-cat",
    kit: CRM_KIT,
  });
};

describe("a design of an app with its own kit (W6)", () => {
  it("design.catalog for the app: the kit's components, Synap's canvas blocks, a hash naming both, how to load the kit", async () => {
    withKit();
    const c = await designCatalog("owner-1", "app-1");
    expect(c).toMatchObject({
      kitId: "crm",
      hash: "sha256:kit+h-1",
      appId: "app-1",
      kit: {
        kitId: "crm",
        react: "19",
        files: { js: { sha256: "a".repeat(64), bytes: 10 } },
        canvas: CRM_KIT.canvas,
      },
    });
    expect(Object.keys(c.components)).toEqual(["Button"]);
    expect(Object.keys(c.layout).sort()).toEqual(["Section", "Text"]);
    // No app: Synap's own, and the app's kit is never read.
    h.appKitCalls.length = 0;
    expect(await designCatalog("owner-1")).toMatchObject({ kitId: "synap" });
    expect(h.appKitCalls).toEqual([]);
  });

  it("design.apply checks a design against ITS app's kit: the kit's Button goes in, Synap's components are refused", async () => {
    withKit();
    const ok = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [
        {
          op: "add_block",
          frameId: "d",
          parentId: "sec",
          type: "Button",
          props: { variant: "outline" },
        },
      ],
    });
    expect(ok).toMatchObject({
      status: "applied",
      catalogHash: "sha256:kit+h-1",
    });
    expect(h.appKitCalls).toEqual(["app-1"]);
    const refused = await applyDesign(ctx, {
      designId: "d1",
      baseUpdatedAt: UPDATED,
      ops: [
        {
          op: "add_block",
          frameId: "d",
          parentId: "sec",
          type: "SpatialButton",
          props: {},
        },
      ],
    });
    expect(refused).toMatchObject({
      status: "refused",
      opIndex: 0,
      catalogHash: "sha256:kit+h-1",
    });
  });

  it("create_design for an app takes that app's kit", async () => {
    withKit();
    const r = await applyDesign(ctx, {
      ops: [
        {
          op: "create_design",
          title: "Leads",
          appId: "99999999-9999-4999-8999-999999999999",
        },
        { op: "add_frame", preset: "desktop", id: "d" },
        { op: "add_block", frameId: "d", type: "Button", props: {} },
      ],
    });
    expect(r).toMatchObject({ status: "created" });
    expect(h.appKitCalls).toEqual(["99999999-9999-4999-8999-999999999999"]);
  });

  it("a kit the pod cannot read is an error naming why, never Synap's catalog in its place", async () => {
    h.appKit = () => {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "App app-1's design kit (file f-cat) cannot be used: The kit names no React major.",
      });
    };
    await expect(designCatalog("owner-1", "app-1")).rejects.toThrow(
      /cannot be used/
    );
    await expect(
      applyDesign(ctx, {
        designId: "d1",
        baseUpdatedAt: UPDATED,
        ops: [addText],
      })
    ).rejects.toThrow(/cannot be used/);
    expect(h.updates).toEqual([]);
    const read = await readDesign(ctx, "d1");
    expect(read.catalog).toMatchObject({
      kitId: null,
      note: expect.stringMatching(/cannot be used/),
    });
  });

  it("a kit component named like a canvas block is refused", async () => {
    h.appKit = (appId) => ({
      status: "kit",
      appId,
      catalogFileId: "f-cat",
      kit: { ...CRM_KIT, components: { Text: {} } },
    });
    await expect(designCatalog("owner-1", "app-1")).rejects.toThrow(
      /cannot be drawn with Synap's canvas blocks/
    );
  });
});
