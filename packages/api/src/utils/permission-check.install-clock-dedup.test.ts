/**
 * The install clock on a package source-link (`metadata.marketSource.installedAt`)
 * must not tell two proposals apart — through the REAL door, for each kind a
 * package install or reconcile files with that stamp.
 *
 * MEASURED DEFECT (live, 2026-11-16): every `synap templates update` run
 * filed a fresh pending proposal beside the last, because each run stamps
 * `installedAt: new Date().toISOString()` into the source-link and the dedup
 * hash read it. backend#1078 dropped the clock from a CREATE's identity
 * (`createdRecordIdentity`); an UPDATE's hash still read its whole patch, and
 * the playbook reconcile (`reconcile-installed-playbooks.ts` → `playbooks.update`)
 * replays the re-stamped source-link on every run.
 *
 * Seam: the row `checkPermissionOrPropose` hands the ONE pending insert,
 * hashed by the REAL `computeProposalDedupHash`. The gate `data` of each case
 * is the shape its router builds (cited per case). Engine and write seams
 * mocked as in `permission-check.create-dedup-hash.test.ts`. This does not
 * drive the routers themselves: a router that stops sending the stamp, or
 * starts sending it somewhere else, is outside this file.
 *
 * Rows that rule out a wrong rule, per kind:
 *  - the same write, filed by two runs (fresh clock) ⇒ EQUAL;
 *  - a real field difference ⇒ UNEQUAL (rules out dropping the source-link,
 *    the metadata or the record from the hash);
 *  - an update of another target ⇒ UNEQUAL (rules out dropping the target).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGov, mockVerifyPermission, mockInsertPendingProposal, mockValues } =
  vi.hoisted(() => ({
    mockGov: vi.fn(),
    mockVerifyPermission: vi.fn(),
    mockInsertPendingProposal: vi.fn(),
    mockValues: vi.fn(),
  }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const select = () => {
    const b: Record<string, unknown> = {
      from: vi.fn(() => b),
      where: vi.fn(() => b),
      orderBy: vi.fn(() => b),
      leftJoin: vi.fn(() => b),
      innerJoin: vi.fn(() => b),
      limit: vi.fn().mockResolvedValue([]),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    };
    return b;
  };
  return {
    ...actual,
    db: {
      insert: vi.fn(() => ({ values: mockValues })),
      select,
      transaction: async (cb: (tx: unknown) => unknown) =>
        cb({ insert: vi.fn(() => ({ values: mockValues })) }),
      query: {
        focusSessions: { findFirst: vi.fn().mockResolvedValue(undefined) },
        entities: { findFirst: vi.fn().mockResolvedValue(undefined) },
        playbooks: { findFirst: vi.fn().mockResolvedValue(undefined) },
        automations: { findFirst: vi.fn().mockResolvedValue(undefined) },
        skills: { findFirst: vi.fn().mockResolvedValue(undefined) },
      },
    },
    insertPendingProposal: mockInsertPendingProposal,
    resolveAgentProposalSessionOnce: vi.fn().mockResolvedValue(null),
    resolveOrCreateAgentProposalSession: vi.fn().mockResolvedValue(null),
    deriveAgentProposalSessionGoal: vi.fn(() => "goal"),
    deriveProposalProjectId: vi.fn(async () => null),
    findExistingPendingDuplicate: vi.fn().mockResolvedValue(null),
    verifyPermission: mockVerifyPermission,
  };
});

vi.mock("@synap/database/agent-governance", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@synap/database/agent-governance")
  >()),
  resolveAgentGovernanceDecision: mockGov,
  resolveGovernanceRule: vi.fn().mockResolvedValue(null),
}));

vi.mock("@synap/jobs", () => ({
  broadcastNotification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@synap/events", () => ({ emitSideEffects: vi.fn() }));
vi.mock("../notifications/NotificationService.js", () => ({
  NotificationService: { fromProposal: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock("../notifications/notify-pod-wide-proposal.js", () => ({
  notifyPodWideProposal: vi.fn(),
}));
vi.mock("../lib/event-helpers.js", () => ({
  logEvent: vi.fn().mockResolvedValue("event-1"),
}));

import { computeProposalDedupHash } from "@synap/database";
import { checkPermissionOrPropose } from "./permission-check.js";

const RUN_1 = "2026-11-15T09:00:00.000Z";
const RUN_2 = "2026-11-16T21:30:00.000Z";

/** The source-link a package run stamps (`buildMarketSource` + `stampMarketSource`). */
function stamped(
  installedAt: string,
  baseline: Record<string, unknown>,
  rest: Record<string, unknown> = {}
) {
  return {
    ...rest,
    marketSource: {
      packageSlug: "builder-dev",
      packageVersion: "1.4.0",
      installedAt,
      baseline,
    },
  };
}

/** File one agent write through the real door; return the stored row's hash. */
async function fileAndHash(write: {
  subjectType: "playbook" | "automation" | "skill";
  action: "create" | "update";
  data: Record<string, unknown>;
}): Promise<string> {
  mockInsertPendingProposal.mockClear();
  await checkPermissionOrPropose({
    userId: "user-abc",
    agentUserId: "agent-7",
    workspaceId: "ws-123",
    subjectType: write.subjectType,
    action: write.action,
    source: "intelligence",
    data: write.data,
  });
  expect(mockInsertPendingProposal).toHaveBeenCalledTimes(1);
  const row = mockInsertPendingProposal.mock.calls[0]![0] as {
    workspaceId: string | null;
    proposalType: string;
    targetType: string;
    targetId: string;
    data: Record<string, unknown>;
  };
  // Non-vacuity: the stamp REACHES the stored row (one level down, in the
  // request envelope), so an EQUAL hash below is the strip, not its absence.
  expect(row.data).toMatchObject({
    changeType: write.action,
    data: { metadata: { marketSource: { installedAt: expect.any(String) } } },
  });
  return computeProposalDedupHash(row);
}

/**
 * `playbooks.update` gate data (routers/playbooks.ts, step 3): `{ id, …patch,
 * metadata }`, as the reconcile replays it.
 */
const playbookUpdate = (
  installedAt: string,
  over: { id?: string; goal?: string } = {}
) => {
  const stages = [
    {
      key: "fix-in-code",
      name: "Fix in code",
      goal: over.goal ?? "Reproduce the finding and fix it at the root.",
    },
  ];
  return {
    subjectType: "playbook" as const,
    action: "update" as const,
    data: {
      id: over.id ?? "playbook-1",
      stages,
      metadata: stamped(installedAt, { scope: "session", stages }),
    },
  };
};

/**
 * `automations.create` agent-branch gate data (routers/automations.ts):
 * the full create input, author metadata under the stamp
 * (marketplace-install.ts, automation case).
 */
const automationCreate = (installedAt: string, name = "Weekly digest") => {
  const fields = {
    name,
    description: "Send the week's digest.",
    triggerType: "cron",
    triggerConfig: { cron: "0 9 * * 1" },
    flowDefinition: { nodes: [], edges: [] },
  };
  return {
    subjectType: "automation" as const,
    action: "create" as const,
    data: {
      ...fields,
      status: "active",
      metadata: stamped(installedAt, fields, { kind: "digest" }),
      state: undefined,
    },
  };
};

/**
 * `skills.create` gate data (routers/skills.ts, step 1): the minted id and
 * the resolved insert shape. `metadata` rides ONLY for a box skill
 * (`executionMode === "box"`), so that is the one skill create that can
 * carry the stamp into a proposal.
 */
const skillCreate = (
  installedAt: string,
  mintedId: string,
  code = "export default () => 1"
) => {
  const fields = {
    name: "Digest builder",
    kind: "code",
    executionMode: "box",
    code,
  };
  return {
    subjectType: "skill" as const,
    action: "create" as const,
    data: {
      id: mintedId,
      userId: "user-abc",
      workspaceId: "ws-123",
      scope: "pod",
      agentTypes: null,
      slug: "digest-builder",
      description: "Builds the digest.",
      body: null,
      providerSpec: null,
      parameters: {},
      category: "content",
      timeoutSeconds: 30,
      ...fields,
      metadata: stamped(installedAt, fields, {
        box: { language: "node", packages: [] },
      }),
    },
  };
};

describe("the install clock never tells two proposals apart (real door)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "receipt-1" }]),
    });
    mockInsertPendingProposal.mockResolvedValue({
      proposal: { id: "proposal-1" },
      deduped: false,
    });
    mockVerifyPermission.mockResolvedValue({ allowed: true });
    mockGov.mockResolvedValue({
      decision: "propose",
      reason: "A person approves this.",
      reasonCode: "DEFAULT_PROPOSE",
    });
  });

  describe("playbook update (the reconcile)", () => {
    it("two runs differing only in the clock hash EQUAL", async () => {
      expect(await fileAndHash(playbookUpdate(RUN_1))).toBe(
        await fileAndHash(playbookUpdate(RUN_2))
      );
    });
    it("a real field difference (a stage's goal) hashes UNEQUAL", async () => {
      expect(await fileAndHash(playbookUpdate(RUN_1))).not.toBe(
        await fileAndHash(
          playbookUpdate(RUN_2, { goal: "Reproduce, fix and gate." })
        )
      );
    });
    it("the same patch on another playbook hashes UNEQUAL", async () => {
      expect(await fileAndHash(playbookUpdate(RUN_1))).not.toBe(
        await fileAndHash(playbookUpdate(RUN_1, { id: "playbook-2" }))
      );
    });
  });

  describe("automation create (covered by #1078's create identity)", () => {
    it("two runs differing only in the clock hash EQUAL", async () => {
      expect(await fileAndHash(automationCreate(RUN_1))).toBe(
        await fileAndHash(automationCreate(RUN_2))
      );
    });
    it("a real field difference (the name) hashes UNEQUAL", async () => {
      expect(await fileAndHash(automationCreate(RUN_1))).not.toBe(
        await fileAndHash(automationCreate(RUN_2, "Daily digest"))
      );
    });
  });

  describe("box skill create (covered by #1078's create identity)", () => {
    it("two runs differing only in the clock and the minted id hash EQUAL", async () => {
      expect(await fileAndHash(skillCreate(RUN_1, "skill-a"))).toBe(
        await fileAndHash(skillCreate(RUN_2, "skill-b"))
      );
    });
    it("a real field difference (the code) hashes UNEQUAL", async () => {
      expect(await fileAndHash(skillCreate(RUN_1, "skill-a"))).not.toBe(
        await fileAndHash(
          skillCreate(RUN_2, "skill-b", "export default () => 2")
        )
      );
    });
  });
});
