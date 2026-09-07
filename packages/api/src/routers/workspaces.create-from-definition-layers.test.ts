/**
 * A1 parity — `createFromDefinition`'s FRESH-CREATE branch must surface
 * `layers[]` on a partial post-workspace failure, exactly like its sibling
 * "reconcile existing" / "compose overlay" branches already do (see the "A1"
 * comments in `definition-engine.ts`). Before this fix, the fresh-create
 * branch discarded `applyPackagePostWorkspace`'s per-item result bag
 * entirely — the most-travelled install path (first-time install) could
 * have every declared capability fail and still return a clean payload with
 * `layers` absent.
 *
 * No live Postgres in this environment — DB + the heavy service doors are
 * mocked (same posture as `capabilities.create-verb-wiring.test.ts`); only
 * `applyPackagePostWorkspace`'s real per-item result-bag shape and the real
 * `summarizePostWorkspaceLayers` derivation are exercised, so the assertion
 * is on the ACTUAL shape the fresh-create branch now forwards.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  createdWorkspace: {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    profileIds: ["p1"],
    viewIds: ["v1"],
    entityIds: [] as string[],
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        // Only the "materialize pod admins?" gate reads this on the
        // fresh-create success path — `settings: null` reads as a
        // non-pod-visible workspace, so that best-effort branch no-ops.
        workspaces: {
          findFirst: vi.fn().mockResolvedValue({ settings: null }),
        },
        workspaceMembers: { findFirst: vi.fn() },
      },
    },
    createWorkspaceFromDefinition: vi
      .fn()
      .mockResolvedValue(h.createdWorkspace),
  };
});

vi.mock("../services/workspace-composition.js", () => ({
  resolveWorkspaceExtends: vi.fn(async (definition: unknown) => ({
    definition,
    provenance: [],
  })),
}));

// The exact per-item failure `applyPackagePostWorkspace` produces for a
// capability entry with neither `templateKey` nor `definition` — verified
// against `package-apply-post-workspace.ts`'s capabilities loop, which
// catches this per-item and does NOT throw (unlike a `loops[]` failure,
// which rethrows). Real DB, no CP/template-cache lookup involved.
vi.mock("../services/package-apply-post-workspace.js", () => ({
  applyPackagePostWorkspace: vi.fn().mockResolvedValue({
    capabilities: [
      {
        key: "inline",
        status: "error",
        message: "capability requires a definition or a valid templateKey",
      },
    ],
  }),
}));

vi.mock("@synap/events", () => ({
  emitSideEffects: vi.fn().mockResolvedValue(undefined),
  getBoss: vi.fn(() => ({ send: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock("../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: vi.fn(),
}));

vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn().mockResolvedValue(null),
}));

// A mutation → `readOnlyGuardMiddleware` runs first and calls
// `isPodReadOnly()` against the eager `db` singleton (mocked above with no
// `syncGeneration` table). No live PG here → stub it to "writable", same as
// `capabilities.create-verb-wiring.test.ts`.
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { router } from "../trpc.js";
import { definitionEngineProcedures } from "./workspaces/definition-engine.js";
import { summarizePostWorkspaceLayers } from "../services/capabilities/install-layers.js";
import type { Context } from "../types/context.js";

const testRouter = router({
  createFromDefinition: definitionEngineProcedures.createFromDefinition,
});

function caller() {
  return testRouter.createCaller({
    authenticated: true,
    userId: "user-1",
  } as unknown as Context);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("workspaces.createFromDefinition — fresh-create layers parity (A1)", () => {
  it("surfaces a failed post-workspace item via layers[] on first-time install", async () => {
    const result = await caller().createFromDefinition({
      definition: {
        workspaceName: "CFD Layers WS",
        profiles: [
          {
            slug: "cfd-profile",
            displayName: "Item",
            properties: [
              { slug: "status", label: "Status", valueType: "text" },
            ],
          },
        ],
        // Neither `templateKey` nor `definition` — deterministically fails
        // per-item WITHOUT the applier throwing, so this door still creates
        // the workspace and the failure must be reported via `layers[]`.
        capabilities: [{}],
      },
    });

    expect(result.outcome).toBe("created");
    expect(result.workspaceId).toBe(h.createdWorkspace.workspaceId);

    // THE REGRESSION: before the fix, `layers` was absent on this branch —
    // ALWAYS, regardless of whether post-workspace work failed.
    expect(Array.isArray(result.layers)).toBe(true);
    expect(result.layers).toHaveLength(1);

    // Exact `InstallLayerReport` shape — `message`, NEVER `detail` — the same
    // derivation `reconcileExisting`/compose-overlay already use.
    expect(result.layers?.[0]).toStrictEqual({
      layer: "post-workspace",
      status: "failed",
      message:
        "1 item(s) failed to apply — capabilities:inline: capability requires a definition or a valid templateKey",
    });
    expect(result.layers?.[0]).not.toHaveProperty("detail");
  });

  it("returns layers undefined (never []) when nothing failed — uniform key, never a conditional spread", async () => {
    const { applyPackagePostWorkspace } =
      await import("../services/package-apply-post-workspace.js");
    vi.mocked(applyPackagePostWorkspace).mockResolvedValueOnce({
      capabilities: [{ key: "inline", status: "created", created: true }],
    });

    const result = await caller().createFromDefinition({
      definition: {
        workspaceName: "CFD Layers WS Clean",
        capabilities: [{ definition: { key: "inline" } }],
      },
    });

    expect(result.outcome).toBe("created");
    expect(result.layers).toBeUndefined();
  });
});

// Sanity: the fixture's expected message is derived from the SAME pure
// function the fresh-create branch calls, so a change to that derivation's
// format can't silently desync this test's expectation from reality.
describe("summarizePostWorkspaceLayers sanity", () => {
  it("matches the exact fixture used above", () => {
    expect(
      summarizePostWorkspaceLayers({
        capabilities: [
          {
            key: "inline",
            status: "error",
            message: "capability requires a definition or a valid templateKey",
          },
        ],
      })
    ).toStrictEqual([
      {
        layer: "post-workspace",
        status: "failed",
        message:
          "1 item(s) failed to apply — capabilities:inline: capability requires a definition or a valid templateKey",
      },
    ]);
  });
});
