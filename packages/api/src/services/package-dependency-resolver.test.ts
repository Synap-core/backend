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
  mockToPackageDefinition,
  mockResolveWorkspaceTemplate,
  mockCreateWorkspace,
  mockComposeOntoBase,
  mockApplyPostWorkspace,
  mockLoadCapabilityTemplate,
  mockCreateCapabilityFromDefinition,
  mockCreateHubCtx,
} = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
  mockGetWorkspaceTemplate: vi.fn(),
  mockToWorkspaceDefinition: vi.fn(),
  mockToPackageDefinition: vi.fn(),
  mockResolveWorkspaceTemplate: vi.fn(),
  mockCreateWorkspace: vi.fn(),
  mockComposeOntoBase: vi.fn(),
  mockApplyPostWorkspace: vi.fn(),
  mockLoadCapabilityTemplate: vi.fn(),
  mockCreateCapabilityFromDefinition: vi.fn(),
  mockCreateHubCtx: vi.fn(),
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

// The resolver goes through `resolveWorkspaceTemplate` (cache-first, bundle
// fallback — see resolve-workspace-template.ts) instead of importing
// `@synap-core/workspace-templates` directly. Mocked wholesale here so these
// tests never touch the real cache DB read; the mock composes the SAME three
// primitives (`mockGetWorkspaceTemplate`/`mockToWorkspaceDefinition`/
// `mockToPackageDefinition`) the tests already configure per-scenario, so
// existing test bodies are unchanged — only this wiring moved.
vi.mock("./capabilities/resolve-workspace-template.js", () => ({
  resolveWorkspaceTemplate: mockResolveWorkspaceTemplate,
}));

vi.mock("./workspace-creation-service.js", () => ({
  createWorkspaceFromDefinitionIdempotent: mockCreateWorkspace,
}));

vi.mock("./compose-overlay.js", () => ({
  composeOntoBaseWorkspace: mockComposeOntoBase,
}));

vi.mock("./package-apply-post-workspace.js", () => ({
  applyPackagePostWorkspace: mockApplyPostWorkspace,
}));

// Capability-dependency install door — the SAME canonical applier the embedded
// `integrations[]` path uses. Mocked so these tests never hit the CP catalog
// cache or the governed capability applier.
vi.mock("./capabilities/create-from-definition.js", () => ({
  loadCapabilityTemplate: mockLoadCapabilityTemplate,
  createCapabilityFromDefinition: mockCreateCapabilityFromDefinition,
}));

vi.mock("../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: mockCreateHubCtx,
}));

import { resolvePackageDependencies } from "./package-dependency-resolver.js";

type MemberRow = {
  id: string;
  ownerId: string;
  createdAt: Date;
  role: string;
};

/** Rows the mocked `db.select().from().innerJoin().where()` chain resolves to. */
let selectRows: Array<MemberRow> = [];

/**
 * Per-call responses for the subtype lookup, consumed IN ORDER — one entry per
 * `findWorkspaceBySubtype` call (the resolver issues exactly one per slug it
 * visits, deps-first). Needed for multi-slug graphs, where a single flat
 * `selectRows` would wrongly answer every slug identically. Falls back to
 * `selectRows` once drained.
 */
let selectQueue: Array<Array<MemberRow>> = [];

function selectChain() {
  const chain = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(() =>
      Promise.resolve(selectQueue.length ? selectQueue.shift()! : selectRows)
    ),
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
    selectQueue = [];
    mockDb.select.mockImplementation(() => selectChain());
    mockGetWorkspaceTemplate.mockReturnValue(undefined);
    mockToWorkspaceDefinition.mockReturnValue({ definition: {} });
    // Default: a package with NO post-workspace layers, so seeding is a no-op
    // and the existing graph tests are unaffected. Tests that assert seeding
    // override this to return capabilities.
    mockToPackageDefinition.mockReturnValue({
      capabilities: [],
      playbooks: [],
    });
    mockApplyPostWorkspace.mockResolvedValue({});
    // Capability install door: template resolves + applier succeeds by default.
    mockCreateHubCtx.mockResolvedValue({ userId: USER, workspaceId: null });
    mockLoadCapabilityTemplate.mockResolvedValue({ key: "cap", name: "Cap" });
    mockCreateCapabilityFromDefinition.mockResolvedValue({
      capabilityKey: "cap",
      created: {},
    });
    mockCreateWorkspace.mockResolvedValue({
      workspaceId: "ws-installed",
      created: true,
    });
    mockComposeOntoBase.mockResolvedValue({});
    // Compose `resolveWorkspaceTemplate`'s result from the SAME three
    // primitives the tests configure — mirrors the real module's bundle-
    // fallback branch (getWorkspaceTemplate → toWorkspaceDefinition +
    // toPackageDefinition), so per-test mock setup is unchanged.
    mockResolveWorkspaceTemplate.mockImplementation(async (slug: string) => {
      const tpl = mockGetWorkspaceTemplate(slug);
      if (!tpl) return null;
      const { definition: workspaceDefinition } =
        mockToWorkspaceDefinition(slug);
      const packageDefinition = mockToPackageDefinition(slug);
      return {
        source: "bundle",
        dependencies: tpl.dependencies ?? [],
        workspaceDefinition,
        packageDefinition,
      };
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

  // ── BUG A: `require` on an OVERLAY must COMPOSE, never create ─────────────
  // `the-arch` requires `grants`; `grants` itself declares `compose: operations`.
  // Before the fix, step 4 called the create path directly and materialized a
  // rogue standalone "Grants Pipeline" workspace — which, because grants.yaml
  // sets `subtype: operations`, then collided with the REAL Operations
  // workspace in findWorkspaceBySubtype ("Multiple workspaces match dependency
  // subtype") and made every later compose target a coin-flip.
  describe("BUG A — transitive compose (a required dep that is itself an overlay)", () => {
    /** grants = overlay on operations; operations = a plain base template. */
    function arrangeTheArchGraph() {
      mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
        if (slug === "grants") {
          return {
            dependencies: [
              { slug: "operations", kind: "workspace", relation: "compose" },
            ],
          };
        }
        if (slug === "operations") return { dependencies: [] };
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
    }

    it("A1. require:grants composes grants onto operations — NO rogue workspace created", async () => {
      arrangeTheArchGraph();
      selectRows = []; // nothing on the pod yet

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "grants", kind: "workspace", relation: "require" },
          ],
        },
        userId: USER,
        selfSlug: "the-arch",
      });

      // The overlay was composed onto the base, not created.
      expect(mockComposeOntoBase).toHaveBeenCalledTimes(1);
      expect(mockComposeOntoBase).toHaveBeenCalledWith({
        composeTargetWorkspaceId: "ws-operations",
        userId: USER,
        definition: { slug: "grants" },
      });

      // The ONLY workspace created is the BASE (operations) — never grants.
      expect(mockCreateWorkspace).toHaveBeenCalledTimes(1);
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: "operations" })
      );
      const createdSlugs = mockCreateWorkspace.mock.calls.map(
        (c) => (c[0] as { templateId: string }).templateId
      );
      expect(createdSlugs).not.toContain("grants");

      // grants resolves TO THE BASE's workspace id, action "composed".
      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "operations",
          action: "installed",
          workspaceId: "ws-operations",
        }),
        expect.objectContaining({
          slug: "grants",
          action: "composed",
          workspaceId: "ws-operations",
        }),
      ]);

      // A nested compose is composed HERE — it never becomes the TOP-LEVEL
      // package's own overlay target.
      expect(result.composeRequested).toBe(false);
      expect(result.composeTargetWorkspaceId).toBeUndefined();
    });

    it("A6. a composed overlay SEEDS its own capabilities onto the base via the shared door", async () => {
      // The real bug this closes: `toWorkspaceDefinition` (used to materialize a
      // dep) drops grants' 4 capabilities, so a `require: grants` stood up the
      // workspace but never its grant capabilities — on BOTH install doors.
      arrangeTheArchGraph();
      selectRows = [];
      mockToPackageDefinition.mockImplementation((slug: string) =>
        slug === "grants"
          ? {
              capabilities: [{ templateKey: "stellar-grant-client" }],
              playbooks: [],
            }
          : { capabilities: [], playbooks: [] }
      );

      await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "grants", kind: "workspace", relation: "require" },
          ],
        },
        userId: USER,
        agentUserId: "agent-9",
        selfSlug: "the-arch",
      });

      // grants' capabilities are seeded onto the BASE (operations) workspace it
      // composed onto — via the ONE shared post-workspace door, carrying the
      // acting agent identity.
      expect(mockApplyPostWorkspace).toHaveBeenCalledTimes(1);
      expect(mockApplyPostWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-operations",
          userId: USER,
          agentUserId: "agent-9",
          body: expect.objectContaining({
            capabilities: [{ templateKey: "stellar-grant-client" }],
          }),
        })
      );
    });

    it("A7. a base template with NO post-workspace layers does not call the shared door", async () => {
      // operations (a plain base, no integrations) must not trigger a needless
      // governed write. Default toPackageDefinition returns empty layers.
      arrangeTheArchGraph();
      selectRows = [];

      await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "operations", kind: "workspace", relation: "require" },
          ],
        },
        userId: USER,
        selfSlug: "the-arch",
      });

      expect(mockApplyPostWorkspace).not.toHaveBeenCalled();
    });

    it("A2. existing writable operations base is reused as the compose target", async () => {
      arrangeTheArchGraph();
      // Lookup order: (1) subtype "grants" — MISSES, because grants.yaml sets
      // `subtype: operations`, so no workspace ever carries subtype "grants";
      // (2) subtype "operations" — hits the real Operations workspace.
      selectQueue = [
        [],
        [
          {
            id: "ws-real-operations",
            ownerId: USER,
            createdAt: new Date(),
            role: "editor",
          },
        ],
      ];

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "grants", kind: "workspace", relation: "require" },
          ],
        },
        userId: USER,
        selfSlug: "the-arch",
      });

      expect(mockCreateWorkspace).not.toHaveBeenCalled();
      expect(mockComposeOntoBase).toHaveBeenCalledWith(
        expect.objectContaining({
          composeTargetWorkspaceId: "ws-real-operations",
        })
      );
      expect(result.installed).toContainEqual(
        expect.objectContaining({
          slug: "grants",
          action: "composed",
          workspaceId: "ws-real-operations",
        })
      );
    });

    it("A3. overlay whose base cannot be resolved → required-absent, never a rogue create", async () => {
      mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
        if (slug === "grants") {
          return {
            dependencies: [
              { slug: "operations", kind: "workspace", relation: "compose" },
            ],
          };
        }
        return undefined; // operations has NO built-in template
      });
      selectRows = [];

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "grants", kind: "workspace", relation: "require" },
          ],
        },
        userId: USER,
        selfSlug: "the-arch",
      });

      expect(mockCreateWorkspace).not.toHaveBeenCalled();
      expect(mockComposeOntoBase).not.toHaveBeenCalled();
      expect(result.installed).toContainEqual(
        expect.objectContaining({
          slug: "grants",
          action: "required-absent",
        })
      );
    });

    it("A4. compose cardinality is enforced on a NESTED template too, not just top-level", async () => {
      mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
        if (slug === "bad-overlay") {
          return {
            dependencies: [
              { slug: "base-x", kind: "workspace", relation: "compose" },
              { slug: "base-y", kind: "workspace", relation: "compose" },
            ],
          };
        }
        return { dependencies: [] };
      });

      await expect(
        resolvePackageDependencies({
          definition: {
            dependencies: [
              { slug: "bad-overlay", kind: "workspace", relation: "require" },
            ],
          },
          userId: USER,
        })
      ).rejects.toThrow(/at most one 'compose'.*bad-overlay/s);
    });

    it("A5. the ancestor-path cycle guard still fires through a transitive compose", async () => {
      // a --require--> b ; b --compose--> a  → a is its own ancestor.
      mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
        if (slug === "a") {
          return {
            dependencies: [
              { slug: "b", kind: "workspace", relation: "require" },
            ],
          };
        }
        if (slug === "b") {
          return {
            dependencies: [
              { slug: "a", kind: "workspace", relation: "compose" },
            ],
          };
        }
        return undefined;
      });
      selectRows = [];

      await expect(
        resolvePackageDependencies({
          definition: {
            dependencies: [
              { slug: "a", kind: "workspace", relation: "require" },
            ],
          },
          userId: USER,
        })
      ).rejects.toThrow(/Cyclic/);
    });
  });

  // ── BUG B: ONE idempotency-key convention across both doors ───────────────
  // The Hub door (`POST /api/hub/packages/apply`, i.e. `synap launch`) writes
  // `proposalId: body._meta.slug` — the BARE template slug. This resolver used
  // to hand-roll `${slug}-v1`, so a template installed via `synap launch` was
  // invisible to a later `require` here → a DUPLICATE workspace. Only templates
  // whose slug ≠ subtype are exposed (the step-1 subtype lookup shields the
  // rest); `builder-workspace` (subtype `builder`) is the live case.
  describe("BUG B — resolver + Hub door agree on the idempotency key", () => {
    it("B1. install uses the BARE template slug as proposalId (the Hub door's key)", async () => {
      mockGetWorkspaceTemplate.mockReturnValue({ dependencies: [] });
      mockToWorkspaceDefinition.mockReturnValue({ definition: {} });
      selectRows = []; // subtype lookup misses (builder-workspace ≠ subtype "builder")

      await resolvePackageDependencies({
        definition: {
          dependencies: [
            {
              slug: "builder-workspace",
              kind: "workspace",
              relation: "require",
            },
          ],
        },
        userId: USER,
      });

      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: "builder-workspace" })
      );
      // The old convention must be gone — it is what created the duplicate.
      expect(mockCreateWorkspace).not.toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: "builder-workspace-v1" })
      );
    });

    it("B2. a workspace already installed under the Hub's key is REUSED, not duplicated", async () => {
      // Models createWorkspaceFromDefinitionIdempotent's real behaviour: it
      // matches provisioning_proposal_id by EXACT equality. The pod already
      // carries the row `synap launch` wrote under key "builder-workspace".
      const podRows = new Map<string, string>([
        ["builder-workspace", "ws-launched-by-cli"],
      ]);
      mockCreateWorkspace.mockImplementation(
        async (input: { proposalId?: string }) => {
          const hit = input.proposalId
            ? podRows.get(input.proposalId)
            : undefined;
          if (hit) return { workspaceId: hit, created: false };
          return { workspaceId: "ws-DUPLICATE", created: true };
        }
      );
      mockGetWorkspaceTemplate.mockReturnValue({ dependencies: [] });
      mockToWorkspaceDefinition.mockReturnValue({ definition: {} });
      selectRows = [];

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            {
              slug: "builder-workspace",
              kind: "workspace",
              relation: "require",
            },
          ],
        },
        userId: USER,
      });

      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "builder-workspace",
          action: "found",
          workspaceId: "ws-launched-by-cli",
        }),
      ]);
      expect(result.installed[0].workspaceId).not.toBe("ws-DUPLICATE");
    });
  });

  // ── kind:"capability" deps are first-class: resolved + installed ─────────
  // Before the fix, any dep with kind !== "workspace" was pushed as
  // required-absent and NEVER installed. A suite that requires a capability now
  // provisions it through the canonical governed applier.
  describe("kind:'capability' dependency install", () => {
    it("C1. a required capability is resolved + installed through the applier", async () => {
      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "gmail-cap", kind: "capability", relation: "require" },
          ],
        },
        userId: USER,
      });

      expect(mockLoadCapabilityTemplate).toHaveBeenCalledWith("gmail-cap");
      expect(mockCreateCapabilityFromDefinition).toHaveBeenCalledTimes(1);
      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "gmail-cap",
          kind: "capability",
          action: "installed",
        }),
      ]);
      // No workspace side-effects for a bare capability dep.
      expect(mockCreateWorkspace).not.toHaveBeenCalled();
    });

    it("C2. kind:'workspace' behaviour is unchanged when a capability dep is also present", async () => {
      mockGetWorkspaceTemplate.mockReturnValue({ dependencies: [] });
      mockToWorkspaceDefinition.mockReturnValue({ definition: {} });
      selectRows = []; // subtype miss → install

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "ops-workspace", kind: "workspace", relation: "require" },
            { slug: "gmail-cap", kind: "capability", relation: "require" },
          ],
        },
        userId: USER,
      });

      // Workspace branch: still installs via the idempotent create path.
      expect(mockCreateWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({ proposalId: "ops-workspace" })
      );
      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "ops-workspace",
          kind: "workspace",
          action: "installed",
          workspaceId: "ws-installed",
        }),
        expect.objectContaining({
          slug: "gmail-cap",
          kind: "capability",
          action: "installed",
        }),
      ]);
    });

    it("C3. a capability template missing from cache degrades to required-absent, no throw", async () => {
      mockLoadCapabilityTemplate.mockRejectedValue(
        new Error(
          'Capability template "ghost-cap" not found in the Control Plane catalog'
        )
      );

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "ghost-cap", kind: "capability", relation: "require" },
          ],
        },
        userId: USER,
      });

      expect(mockCreateCapabilityFromDefinition).not.toHaveBeenCalled();
      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "ghost-cap",
          kind: "capability",
          action: "required-absent",
        }),
      ]);
    });

    it("C4. a capability required by TWO members installs once (diamond dedup)", async () => {
      // Two workspace members, each declaring the SAME capability dependency.
      mockGetWorkspaceTemplate.mockImplementation((slug: string) => {
        if (slug === "ws-a" || slug === "ws-b") {
          return {
            dependencies: [
              { slug: "shared-cap", kind: "capability", relation: "require" },
            ],
          };
        }
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
      selectRows = [];

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "ws-a", kind: "workspace", relation: "require" },
            { slug: "ws-b", kind: "workspace", relation: "require" },
          ],
        },
        userId: USER,
      });

      // Applier ran exactly once despite two members requiring it.
      expect(mockCreateCapabilityFromDefinition).toHaveBeenCalledTimes(1);
      const capEntries = result.installed.filter(
        (d) => d.kind === "capability"
      );
      expect(capEntries).toHaveLength(1);
      expect(capEntries[0]).toEqual(
        expect.objectContaining({ slug: "shared-cap", action: "installed" })
      );
    });

    it("C5. a failing capability applier degrades to required-absent, never aborts the suite", async () => {
      mockCreateCapabilityFromDefinition.mockRejectedValue(
        new Error("vault write failed")
      );

      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            { slug: "broken-cap", kind: "capability", relation: "require" },
          ],
        },
        userId: USER,
      });

      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "broken-cap",
          kind: "capability",
          action: "required-absent",
          message: expect.stringContaining("vault write failed"),
        }),
      ]);
    });

    it("C6. an automation dep is still surfaced as required-absent (no symmetric door)", async () => {
      const result = await resolvePackageDependencies({
        definition: {
          dependencies: [
            {
              slug: "some-automation",
              kind: "automation",
              relation: "require",
            },
          ],
        },
        userId: USER,
      });

      expect(mockCreateCapabilityFromDefinition).not.toHaveBeenCalled();
      expect(result.installed).toEqual([
        expect.objectContaining({
          slug: "some-automation",
          kind: "automation",
          action: "required-absent",
        }),
      ]);
    });
  });
});
