/**
 * The Hub `createEntity` door (what `synap_create_entity` calls):
 *
 *  - ticket 13a82f38 — `idempotencyKey` derives the id the entity lands under
 *    (`proposedEntityId`, the `post_message` way: the key keys the ROW), so a
 *    retried create whose answer was lost reaches `entities.create` with the
 *    SAME id, where the caller's own live row comes back instead of a twin
 *    (that branch is `entities.create`'s own, at the top of its mutation);
 *  - ticket d39eb826 — the door names where the row lives
 *    (`entityWorkspaceId`, `null` = pod-wide) and, for a pod-wide row, the
 *    space it is filed for (`entityHomeWorkspaceId`, 0355), beside the
 *    governance lens it has always echoed as `workspaceId`.
 *
 * The REAL hub procedure; the regular `entities.create` is replaced by its
 * answer, and records the input it was handed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  answer: {} as Record<string, unknown>,
  inputs: [] as Array<Record<string, unknown>>,
  contexts: [] as Array<Record<string, unknown>>,
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
    workspaceId?: string | null
  ) => ({ userId, workspaceId: workspaceId ?? null }),
}));
vi.mock("../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: vi.fn(),
}));
vi.mock("../entities.js", () => ({
  entitiesRouter: {
    createCaller: (ctx: Record<string, unknown>) => ({
      create: async (input: Record<string, unknown>) => {
        h.inputs.push(input);
        h.contexts.push(ctx);
        return h.answer;
      },
    }),
  },
}));

import { entitiesRouter as hubEntitiesRouter } from "./entities.js";
import { deterministicUuidFromKey } from "../../utils/write-door-idempotency.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "44444444-4444-4444-8444-444444444444";
const SPACE = "55555555-5555-4555-8555-555555555555";
const ENTITY = "33333333-3333-4333-8333-333333333333";

const createAs = (userId: string, extra: Record<string, unknown> = {}) =>
  hubEntitiesRouter
    .createCaller({
      userId,
      scopes: ["hub-protocol.write"],
      workspaceId: SPACE,
    } as never)
    .createEntity({
      userId,
      profileSlug: "note",
      title: "Call notes",
      ...extra,
    } as never) as Promise<Record<string, unknown>>;

beforeEach(() => {
  h.inputs = [];
  h.contexts = [];
  h.answer = { status: "created", id: ENTITY, entity: { workspaceId: null } };
});

describe("hub createEntity — idempotencyKey keys the row (13a82f38)", () => {
  it("a retry with the same key reaches entities.create with the same id", async () => {
    await createAs(USER, { idempotencyKey: "import-doc-17" });
    await createAs(USER, { idempotencyKey: " import-doc-17 " });
    const [first, retry] = h.inputs;
    expect(first!.proposedEntityId).toBe(
      deterministicUuidFromKey(`create_entity:${USER}:import-doc-17`)
    );
    expect(retry!.proposedEntityId).toBe(first!.proposedEntityId);
  });

  it("another key, or another owner's same key, is another id", async () => {
    await createAs(USER, { idempotencyKey: "a" });
    await createAs(USER, { idempotencyKey: "b" });
    await createAs(OTHER_USER, { idempotencyKey: "a" });
    const ids = h.inputs.map((i) => i.proposedEntityId);
    expect(new Set(ids).size).toBe(3);
  });

  it("no key (or a blank one): the door mints the id as before", async () => {
    await createAs(USER);
    await createAs(USER, { idempotencyKey: "   " });
    expect(h.inputs[0]).not.toHaveProperty("proposedEntityId");
    expect(h.inputs[1]).not.toHaveProperty("proposedEntityId");
  });
});

describe("hub createEntity — where the row lives (d39eb826)", () => {
  it("a pod-wide row reads null, beside the lens it was governed under", async () => {
    const out = await createAs(USER);
    expect(out.entityWorkspaceId).toBeNull();
    expect(out.entityHomeWorkspaceId).toBeNull();
    expect(out.workspaceId).toBe(SPACE);
  });

  it("a pod-wide row filed for the lens names that home", async () => {
    h.answer = {
      status: "created",
      id: ENTITY,
      entity: { workspaceId: null, homeWorkspaceId: SPACE },
    };
    const out = await createAs(USER);
    expect(out.entityWorkspaceId).toBeNull();
    expect(out.entityHomeWorkspaceId).toBe(SPACE);
  });

  it("the ambient lens reaches entities.create as the caller's workspace, never as a pin", async () => {
    // The home is set by entities.create from ctx.workspaceId (0355); a
    // targetWorkspaceId would pin the pod-wide kind INTO the space instead.
    await createAs(USER);
    expect(h.inputs[0]).not.toHaveProperty("targetWorkspaceId");
    expect(h.contexts[0]).toMatchObject({ workspaceId: SPACE });
  });

  it("a row in a space reads that space", async () => {
    h.answer = {
      status: "created",
      id: ENTITY,
      entity: { workspaceId: SPACE },
    };
    expect((await createAs(USER)).entityWorkspaceId).toBe(SPACE);
  });

  it("a proposal reads its materialize target", async () => {
    h.answer = {
      status: "proposed",
      proposalId: "p-1",
      proposedEntityId: ENTITY,
      entity: null,
      effectiveWorkspaceId: null,
      effectiveHomeWorkspaceId: SPACE,
    };
    const out = await createAs(USER);
    expect(out.entityWorkspaceId).toBeNull();
    expect(out.entityHomeWorkspaceId).toBe(SPACE);
  });

  it("no row named: no claim about one", async () => {
    h.answer = { status: "created", id: ENTITY, entity: null };
    const out = await createAs(USER);
    expect(out).not.toHaveProperty("entityWorkspaceId");
    expect(out).not.toHaveProperty("entityHomeWorkspaceId");
  });
});
