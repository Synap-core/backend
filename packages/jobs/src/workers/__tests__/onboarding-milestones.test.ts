import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * onboarding-milestones sends the start's milestones to the CP (plan §5, A9).
 *   - the body carries ONLY milestone ids, timestamps, `slug` / `viewType` /
 *     `path` / `arm` and `nextReturn {at, sessionId}` — never the person's
 *     words, though the start values hold them (`cloud.workingOn`);
 *   - nothing is sent from a pod with no CP link, with sharing switched off,
 *     or without a pod key (the CP refuses the fleet-shared legacy key);
 *   - an unchanged payload is not sent twice; a refused one is retried.
 * The fact reader has its own home (`@synap/database` utils/onboarding-milestones.ts).
 */

const h = vi.hoisted(() => ({
  link: null as unknown,
  sharing: { enabled: true, changedBy: null, changedAt: null } as {
    enabled: boolean;
  },
  facts: null as unknown,
  sync: null as { digest: string } | null,
  via: "pod-jwt" as "pod-jwt" | "internal-key",
  authCalls: [] as unknown[],
  sent: [] as string[],
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@synap/database", () => ({
  readControlPlaneLink: async () => h.link,
  readOnboardingMilestonesSharing: async () => h.sharing,
  readOnboardingMilestoneFacts: async () => h.facts,
  readOnboardingMilestonesSync: async () => h.sync,
  recordOnboardingMilestonesSent: async (digest: string) => {
    h.sent.push(digest);
    h.sync = { digest };
  },
  podCpAuthHeaders: async (opts: unknown) => {
    h.authCalls.push(opts);
    return h.via === "pod-jwt"
      ? {
          via: "pod-jwt",
          headers: { Authorization: "Bearer pod-signed" },
          bearer: "pod-signed",
        }
      : { via: "internal-key", headers: { "X-Internal-Key": "fleet" } };
  },
}));
vi.mock("@synap-core/core", () => ({ createLogger: () => h.logger }));

const fetchMock = vi.fn();

import {
  buildOnboardingMilestonesPayload,
  handleOnboardingMilestones,
  ONBOARDING_MILESTONE_IDS,
  ONBOARDING_MILESTONES_CRON,
  ONBOARDING_MILESTONES_QUEUE,
} from "../onboarding-milestones.js";

const CP = "https://cp.example.test";
const SESSION = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const SECRET = "Launch Project Nightingale for Ada Lovelace";

/** A start that went all the way, carrying every kind of free text the pod keeps. */
function fullFacts() {
  return {
    journey: {
      userId: "user_owner",
      status: "completed",
      offeredAt: new Date("2026-10-28T09:00:00.000Z"),
      completedAt: new Date("2026-10-28T10:00:00.000Z"),
      start: {
        v: 1,
        intent: {
          slug: "crm",
          source: "cloud",
          at: "2026-10-28T09:01:00.000Z",
        },
        cloud: {
          start: "crm",
          workingOn: SECRET,
          identity: ["founder"],
          tools: ["claude-code"],
          experiments: {
            setupPath: "quick",
            viewStep: "on",
            firstSessionGovernance: "propose",
          },
          readAt: "2026-10-28T09:01:00.000Z",
        },
        view: {
          profile: "deal",
          view: "deals-board",
          type: "kanban",
          at: "2026-10-28T09:02:00.000Z",
        },
        path: { kind: "quick", at: "2026-10-28T09:03:00.000Z" },
        setup: {
          proposalId: "11111111-1111-4111-8111-111111111111",
          at: "2026-10-28T09:04:00.000Z",
        },
        agent: {
          agentUserId: "agent_claude",
          at: "2026-10-28T09:20:00.000Z",
        },
        firstSession: { sessionId: SESSION, at: "2026-10-28T09:25:00.000Z" },
        nextReturn: { at: "2026-10-29T08:00:00.000Z", sessionId: SESSION },
      },
    },
    setupProposal: {
      status: "approved",
      createdAt: new Date("2026-10-28T09:04:00.000Z"),
      reviewedAt: new Date("2026-10-28T09:10:00.000Z"),
      undoneAt: null as Date | null,
    },
    firstAgentProposalAt: new Date("2026-10-28T09:30:00.000Z"),
    firstAgentApprovalAt: new Date("2026-10-28T09:40:00.000Z"),
    week2ActivityAt: new Date("2026-11-05T12:00:00.000Z"),
  };
}

const answer = (status: number) => ({
  ok: status >= 200 && status < 300,
  status,
});
const sentBody = () => JSON.parse(fetchMock.mock.calls[0]![1].body as string);

beforeEach(() => {
  h.link = {
    podId: "pod_1",
    url: CP,
    issuer: CP,
    since: null,
    source: "enrollment",
  };
  h.sharing = { enabled: true };
  h.facts = fullFacts();
  h.sync = null;
  h.via = "pod-jwt";
  h.authCalls = [];
  h.sent = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("the milestone payload", () => {
  it("carries only ids, timestamps and the four enum properties — never the person's words", () => {
    const payload = buildOnboardingMilestonesPayload(fullFacts() as never);

    expect(Object.keys(payload).sort()).toEqual([
      "milestones",
      "nextReturn",
      "v",
    ]);
    for (const m of payload.milestones) {
      for (const key of Object.keys(m)) {
        expect(["id", "at", "slug", "viewType", "path", "arm"]).toContain(key);
      }
      expect(ONBOARDING_MILESTONE_IDS).toContain(m.id);
    }
    expect(Object.keys(payload.nextReturn!).sort()).toEqual([
      "at",
      "sessionId",
    ]);

    const wire = JSON.stringify(payload);
    for (const text of [
      SECRET,
      "founder",
      "claude-code",
      "deals-board",
      'deal"',
      "agent_claude",
    ]) {
      expect(wire).not.toContain(text);
    }
  });

  it("derives each milestone's time from the facts, with its enum properties", () => {
    expect(buildOnboardingMilestonesPayload(fullFacts() as never)).toEqual({
      v: 1,
      milestones: [
        { id: "console_opened", at: "2026-10-28T09:00:00.000Z" },
        { id: "intent_set", at: "2026-10-28T09:01:00.000Z", slug: "crm" },
        {
          id: "view_chosen",
          at: "2026-10-28T09:02:00.000Z",
          viewType: "kanban",
          arm: "on",
        },
        {
          id: "path_chosen",
          at: "2026-10-28T09:03:00.000Z",
          path: "quick",
          arm: "quick",
        },
        { id: "setup_proposed", at: "2026-10-28T09:04:00.000Z" },
        { id: "setup_approved", at: "2026-10-28T09:10:00.000Z" },
        { id: "agent_seen", at: "2026-10-28T09:20:00.000Z" },
        {
          id: "first_session_created",
          at: "2026-10-28T09:25:00.000Z",
          arm: "propose",
        },
        { id: "first_agent_proposal", at: "2026-10-28T09:30:00.000Z" },
        { id: "first_agent_approval", at: "2026-10-28T09:40:00.000Z" },
        { id: "done", at: "2026-10-28T10:00:00.000Z" },
        { id: "returned_week2", at: "2026-11-05T12:00:00.000Z" },
      ],
      nextReturn: { at: "2026-10-29T08:00:00.000Z", sessionId: SESSION },
    });
  });

  it("drops a property that is not a short token, and a milestone with no readable time", () => {
    const facts = fullFacts();
    facts.journey.start.intent.slug = SECRET;
    facts.journey.start.view.at = "not a date";
    facts.journey.start.nextReturn = {
      at: "2026-10-29T08:00:00.000Z",
      sessionId: SECRET,
    };
    const payload = buildOnboardingMilestonesPayload(facts as never);
    expect(payload.milestones.find((m) => m.id === "intent_set")).toEqual({
      id: "intent_set",
      at: "2026-10-28T09:01:00.000Z",
    });
    expect(payload.milestones.some((m) => m.id === "view_chosen")).toBe(false);
    expect(payload.nextReturn).toBeNull();
    expect(JSON.stringify(payload)).not.toContain("Nightingale");
  });

  it("a rejected setup and an undone setup are their own milestones", () => {
    const facts = fullFacts();
    facts.setupProposal = {
      status: "rejected",
      createdAt: new Date("2026-10-28T09:04:00.000Z"),
      reviewedAt: new Date("2026-10-28T09:06:00.000Z"),
      undoneAt: null,
    };
    let ids = buildOnboardingMilestonesPayload(facts as never).milestones.map(
      (m) => m.id
    );
    expect(ids).toContain("setup_rejected");
    expect(ids).not.toContain("setup_approved");

    facts.setupProposal = {
      ...fullFacts().setupProposal,
      undoneAt: new Date("2026-10-28T09:50:00.000Z"),
    };
    ids = buildOnboardingMilestonesPayload(facts as never).milestones.map(
      (m) => m.id
    );
    expect(ids).toEqual(
      expect.arrayContaining(["setup_approved", "setup_undone"])
    );
  });
});

describe("handleOnboardingMilestones", () => {
  it("POSTs the payload signed for purpose 'onboarding' and keeps its digest", async () => {
    fetchMock.mockResolvedValueOnce(answer(200));
    await handleOnboardingMilestones();

    expect(h.authCalls[0]).toMatchObject({ purpose: "onboarding" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${CP}/internal/onboarding-milestones`);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer pod-signed" });
    expect(sentBody()).toEqual(
      buildOnboardingMilestonesPayload(fullFacts() as never)
    );
    expect(h.sent).toHaveLength(1);
  });

  it("an unchanged payload is not sent again", async () => {
    fetchMock.mockResolvedValue(answer(200));
    await handleOnboardingMilestones();
    await handleOnboardingMilestones();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a payload the CP did not accept is sent again next time", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(503))
      .mockResolvedValueOnce(answer(200));
    await handleOnboardingMilestones();
    expect(h.sent).toEqual([]);
    await handleOnboardingMilestones();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(h.sent).toHaveLength(1);
  });

  it("a self-hosted pod (no CP link) sends nothing", async () => {
    h.link = null;
    await handleOnboardingMilestones();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.authCalls).toEqual([]);
  });

  it("sharing switched off sends nothing", async () => {
    h.sharing = { enabled: false };
    await handleOnboardingMilestones();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.authCalls).toEqual([]);
  });

  it("a pod without its own key never sends with the fleet-shared legacy key", async () => {
    h.via = "internal-key";
    await handleOnboardingMilestones();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no start journey sends nothing", async () => {
    h.facts = null;
    await handleOnboardingMilestones();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is scheduled every 15 minutes", () => {
    expect(ONBOARDING_MILESTONES_QUEUE).toBe("onboarding-milestones");
    expect(ONBOARDING_MILESTONES_CRON).toBe("*/15 * * * *");
  });
});
