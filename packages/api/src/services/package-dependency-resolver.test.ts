/**
 * package-dependency-resolver.ts — regression tests
 *
 * Locks in the fixed bugs for the template-composition dependency resolver:
 * diamond dedup (no throw, single record), true-cycle detection, the
 * selfSlug-vs-workspaceSubtype self-collision guard, compose cardinality/kind
 * constraints, install-if-absent for built-in bases, required-absent
 * surfacing (never fatal) when no built-in template exists, and the
 * relation-aware write-gate (compose needs editor+, require reuses any
 * visible membership).
 *
 * Heavy I/O (`db`, workspace-templates lookups, workspace creation) is
 * mocked — mirrors the mocking style in `routers/relations.get-connections.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockDb,
  mockGetWorkspaceTemplate,
  mockToWorkspaceDefinition,
  mockCreateWorkspace,
} = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
  mockGetWorkspaceTemplate: vi.fn(),
  mockToWorkspaceDefinition: vi.fn(),
  mockCreateWorkspace: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: mockDb,
    and: vi.fn((...conditions) => ({ and: conditions })),
    eq: vi.fn((column, value) => ({ column, value })),
  };
});

vi.mock("@synap-core/workspace-templates", () => ({
  getWorkspaceTemplate: mockGetWorkspaceTemplate,
  toWorkspaceDefinition: mockToWorkspaceDefinition,
}));

vi.mock("./workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: mockCreateWorkspace,
}));

import { resolvePackageDependencies } from "./package-dependency-resolver.js";

/** Rows the mocked `db.select().from().innerJoin().where()` chain resolves to. */
let selectRows: Array<{
  id: string;
  ownerId: string;
  createdAt: Date;
  role: string;
}> = [];

function selectChain() {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(() => Promise.resolve(selectRows)),
  };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  return chain;
}

const USER = "user-1";

describe("resolvePackageDependencies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectRows = [];
    mockDb.select.mockImplementation(() => selectChain());
    mockGetWorkspaceTemplate.mockReturnValue(undefined);
    mockToWorkspaceDefinition.mockReturnValue({ definition: {} });
    mockCreateWorkspace.mockResolvedValue({
      workspaceId: "ws-installed",
      created: true,
    });
  });

  it("1. no deps → composeRequested:false, installed:[]", async () => {
    const result = await resolvePackageDependencies({
      definition: {},
      userId: USER,
    });
    expect(result).toEqual({ composeRequested: false, installed: [] });
  });

  it("2. diamond (P deps [B,C]; B deps [C]) does not throw, C resolved once", async () => {
    mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
      if (slug === "b") {
        return { dependencies: [{ slug: "c", relation: "require" }] };
      }
      if (slug === "c") return { dependencies: [] };
      return undefined;
    });
    mockToWorkspaceDefinition.mockImplementation((slug: string) => ({
      definition: { slug },
    }));
    mockCreateWorkspace.mockImplementation(
      async (input: { templateId: string }) => ({
        workspaceId: `ws-${input.templateId}`,
        created: true,
      })
    );

    const result = await resolvePackageDependencies({
      definition: {
        dependencies: [
          { slug: "b", kind: "workspace", relation: "require" },
          { slug: "c", kind: "workspace", relation: "require" },
        ],
      },
      userId: USER,
    });

    const cEntries = result.installed.filter((d) => d.slug === "c");
    expect(cEntries).toHaveLength(1);
    expect(cEntries[0].action).toBe("installed");
    const bEntries = result.installed.filter((d) => d.slug === "b");
    expect(bEntries).toHaveLength(1);
  });

  it("3. real cycle (A deps [B]; B deps [A]) throws Cyclic", async () => {
    mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
      if (slug === "a") {
        return { dependencies: [{ slug: "b", relation: "require" }] };
      }
      if (slug === "b") {
        return { dependencies: [{ slug: "a", relation: "require" }] };
      }
      return undefined;
    });

    await expect(
      resolvePackageDependencies({
        definition: {
          dependencies: [{ slug: "a", kind: "workspace", relation: "require" }],
        },
        userId: USER,
      })
    ).rejects.toThrow(/Cyclic/);
  });

  it("4a. selfSlug keyed off identity, not subtype: subtype===dep slug does not throw", async () => {
    // Overlay's own subtype is "operations" (== the dep slug), but its
    // identity slug (selfSlug) is "grants" — this must NOT self-collide.
    mockGetWorkspaceTemplate.mockReturnValue({ dependencies: [] });
    selectRows = []; // base absent → falls through to template install

    const result = await resolvePackageDependencies({
      definition: {
        workspaceSubtype: "operations",
        dependencies: [
          { slug: "operations", kind: "workspace", relation: "compose" },
        ],
      },
      userId: USER,
      selfSlug: "grants",
    });

    expect(result.composeRequested).toBe(true);
    expect(result.composeTargetWorkspaceId).toBe("ws-installed");
  });

  it("4b. selfSlug === the dep slug throws (true self-dependency)", async () => {
    await expect(
      resolvePackageDependencies({
        definition: {
          workspaceSubtype: "operations",
          dependencies: [
            { slug: "operations", kind: "workspace", relation: "compose" },
          ],
        },
        userId: USER,
        selfSlug: "operations",
      })
    ).rejects.toThrow(/Cyclic/);
  });

  it("5. >1 compose dep throws 'at most one'", async () => {
    await expect(
      resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "x", kind: "workspace", relation: "compose" },
            { slug: "y", kind: "workspace", relation: "compose" },
          ],
        },
        userId: USER,
      })
    ).rejects.toThrow(/at most one 'compose'/);
  });

  it("6. wrong-kind compose dep throws \"must be kind:'workspace'\"", async () => {
    await expect(
      resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "x", kind: "capability", relation: "compose" },
          ],
        },
        userId: USER,
      })
    ).rejects.toThrow(/must be kind:'workspace'/);
  });

  it("7. compose base found (writable) → composeTargetWorkspaceId set, action found", async () => {
    selectRows = [
      {
        id: "ws-existing",
        ownerId: USER,
        createdAt: new Date(),
        role: "editor",
      },
    ];

    const result = await resolvePackageDependencies({
      definition: {
        dependencies: [
          { slug: "base", kind: "workspace", relation: "compose" },
        ],
      },
      userId: USER,
    });

    expect(result.composeTargetWorkspaceId).toBe("ws-existing");
    expect(result.installed).toEqual([
      expect.objectContaining({
        slug: "base",
        action: "found",
        workspaceId: "ws-existing",
      }),
    ]);
  });

  it("8. compose base absent + built-in template exists → installs it", async () => {
    selectRows = [];
    mockGetWorkspaceTemplate.mockReturnValue({ dependencies: [] });
    mockCreateWorkspace.mockResolvedValue({
      workspaceId: "ws-new-base",
      created: true,
    });

    const result = await resolvePackageDependencies({
      definition: {
        dependencies: [
          { slug: "base", kind: "workspace", relation: "compose" },
        ],
      },
      userId: USER,
    });

    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(result.composeTargetWorkspaceId).toBe("ws-new-base");
    expect(result.installed).toEqual([
      expect.objectContaining({
        slug: "base",
        action: "installed",
        workspaceId: "ws-new-base",
      }),
    ]);
  });

  it("9. compose base absent + no built-in template → required-absent, no throw, no composeTargetWorkspaceId", async () => {
    selectRows = [];
    mockGetWorkspaceTemplate.mockReturnValue(undefined);

    const result = await resolvePackageDependencies({
      definition: {
        dependencies: [
          { slug: "base", kind: "workspace", relation: "compose" },
        ],
      },
      userId: USER,
    });

    expect(result.composeRequested).toBe(true);
    expect(result.composeTargetWorkspaceId).toBeUndefined();
    expect(mockCreateWorkspace).not.toHaveBeenCalled();
    expect(result.installed).toEqual([
      expect.objectContaining({
        slug: "base",
        action: "required-absent",
      }),
    ]);
  });

  it("10a. compose write-gate: viewer-only base is NOT found → falls through to install", async () => {
    selectRows = [
      {
        id: "ws-viewer-only",
        ownerId: "someone-else",
        createdAt: new Date(),
        role: "viewer",
      },
    ];
    mockGetWorkspaceTemplate.mockReturnValue({ dependencies: [] });
    mockCreateWorkspace.mockResolvedValue({
      workspaceId: "ws-installed-over-viewer",
      created: true,
    });

    const result = await resolvePackageDependencies({
      definition: {
        dependencies: [
          { slug: "base", kind: "workspace", relation: "compose" },
        ],
      },
      userId: USER,
    });

    expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
    expect(result.installed[0].action).toBe("installed");
    expect(result.installed[0].workspaceId).toBe("ws-installed-over-viewer");
  });

  it("10b. require write-gate: viewer-only base IS reused (found, no duplicate install)", async () => {
    selectRows = [
      {
        id: "ws-viewer-only",
        ownerId: "someone-else",
        createdAt: new Date(),
        role: "viewer",
      },
    ];

    const result = await resolvePackageDependencies({
      definition: {
        dependencies: [
          { slug: "base", kind: "workspace", relation: "require" },
        ],
      },
      userId: USER,
    });

    expect(mockCreateWorkspace).not.toHaveBeenCalled();
    expect(result.installed).toEqual([
      expect.objectContaining({
        slug: "base",
        action: "found",
        workspaceId: "ws-viewer-only",
      }),
    ]);
  });
});
