/**
 * package-apply-post-workspace — playbook `stages` + `scope` threading.
 *
 * REGRESSION (severance 2): the playbook branch called `playbooks.create` with
 * `{name, description, goalTemplate, params, executor, inputStrategy,
 * channelSpec, schedule, subjectProfile, metadata, status}` and NEVER `stages`
 * or `scope`. Every ordered stage a workspace template authored — including the
 * 6 stages of grants.yaml's "Grant Process" — was silently dropped, so they had
 * never reached the database on any pod, and a shipped PROJECT template was
 * impossible (everything landed session-scoped).
 *
 * The drop was invisible to `tsc` because the whole argument object carried a
 * blanket `as never` cast: a call site cast that wide defeats any tightening of
 * the callee's contract, including making `PlaybookStage.category` required.
 *
 * These tests pin the FIELDS that reach `playbooks.create`, so dropping one
 * again fails here rather than on a pod.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { createPlaybookMock } = vi.hoisted(() => ({
  createPlaybookMock: vi.fn(async (_input: Record<string, unknown>) => ({
    status: "created",
    playbook: { id: "pb-1" },
  })),
}));

vi.mock("../routers/playbooks.js", () => ({
  playbooksRouter: { createCaller: () => ({ create: createPlaybookMock }) },
}));
vi.mock("../routers/hub-protocol/utils.js", () => ({
  createHubProtocolCallerContext: vi.fn(async () => ({})),
}));
vi.mock("./links/links-service.js", () => ({
  createLinks: vi.fn(async () => []),
}));

// db.select()...limit() → [] : no existing playbook to reuse, so create runs.
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => [] as unknown[],
  };
  return { ...actual, db: { select: () => chain } };
});

import { applyPackagePostWorkspace } from "./package-apply-post-workspace.js";

const STAGES = [
  { key: "identify", name: "Identify", category: "planned" },
  { key: "draft", name: "Draft", category: "started" },
  { key: "awaiting", name: "Awaiting", category: "paused" },
];

const apply = (playbook: Record<string, unknown>) =>
  applyPackagePostWorkspace({
    workspaceId: "11111111-1111-1111-1111-111111111111",
    userId: "22222222-2222-2222-2222-222222222222",
    body: { playbooks: [playbook] },
  } as never);

describe("applyPackagePostWorkspace — playbook stages + scope", () => {
  beforeEach(() => createPlaybookMock.mockClear());

  it("threads authored stages through to playbooks.create", async () => {
    const res = await apply({
      name: "Grant Process",
      goalTemplate: "Advance this engagement.",
      stages: STAGES,
    });

    expect((res.playbooks as unknown[])[0]).toMatchObject({
      status: "created",
    });
    expect(createPlaybookMock).toHaveBeenCalledTimes(1);
    expect(createPlaybookMock.mock.calls[0][0]).toMatchObject({
      name: "Grant Process",
      stages: STAGES,
    });
  });

  it("threads scope:'project' — a shipped project template stays project-scoped", async () => {
    await apply({
      name: "Grant Process",
      goalTemplate: "Advance this engagement.",
      stages: STAGES,
      scope: "project",
    });
    expect(createPlaybookMock.mock.calls[0][0]).toMatchObject({
      scope: "project",
    });
  });

  it("no authored scope → undefined (playbooks.create reads it as session)", async () => {
    await apply({ name: "Plain", goalTemplate: "Do a thing." });
    const arg = createPlaybookMock.mock.calls[0][0];
    expect(arg.scope).toBeUndefined();
    expect(arg.stages).toBeUndefined();
  });

  it("REJECTS a category-less authored stage at this door", async () => {
    const res = await apply({
      name: "Bad",
      goalTemplate: "Do a thing.",
      stages: [{ key: "identify", name: "Identify" }],
    });
    expect(createPlaybookMock).not.toHaveBeenCalled();
    expect((res.playbooks as { status: string }[])[0].status).toBe("error");
  });

  it("REJECTS duplicate stage keys at this door", async () => {
    const res = await apply({
      name: "Dup",
      goalTemplate: "Do a thing.",
      stages: [
        { key: "a", name: "A", category: "started" },
        { key: "a", name: "A again", category: "started" },
      ],
    });
    expect(createPlaybookMock).not.toHaveBeenCalled();
    expect((res.playbooks as { status: string }[])[0].status).toBe("error");
  });
});
