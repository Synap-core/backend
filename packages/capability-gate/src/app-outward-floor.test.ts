import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Intent actions, decision 4A (founder, 2026-10-28): a run requested through a
 * POD APP's credential (the request's grant names an app, `clientId`) on a verb
 * whose intent reaches OUTSIDE the pod always files a proposal, for every app —
 * the app's own agent key AND a `synap_acts_as: person` token, which resolves as
 * the person and so used to meet the owner bypass and post with no review.
 *
 * Each case rules out one wrong floor:
 *  - a person token on publish_post owner-bypassed       → "person token … proposes";
 *  - the floor reaching the person's own pod-UI use      → "no app … runs";
 *  - an auto grant widening an app run past it           → "app agent key with an auto grant";
 *  - the floor swallowing reads                          → "a read intent … runs";
 *  - an unknown intent read as safe                      → "no declared intent … proposes";
 *  - an agent's intent action auto-running past it       → "an intent action with no app …";
 *  - the floor outranking the approval floor             → "an unapproved verb is still denied";
 *  - edit_video seeded as a read (its effect is read out of migration 0370,
 *    not typed here)                                      → "edit_video … proposes".
 *
 * `@synap/database` is mocked: the request's grant (`getRequestGrant`) and the
 * `capability_intents` row are the two inputs the floor reads.
 */

const grantMock = vi.fn();
const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();
/** edit_video's effect as migration 0370 seeds it (decision ac1ba2b6). */
const EDIT_VIDEO_EFFECT = readFileSync(
  fileURLToPath(
    new URL(
      "../../database/migrations/0370_edit_video_intent.sql",
      import.meta.url
    )
  ),
  "utf8"
).match(/\(\s*'edit_video'\s*,\s*'(read|write|act)'/)?.[1];

const intentRows = new Map<string, { effect: string }>([
  ["publish_post", { effect: "write" }],
  ["list_records", { effect: "read" }],
  ["edit_video", { effect: EDIT_VIDEO_EFFECT ?? "missing" }],
]);
const skillRows = new Map<string, { intent: string | null }>();

const T = {
  tools: { __t: "tools" },
  skills: { __t: "skills", id: "skills.id", intent: "skills.intent" },
  capabilityIntents: { __t: "ci", slug: "ci.slug", effect: "ci.effect" },
};

const fakeDb = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: async (cond: { b: string }) => {
        if (table.__t === "ci") {
          const row = intentRows.get(cond.b);
          return row ? [row] : [];
        }
        if (table.__t === "skills") {
          const row = skillRows.get(cond.b);
          return row ? [row] : [];
        }
        return [];
      },
    }),
  }),
};

vi.mock("@synap/database", () => ({
  getDb: async () => fakeDb,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
  getRequestGrant: () => grantMock(),
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
  resolveOriginTrust: async () => undefined,
}));

vi.mock("@synap/database/schema", () => T);

const { gateCapabilityExecution } = await import("./index.js");

const APP_GRANT = {
  clientId: "app_content_studio",
  scopes: [
    { permissions: ["capability.publish_post.run"], workspaceIds: ["ws-1"] },
  ],
};

/** The person runs their own pod-wide Postiz verb (they own the skill). */
const personRun = (intent: string | null, over: object = {}) => ({
  capabilityKind: "skill" as const,
  capabilityId: "skill-1",
  skill: {
    id: "skill-1",
    approved: true,
    userId: "person-1",
    name: "postiz_schedule_post",
    intent,
  },
  actorUserId: "person-1",
  agentUserId: null,
  workspaceId: "ws-1",
  ...over,
});

describe("gateCapabilityExecution — an app's outward run always proposes (4A)", () => {
  beforeEach(() => {
    grantMock.mockReset();
    findCapabilityGrantMock.mockReset();
    resolveGovernanceRuleMock.mockReset();
    resolveGovernanceRuleMock.mockResolvedValue(undefined);
    skillRows.clear();
  });

  it("a person token on publish_post proposes instead of the owner bypass", async () => {
    grantMock.mockReturnValue(APP_GRANT);
    const decision = await gateCapabilityExecution(personRun("publish_post"));
    expect(decision).toMatchObject({
      decision: "propose",
      reasonCode: "APP_OUTWARD_INTENT",
      proposalType: "run",
    });
  });

  it("no app (the person in the pod, or a key with no app) still runs", async () => {
    grantMock.mockReturnValue(undefined);
    expect(await gateCapabilityExecution(personRun("publish_post"))).toEqual({
      decision: "run",
    });
    grantMock.mockReturnValue({ ...APP_GRANT, clientId: null });
    expect(await gateCapabilityExecution(personRun("publish_post"))).toEqual({
      decision: "run",
    });
  });

  it("an app agent key with an auto grant still proposes", async () => {
    grantMock.mockReturnValue(APP_GRANT);
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    const decision = await gateCapabilityExecution(
      personRun("publish_post", {
        actorUserId: "agent-1",
        agentUserId: "agent-1",
      })
    );
    expect(decision).toMatchObject({
      decision: "propose",
      reasonCode: "APP_OUTWARD_INTENT",
    });
  });

  it("a read intent, or a declared read, keeps its posture", async () => {
    grantMock.mockReturnValue(APP_GRANT);
    expect(await gateCapabilityExecution(personRun("list_records"))).toEqual({
      decision: "run",
    });
    expect(
      await gateCapabilityExecution(
        personRun("publish_post", { readOnly: true })
      )
    ).toEqual({ decision: "run" });
  });

  it("no declared intent, an unknown one, or a raw tool call proposes (fail closed)", async () => {
    grantMock.mockReturnValue(APP_GRANT);
    for (const intent of [null, "not_a_registered_intent"])
      expect(
        await gateCapabilityExecution(personRun(intent)),
        String(intent)
      ).toMatchObject({
        decision: "propose",
        reasonCode: "APP_OUTWARD_INTENT",
      });
    expect(
      await gateCapabilityExecution({
        capabilityKind: "tool",
        capabilityId: "tool-1",
        tool: { id: "tool-1", approved: true, createdBy: "person-1" },
        actorUserId: "person-1",
        agentUserId: null,
        workspaceId: "ws-1",
      })
    ).toMatchObject({ decision: "propose", reasonCode: "APP_OUTWARD_INTENT" });
  });

  it("reads the intent off the skill row when the caller did not pass it", async () => {
    grantMock.mockReturnValue(APP_GRANT);
    skillRows.set("skill-1", { intent: "publish_post" });
    const input = personRun("publish_post");
    const { intent: _drop, ...skill } = input.skill;
    expect(await gateCapabilityExecution({ ...input, skill })).toMatchObject({
      decision: "propose",
      reasonCode: "APP_OUTWARD_INTENT",
    });
  });

  it("an intent action with no app (an agent's key, the person's own) proposes too", async () => {
    grantMock.mockReturnValue(undefined);
    expect(
      await gateCapabilityExecution(
        personRun("publish_post", { intentRun: true })
      )
    ).toMatchObject({ decision: "propose", reasonCode: "INTENT_OUTWARD" });
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    expect(
      await gateCapabilityExecution(
        personRun("publish_post", {
          actorUserId: "agent-1",
          agentUserId: "agent-1",
          intentRun: true,
        })
      )
    ).toMatchObject({ decision: "propose", reasonCode: "INTENT_OUTWARD" });
    // A read intent action keeps its posture.
    expect(
      await gateCapabilityExecution(
        personRun("list_records", { intentRun: true })
      )
    ).toEqual({ decision: "run" });
  });

  it("edit_video (sends the person's video out, spends money) proposes for any app", async () => {
    expect(EDIT_VIDEO_EFFECT).toBeDefined();
    grantMock.mockReturnValue(APP_GRANT);
    expect(
      await gateCapabilityExecution(personRun("edit_video"))
    ).toMatchObject({ decision: "propose", reasonCode: "APP_OUTWARD_INTENT" });
  });

  it("an unapproved verb is still denied (the approval floor comes first)", async () => {
    grantMock.mockReturnValue(APP_GRANT);
    const input = personRun("publish_post");
    const decision = await gateCapabilityExecution({
      ...input,
      skill: { ...input.skill, approved: false },
    });
    expect(decision.decision).toBe("deny");
  });
});
