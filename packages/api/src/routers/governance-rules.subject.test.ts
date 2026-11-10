/**
 * Letting agents run one playbook without asking (founder decision, 10 Nov
 * 2026) is a `governanceRules.create` naming that playbook at a version
 * (0420). Three properties, driven through the real router:
 *   - only a PERSON grants it: an agent credential is refused (PERSON_ONLY)
 *     and nothing is written — an agent may never approve its own rule;
 *   - it holds for the version the person saw: a playbook edited since is
 *     refused (CONFLICT), naming its current version;
 *   - it lives where the playbook does, and only as an exact `playbook.run`.
 * Same db stubbing as `governance-rules.gating.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const WS = "11111111-1111-4111-8111-111111111111";
const OTHER_WS = "22222222-2222-4222-8222-222222222222";
const PLAYBOOK = "33333333-3333-4333-8333-333333333333";
const PERSON = "user-person";
const AGENT = "agent-1";

const h = vi.hoisted(() => ({
  insertedValues: [] as Record<string, unknown>[],
  updates: 0,
  playbook: {
    version: 3,
    workspaceId: "11111111-1111-4111-8111-111111111111",
  } as { version: number; workspaceId: string | null } | undefined,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      query: {
        // No pod-admin workspace configured: isPodAdmin() = false.
        workspaces: { findFirst: async () => undefined },
        workspaceMembers: { findFirst: async () => ({ role: "editor" }) },
        users: { findFirst: async () => undefined },
        playbooks: { findFirst: async () => h.playbook },
        governanceRules: {
          findFirst: async () => undefined,
          findMany: async () => [],
        },
      },
      insert: () => ({
        values: (v: Record<string, unknown>) => ({
          returning: async () => {
            h.insertedValues.push(v);
            return [{ id: "rule-1", ...v }];
          },
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => {
            h.updates += 1;
            return { returning: async () => [] };
          },
        }),
      }),
      select: () => ({
        from: () => ({ where: async () => [] }),
      }),
    },
  };
});

vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});

vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { governanceRulesRouter } from "./governance-rules.js";
import type { Context } from "../types/context.js";
import { playbookPreApprovalRule } from "@synap-core/types/governance-rules";

function caller(extra: Partial<Context> = {}) {
  return governanceRulesRouter.createCaller({
    authenticated: true,
    userId: PERSON,
    workspaceId: WS,
    ...extra,
  } as unknown as Context);
}

const allow = (version = 3, workspaceId: string | null = WS) =>
  playbookPreApprovalRule({ id: PLAYBOOK, version, workspaceId });

beforeEach(() => {
  h.insertedValues.length = 0;
  h.updates = 0;
  h.playbook = { version: 3, workspaceId: WS };
});

describe("letting agents run one playbook without asking", () => {
  it("a person allows the version they saw: the rule names the playbook at that version", async () => {
    const res = await caller().create(allow());
    expect(res.rule).toMatchObject({ id: "rule-1" });
    expect(h.insertedValues).toHaveLength(1);
    expect(h.insertedValues[0]).toMatchObject({
      principalKind: "any",
      scopeKind: "workspace",
      workspaceId: WS,
      targetKind: "action",
      targetPattern: "playbook.run",
      targetSubjectId: PLAYBOOK,
      targetSubjectVersion: 3,
      verdict: "auto",
    });
    // The older approvals of the same playbook are taken back.
    expect(h.updates).toBe(1);
  });

  it("an agent can never grant it, not even acting for its person", async () => {
    for (const ctx of [{ agentUserId: AGENT }, { keyType: "is_internal" }]) {
      await expect(
        caller(ctx as Partial<Context>).create(allow())
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        cause: { reasonCode: "PERSON_ONLY" },
      });
    }
    expect(h.insertedValues).toHaveLength(0);
  });

  it("a playbook edited since the person looked is refused, naming its current version", async () => {
    h.playbook = { version: 4, workspaceId: WS };
    await expect(caller().create(allow(3))).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("version 4"),
      cause: { reasonCode: "SUBJECT_VERSION_CHANGED" },
    });
    expect(h.insertedValues).toHaveLength(0);
  });

  it("an unknown playbook is not found", async () => {
    h.playbook = undefined;
    await expect(caller().create(allow())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("the rule lives where the playbook does", async () => {
    await expect(
      caller().create({ ...allow(), workspaceId: OTHER_WS })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.insertedValues).toHaveLength(0);
  });

  it("a subject only narrows an exact playbook.run rule, and needs its version", async () => {
    await expect(
      caller().create({ ...allow(), targetPattern: "playbook.*" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const { targetSubjectVersion: _v, ...noVersion } = allow();
    await expect(caller().create(noVersion)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(h.insertedValues).toHaveLength(0);
  });
});
