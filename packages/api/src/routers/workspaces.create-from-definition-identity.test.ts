/**
 * `workspaces.createFromDefinition` — template identity (0308).
 *
 *   - a catalog definition's `_meta.slug` is adopted as `packageSlug` when the
 *     caller passed none, so the create stamps the template's identity;
 *   - a TEMPLATE input (`templateId` / `templateName` / `_meta`) with no slug,
 *     no `proposalId` and no target `workspaceId` is refused (BAD_REQUEST)
 *     before anything is created — it would mint a second space on every call;
 *   - a freehand input is unchanged.
 * Same mocked harness as `workspaces.create-from-definition-layers.test.ts`.
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

vi.mock("../utils/tier-check.js", () => ({
  assertPackageTierAccess: vi.fn().mockResolvedValue(undefined),
}));

import { router } from "../trpc.js";
import { definitionEngineProcedures } from "./workspaces/definition-engine.js";
import { createWorkspaceFromDefinition } from "@synap/database";
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

describe("workspaces.createFromDefinition — template identity", () => {
  it("a template input with no slug, no key and no target → BAD_REQUEST, nothing created", async () => {
    for (const extra of [
      { templateName: "Content OS" },
      { templateId: "tpl-1" },
    ]) {
      await expect(
        caller().createFromDefinition({
          definition: { workspaceName: "Content OS" },
          ...extra,
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(
      caller().createFromDefinition({
        definition: { workspaceName: "Content OS", _meta: { version: "h" } },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(createWorkspaceFromDefinition).not.toHaveBeenCalled();
  });

  it("`_meta.slug` is adopted as the package slug of the create", async () => {
    await caller().createFromDefinition({
      definition: {
        workspaceName: "Content OS",
        _meta: { slug: "content-os" },
      },
      templateName: "Content OS",
    });
    expect(
      vi.mocked(createWorkspaceFromDefinition).mock.calls[0][0]
    ).toMatchObject({ packageSlug: "content-os" });
  });

  it("a freehand input (no template marker) is unchanged", async () => {
    const r = await caller().createFromDefinition({
      definition: { workspaceName: "Scratch" },
    });
    expect(r.outcome).toBe("created");
    expect(
      vi.mocked(createWorkspaceFromDefinition).mock.calls[0][0].packageSlug
    ).toBeUndefined();
  });
});
