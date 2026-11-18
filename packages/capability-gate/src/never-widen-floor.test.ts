import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The never-widen floor: a verb no `auto` grant and no `auto` rule ever runs
 * on its own, read through the one derivation
 * `capabilityVerbAllowsRuleWiden(name, intent, metadata)`. Three postures put
 * a verb under it:
 *  - it serves the `publish_post` intent, under any name (ticket c7feaa6e:
 *    `unipile_publish_post` ran directly while only four Postiz NAMES were
 *    floored);
 *  - it is a listed Postiz name, in any case;
 *  - its pack declares `metadata.proposeOnly: true` (ticket 231020d4:
 *    `hcloud_delete_server` could be widened to run unattended).
 *
 * Each posture meets each widening: an auto grant, an auto rule with no grant,
 * and a row pre-loaded WITHOUT its intent and metadata (the gate must read
 * them, never assume none). Each posture has a control verb that runs.
 */

const findCapabilityGrantMock = vi.fn();
const resolveGovernanceRuleMock = vi.fn();
/** What the skills table holds for a row the run door did not pre-load. */
const storedPosture = new Map<
  string,
  { intent: string | null; metadata: Record<string, unknown> | null }
>();

const T = {
  tools: { __t: "tools" },
  skills: {
    __t: "skills",
    id: "skills.id",
    intent: "skills.intent",
    metadata: "skills.metadata",
  },
  capabilityIntents: { __t: "ci", slug: "ci.slug", effect: "ci.effect" },
};

const fakeDb = {
  select: () => ({
    from: (table: { __t: string }) => ({
      where: async (cond: { b: string }) =>
        table.__t === "skills" && storedPosture.has(cond.b)
          ? [storedPosture.get(cond.b)]
          : [],
    }),
  }),
};

vi.mock("@synap/database", () => ({
  getDb: async () => fakeDb,
  eq: (a: unknown, b: unknown) => ({ a, b }),
  findCapabilityGrant: (...args: unknown[]) => findCapabilityGrantMock(...args),
  getRequestGrant: () => undefined,
}));

vi.mock("@synap/database/agent-governance", () => ({
  resolveGovernanceRule: (...args: unknown[]) =>
    resolveGovernanceRuleMock(...args),
  resolveOriginTrust: async () => undefined,
}));

vi.mock("@synap/database/schema", () => T);

const { gateCapabilityExecution } = await import("./index.js");
const { capabilityVerbAllowsRuleWiden } =
  await import("@synap/governance-policy");

interface Verb {
  name: string;
  intent: string | null;
  metadata: Record<string, unknown> | null;
}

/** One agent run of `verb`; `preloaded: false` = the row comes without its posture. */
function agentRun(verb: Verb, preloaded: boolean) {
  if (!preloaded)
    storedPosture.set("skill-1", {
      intent: verb.intent,
      metadata: verb.metadata,
    });
  return gateCapabilityExecution({
    capabilityKind: "skill",
    capabilityId: "skill-1",
    skill: {
      id: "skill-1",
      approved: true,
      userId: "person-1",
      name: verb.name,
      ...(preloaded ? { intent: verb.intent, metadata: verb.metadata } : {}),
    },
    actorUserId: "person-1",
    agentUserId: "agent-1",
    workspaceId: "ws-1",
  });
}

const POSTURES: ReadonlyArray<{
  posture: string;
  floored: Verb;
  control: Verb;
}> = [
  {
    posture: "a publish_post intent under another name",
    floored: {
      name: "unipile_publish_post",
      intent: "publish_post",
      metadata: null,
    },
    control: { name: "unipile_send", intent: "send_message", metadata: null },
  },
  {
    posture: "a listed Postiz name, in another case",
    floored: { name: " Postiz_Publish ", intent: null, metadata: null },
    control: { name: "postiz_upload_from_url", intent: null, metadata: null },
  },
  {
    posture: "a declared metadata.proposeOnly",
    floored: {
      name: "hcloud_delete_server",
      intent: null,
      metadata: { proposeOnly: true },
    },
    control: { name: "hcloud_delete_server", intent: null, metadata: {} },
  },
];

const WIDENINGS: ReadonlyArray<{
  widening: string;
  preloaded: boolean;
  arrange: () => void;
}> = [
  {
    widening: "an auto grant",
    preloaded: true,
    arrange: () =>
      findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" }),
  },
  {
    widening: "an auto rule with no grant",
    preloaded: true,
    arrange: () => {
      findCapabilityGrantMock.mockResolvedValue({ ok: false });
      resolveGovernanceRuleMock.mockResolvedValue({ verdict: "auto" });
    },
  },
  {
    widening: "an auto grant on a row pre-loaded without its posture",
    preloaded: false,
    arrange: () =>
      findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" }),
  },
];

const PROPOSES = { decision: "propose", proposalType: "run" };

beforeEach(() => {
  findCapabilityGrantMock.mockReset();
  resolveGovernanceRuleMock.mockReset();
  resolveGovernanceRuleMock.mockResolvedValue(undefined);
  storedPosture.clear();
});

describe("a floored verb never runs on its own", () => {
  for (const { posture, floored, control } of POSTURES) {
    for (const { widening, preloaded, arrange } of WIDENINGS) {
      it(`${posture}: ${widening} does not widen it (control: ${control.name} runs)`, async () => {
        arrange();
        expect(await agentRun(floored, preloaded)).toMatchObject(PROPOSES);
        expect(await agentRun(control, preloaded)).toEqual({ decision: "run" });
      });
    }
  }

  it('only a real boolean declares proposeOnly: false and "true" run', async () => {
    findCapabilityGrantMock.mockResolvedValue({ ok: true, execMode: "auto" });
    for (const proposeOnly of [false, "true"]) {
      expect(
        await agentRun(
          {
            name: "hcloud_delete_server",
            intent: null,
            metadata: { proposeOnly },
          },
          true
        )
      ).toEqual({ decision: "run" });
    }
  });
});

describe("capabilityVerbAllowsRuleWiden — the one derivation the gate and the menus read", () => {
  it("refuses every floored posture; allows each control", () => {
    for (const { floored, control } of POSTURES) {
      expect(
        capabilityVerbAllowsRuleWiden(
          floored.name,
          floored.intent,
          floored.metadata
        ),
        floored.name
      ).toBe(false);
      expect(
        capabilityVerbAllowsRuleWiden(
          control.name,
          control.intent,
          control.metadata
        ),
        control.name
      ).toBe(true);
    }
    // A declaration wins over a widenable intent.
    expect(
      capabilityVerbAllowsRuleWiden("gmail_send", "send_email", {
        proposeOnly: true,
      })
    ).toBe(false);
    expect(capabilityVerbAllowsRuleWiden(null, null)).toBe(true);
  });
});
