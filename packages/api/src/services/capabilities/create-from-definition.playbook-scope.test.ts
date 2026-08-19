/**
 * createCapabilityFromDefinition — playbook `scope` threading.
 *
 * REGRESSION (severance 1): `CapabilityPlaybookDef` had no `scope` field and
 * the `playbooksCaller.create` call never passed one, so EVERY playbook a
 * package shipped was created session-scoped — a shipped PROJECT template was
 * impossible. (Confirmed against the live team pod: 36 playbooks, all
 * `scope:'session'`, zero project-scoped.)
 *
 * `stages` was ALREADY threaded on this door — the drop was `scope` only. The
 * third test pins stages so the pair can never diverge again.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createPlaybookMock } = vi.hoisted(() => ({
  createPlaybookMock: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "created",
    playbook: { id: "pb-1" },
  })),
}));

vi.mock("../../routers/playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ create: createPlaybookMock }) },
}));
vi.mock("./cp-template-client.js", () => ({
  fetchCPCapabilityTemplate: vi.fn(async () => null),
}));
vi.mock("../links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));
// The capability container is created AFTER the playbooks step; stubbed so the
// test isolates the playbook branch instead of needing an authenticated ctx.
vi.mock("../../routers/capability-containers.js", () => ({
  capabilityContainersRouter: {
    createCaller: () => ({
      create: vi.fn(async () => ({ capability: { id: "cap-1" } })),
      addPart: vi.fn(async () => ({ ok: true })),
    }),
  },
}));

// No existing playbook to reuse → the create branch runs.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  const upd = { set: () => upd, where: async () => undefined };
  return {
    ...actual,
    db: { select: () => chain, update: () => upd },
  };
});

import { createCapabilityFromDefinition } from "./create-from-definition.js";

const WS = "11111111-1111-1111-1111-111111111111";
const UID = "22222222-2222-2222-2222-222222222222";

const applyDef = (playbook: Record<string, unknown>) =>
  createCapabilityFromDefinition(
    {
      key: "test.cap",
      name: "Test Capability",
      vault: [],
      tools: [],
      skills: [],
      playbooks: [playbook],
    } as never,
    {},
    { userId: UID, workspaceId: WS } as never
  );

describe("createCapabilityFromDefinition — playbook scope", () => {
  beforeEach(() => createPlaybookMock.mockClear());

  it("a def carrying scope:'project' produces a PROJECT-scoped playbook", async () => {
    await applyDef({
      name: "Grant Process",
      goalTemplate: "Advance this engagement.",
      scope: "project",
    });
    expect(createPlaybookMock).toHaveBeenCalledTimes(1);
    expect(createPlaybookMock.mock.calls[0][0]).toMatchObject({
      scope: "project",
    });
  });

  it("a def with NO scope still produces a session playbook (no behaviour change)", async () => {
    await applyDef({ name: "Plain", goalTemplate: "Do a thing." });
    const arg = createPlaybookMock.mock.calls[0][0];
    expect(arg.scope).toBeUndefined();
  });

  it("still threads stages alongside scope", async () => {
    const stages = [{ key: "identify", name: "Identify", category: "planned" }];
    await applyDef({
      name: "Staged",
      goalTemplate: "Do a thing.",
      scope: "project",
      stages,
    });
    expect(createPlaybookMock.mock.calls[0][0]).toMatchObject({
      scope: "project",
      stages,
    });
  });
});
