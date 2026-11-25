/**
 * Hub `profiles.setRenderer` (the door `PATCH`-style agents and MCP
 * `synap_promote_cell_to_renderer` bind a renderer through) holds a
 * per-object target to ONE object BEFORE its gate.
 *
 * The defect it pins (review rev-code, finding 6310e11b): the door checked the
 * object only when a `subjectId` was sent, so `profileSlug: 'view'` with none
 * passed every check and filed (or applied) a WHOLE-KIND view binding that
 * every view's detail page falls back to. Now the shared target rule
 * (`assertRendererBindingTarget`) refuses it in the caller's reply and files
 * nothing.
 *
 * Behavioural through the real router and the real target rule. Mocked: the
 * gate (to see whether it was reached), the write, and the cell lookups (a
 * cell is not what this pins).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const USER = "00000000-0000-4000-8000-0000000000a1";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  setProfileRenderer: vi.fn(),
}));

vi.mock("../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/permission-check.js")>()),
  checkPermissionOrPropose: h.gate,
}));
vi.mock("../../services/profiles/set-profile-renderer.js", () => ({
  setProfileRenderer: h.setProfileRenderer,
}));
vi.mock(
  "../../services/renderers/renderer-target-checks.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../services/renderers/renderer-target-checks.js")
    >()),
    assertCellBindable: vi.fn(async () => undefined),
    cellRendererRefFor: vi.fn(async (cellKey: string) => ({
      kind: "cell",
      cellKey,
      props: {},
    })),
  })
);

import { hubProfilesRouter } from "./profiles.js";

function caller() {
  return hubProfilesRouter.createCaller({
    authenticated: true,
    userId: USER,
    apiKeyId: "key-1",
    scopes: ["hub-protocol.write"],
  } as never);
}

beforeEach(() => {
  h.gate.mockReset();
  h.gate.mockResolvedValue({ proposalId: "proposal-1" });
  h.setProfileRenderer.mockReset();
});

describe("hub profiles.setRenderer — a per-object target names one object", () => {
  it.each(["view", "playbook"] as const)(
    "refuses a %s renderer with no subjectId, and files nothing",
    async (profileSlug) => {
      const run = caller().setRenderer({
        userId: USER,
        profileSlug,
        slot: "detail",
        cellKey: "greeting",
        scope: "user",
      });
      await expect(run).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(run).rejects.toThrow(/pass its id as subjectId/);
      expect(h.gate).not.toHaveBeenCalled();
      expect(h.setProfileRenderer).not.toHaveBeenCalled();
    }
  );

  it("refuses a subjectId that names nothing the caller can open, and files nothing", async () => {
    const run = caller().setRenderer({
      userId: USER,
      profileSlug: "view",
      slot: "detail",
      cellKey: "greeting",
      scope: "user",
      subjectId: "not-an-object",
    });
    await expect(run).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.gate).not.toHaveBeenCalled();
  });

  it("CONTROL — a whole-kind binding of an entity kind still reaches the gate", async () => {
    const res = await caller().setRenderer({
      userId: USER,
      profileSlug: "note",
      slot: "detail",
      cellKey: "greeting",
      scope: "user",
    });
    expect(res).toMatchObject({ status: "proposed", proposalId: "proposal-1" });
    expect(h.gate).toHaveBeenCalledTimes(1);
  });
});
