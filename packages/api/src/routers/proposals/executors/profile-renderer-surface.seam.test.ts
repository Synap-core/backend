/**
 * `surface` across the whole renderer-binding seam: wire door → proposal `data`
 * → REAL `profile/renderer.set` executor → REAL `setProfileRenderer` → the
 * binding row. Only the DB layer and the permission gate are faked; nothing
 * between the door and the row is hand-built.
 *
 * The defect this pins: a door that accepts `surface` while the executor drops
 * it silently writes an approved `mcp-app` proposal to the IN-APP surface.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  checkPermissionOrPropose: vi.fn(),
  setRendererBinding: vi.fn(),
  cellRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: h.checkPermissionOrPropose,
}));
vi.mock("../../../services/profiles/renderer-binding-authz.js", () => ({
  assertMayBindRenderer: async () => undefined,
}));
vi.mock("./shared.js", () => ({ reportApproved: vi.fn() }));
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        workspaceMembers: { findFirst: vi.fn(async () => ({ role: "owner" })) },
        workspaces: { findFirst: vi.fn(async () => ({ archivedAt: null })) },
      },
      // executor idempotency probe: not yet approved
      select: () => ({ from: () => ({ where: async () => [] }) }),
      update: () => ({ set: () => ({ where: vi.fn() }) }),
    },
    // service: widget_definitions lookup
    getDb: async () => ({
      select: () => ({ from: () => ({ where: async () => h.cellRows }) }),
    }),
    setRendererBinding: h.setRendererBinding,
    revokeRendererBinding: vi.fn(),
  };
});

const { profilesRouter } = await import("../../profiles.js");
const { registerProfileExecutors } = await import("./profile.js");
const { proposalExecRegistry } = await import("../execution-registry.js");

const mcpCell = { kind: "cell" as const, cellKey: "contact-mcp", props: {} };
const frameCell = {
  kind: "cell" as const,
  cellKey: "contact-frame",
  props: {},
};

function cellRow(rendererType: string) {
  return [{ workspaceId: null, rendererType, isActive: true }];
}

/** Door → captured proposal data (agent path: the gate answers "proposed"). */
async function proposeViaDoor(extra: Record<string, unknown>, ref: unknown) {
  h.checkPermissionOrPropose.mockResolvedValue({ proposalId: "prop-1" });
  const caller = profilesRouter.createCaller({
    db: {},
    authenticated: true,
    userId: "user-1",
    workspaceId: "ws-1",
  } as never);
  await caller.setProfileRendererOverride({
    profileSlug: "contact",
    contentKind: "entity-detail",
    scope: "user",
    ref: ref as never,
    ...extra,
  });
  return h.checkPermissionOrPropose.mock.calls.at(-1)![0].data as Record<
    string,
    unknown
  >;
}

function approve(data: Record<string, unknown>) {
  const executor = proposalExecRegistry.resolve(
    "profile/renderer.set",
    "renderer.set"
  );
  if (!executor) throw new Error("executor not registered");
  return executor.execute({
    proposal: { workspaceId: "ws-1", data: { data } },
    userId: "approver-1",
    input: { proposalId: "prop-1" },
    deps: { emitProposalReviewed: vi.fn() },
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.cellRows = [];
  h.setRendererBinding.mockResolvedValue(undefined);
  proposalExecRegistry._reset();
  registerProfileExecutors();
});

describe("renderer binding surface — door → proposal → executor → row", () => {
  it("an agent-proposed mcp-app binding lands with surface 'mcp-app'", async () => {
    h.cellRows = cellRow("mcp-app");
    const data = await proposeViaDoor({ surface: "mcp-app" }, mcpCell);
    expect(data.surface).toBe("mcp-app");

    await approve(data);

    expect(h.setRendererBinding).toHaveBeenCalledTimes(1);
    expect(h.setRendererBinding.mock.calls[0]![1]).toMatchObject({
      surface: "mcp-app",
      subjectKind: "contact",
      sourceProposalId: "prop-1",
    });
  });

  it("an in-app proposal with no surface lands as 'app' and its payload is unchanged", async () => {
    h.cellRows = cellRow("frame");
    const data = await proposeViaDoor({}, frameCell);
    expect(data).not.toHaveProperty("surface");

    await approve(data);

    expect(h.setRendererBinding.mock.calls[0]![1]).toMatchObject({
      surface: "app",
    });
  });

  it("a LEGACY stored proposal (no surface key at all) lands as 'app'", async () => {
    h.cellRows = cellRow("frame");
    await approve({
      profileSlug: "contact",
      slot: "detail",
      scope: "user",
      ref: frameCell,
    });
    expect(h.setRendererBinding.mock.calls[0]![1]).toMatchObject({
      surface: "app",
    });
  });

  it("write-time check: an mcp-app cell on the 'app' surface is refused", async () => {
    h.cellRows = cellRow("mcp-app");
    await expect(
      approve({
        profileSlug: "contact",
        slot: "detail",
        scope: "user",
        ref: mcpCell,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.setRendererBinding).not.toHaveBeenCalled();
  });

  it("write-time check: a non-mcp-app cell on the 'mcp-app' surface is refused", async () => {
    h.cellRows = cellRow("frame");
    await expect(
      approve({
        profileSlug: "contact",
        slot: "detail",
        scope: "user",
        surface: "mcp-app",
        ref: frameCell,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.setRendererBinding).not.toHaveBeenCalled();
  });
});
