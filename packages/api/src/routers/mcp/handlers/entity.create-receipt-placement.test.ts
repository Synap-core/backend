/**
 * `synap_create_entity`'s receipt says where the entity LIVES (ticket d39eb826),
 * and the door forwards an `idempotencyKey` (ticket 13a82f38).
 *
 * The live case: 69 notes created with a `workspaceId`. Every receipt said
 * `effectiveWorkspaceId: <that space>`, but `note` is a pod-wide kind, so each
 * row sat at `workspaceId: null` and the agent moved every one by hand. The
 * founder's answer: a pod-wide kind stays pod-wide and is filed FOR the space
 * asked for (its home, 0355), so it shows there with no move; the receipt
 * says so, and says when the space was NOT applied (a space the caller is not
 * a member of, which the adapter drops as a lens).
 *
 * Driven through the real handler and the real receipt builder; only the hub
 * caller (its answer is the `entityWorkspaceId` / `entityHomeWorkspaceId` the
 * hub door reads off the row, pinned in
 * `hub-protocol/entities.create-receipt.test.ts`; the home itself is set by
 * `entities.create`, pinned in `entities.create-home-workspace.pglite.test.ts`)
 * and the name resolver (DB reads) are faked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  answer: {} as Record<string, unknown>,
}));

vi.mock("../../../services/entity-resolution.js", () => ({
  resolveEntityByName: async () => ({ sameProfile: null, otherProfiles: [] }),
}));

vi.mock("../../hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: async () => ({}),
}));

import { entityHandlers } from "./entity.js";
import type { McpToolContext } from "./shared.js";

const SPACE = "808939d1-86b3-4c52-a153-ae06ece2c54e";
const OTHER = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const ID = "eeeeeeee-1111-4111-8111-111111111111";

const fakeLensCaller = {
  entities: {
    createEntity: async (input: Record<string, unknown>) => {
      h.createCalls.push(input);
      return h.answer;
    },
  },
};

function ctx(
  args: Record<string, unknown>,
  lensWorkspaceId?: string
): McpToolContext {
  return {
    toolName: "synap_create_entity",
    args,
    userId: "user-owner",
    apiKeyScopes: ["mcp.read", "mcp.write"],
    lensCaller: fakeLensCaller,
    caller: {},
    lensWorkspaceId,
  } as unknown as McpToolContext;
}

type Result = { content: Array<{ text?: string }> };
const create = async (args: Record<string, unknown>, lens?: string) =>
  JSON.parse(
    ((await entityHandlers.synap_create_entity!(ctx(args, lens))) as Result)
      .content[0]!.text!
  );

beforeEach(() => {
  h.createCalls = [];
  h.answer = {};
});

describe("synap_create_entity — the receipt names where the entity lives (d39eb826)", () => {
  it("THE LIVE CASE: a pod-wide note created with a workspaceId is filed for that space, no move needed", async () => {
    h.answer = {
      status: "created",
      id: ID,
      workspaceId: SPACE, // the hub's lens echo
      entityWorkspaceId: null, // the row stays pod-wide…
      entityHomeWorkspaceId: SPACE, // …filed for the space asked for
    };
    const out = await create(
      { profileSlug: "note", title: "Call notes", workspaceId: SPACE },
      SPACE
    );
    expect(out.effectiveWorkspaceId).toBeNull();
    expect(out.writeReceipt.effectiveWorkspaceId).toBeNull();
    expect(out.placement).toMatchObject({
      workspaceId: null,
      homeWorkspaceId: SPACE,
      requestedWorkspaceId: SPACE,
      applied: true,
    });
    expect(out.placement.note).toMatch(/note is a pod-wide kind/);
    expect(out.placement.note).toMatch(/No synap_move_entities needed/);
  });

  it("a space the caller is not a member of: dropped as a lens, and said", async () => {
    h.answer = {
      status: "created",
      id: ID,
      entityWorkspaceId: null,
      entityHomeWorkspaceId: null,
    };
    // The adapter dropped the lens (no `lensWorkspaceId`): the requested id
    // survives only in the args.
    const out = await create({
      profileSlug: "note",
      title: "Call notes",
      workspaceId: OTHER,
    });
    expect(out.effectiveWorkspaceId).toBeNull();
    expect(out.placement).toMatchObject({
      workspaceId: null,
      requestedWorkspaceId: OTHER,
      applied: false,
    });
    expect(out.placement).not.toHaveProperty("homeWorkspaceId");
    expect(out.placement.note).toMatch(/not a space you are a member of/);
    expect(out.placement.note).toMatch(/readable by you only/);
  });

  it("a pod-wide row filed for no space says the space only governed the write", async () => {
    h.answer = {
      status: "created",
      id: ID,
      workspaceId: SPACE,
      entityWorkspaceId: null,
      entityHomeWorkspaceId: null,
    };
    const out = await create(
      { profileSlug: "note", title: "Call notes" },
      SPACE
    );
    expect(out.placement).toMatchObject({
      workspaceId: null,
      requestedWorkspaceId: SPACE,
      applied: false,
    });
    expect(out.placement.note).toMatch(/filed for no space/);
  });

  it("a proposal says where it WILL be filed", async () => {
    h.answer = {
      status: "proposed",
      proposalId: "prop-1",
      proposedEntityId: ID,
      workspaceId: SPACE,
      entityWorkspaceId: null,
      entityHomeWorkspaceId: SPACE,
    };
    const out = await create(
      { profileSlug: "note", title: "Call notes" },
      SPACE
    );
    expect(out.effectiveWorkspaceId).toBeNull();
    expect(out.placement).toMatchObject({
      homeWorkspaceId: SPACE,
      applied: true,
    });
  });

  it("a kind placed elsewhere names that space", async () => {
    h.answer = {
      status: "created",
      id: ID,
      workspaceId: SPACE,
      entityWorkspaceId: OTHER,
    };
    const out = await create({ profileSlug: "deal", title: "Acme" }, SPACE);
    expect(out.effectiveWorkspaceId).toBe(OTHER);
    expect(out.placement.note).toContain(OTHER);
  });

  it("a workspace kind that landed in the space it was asked for carries no placement note", async () => {
    h.answer = {
      status: "created",
      id: ID,
      workspaceId: SPACE,
      entityWorkspaceId: SPACE,
    };
    const out = await create({ profileSlug: "task", title: "Ship" }, SPACE);
    expect(out.effectiveWorkspaceId).toBe(SPACE);
    expect(out).not.toHaveProperty("placement");
  });

  it("no space asked for: nothing to explain", async () => {
    h.answer = { status: "created", id: ID, entityWorkspaceId: null };
    const out = await create({ profileSlug: "note", title: "Call notes" });
    expect(out.effectiveWorkspaceId).toBeNull();
    expect(out).not.toHaveProperty("placement");
  });

  it("a door that named no row keeps the old lens echo", async () => {
    h.answer = { status: "proposed", proposalType: "join", workspaceId: SPACE };
    const out = await create(
      { profileSlug: "note", title: "Call notes" },
      SPACE
    );
    expect(out.effectiveWorkspaceId).toBe(SPACE);
    expect(out).not.toHaveProperty("placement");
  });
});

describe("synap_create_entity — idempotencyKey reaches the door (13a82f38)", () => {
  it("forwards the key", async () => {
    h.answer = { status: "created", id: ID, entityWorkspaceId: null };
    await create({ profileSlug: "note", title: "x", idempotencyKey: "imp-42" });
    expect(h.createCalls[0]!.idempotencyKey).toBe("imp-42");
  });

  it("sends none when the caller sent none (or a blank one)", async () => {
    h.answer = { status: "created", id: ID, entityWorkspaceId: null };
    await create({ profileSlug: "note", title: "x" });
    await create({ profileSlug: "note", title: "x", idempotencyKey: "  " });
    expect(h.createCalls[0]).not.toHaveProperty("idempotencyKey");
    expect(h.createCalls[1]).not.toHaveProperty("idempotencyKey");
  });
});
