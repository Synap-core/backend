/**
 * The relay push says the RELAY, and offers no answer of its own.
 *
 * A commitment an agent relayed waits for the person's tap. The ordinary
 * needs-you push for that ask carries a lock-screen quick answer (Yes / No, an
 * option) and a body built from the ask — so the person was offered to answer
 * the question afresh, recording their own answer over the relayed one, and
 * the body never said an agent relayed anything. Driven through the real
 * `notifySessionNeedsYou`; only its two reads and the notification door are
 * stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = async () => [{ name: "Claude Code" }];
  return {
    ...actual,
    db: {
      select: () => chain,
      query: {
        focusSessions: {
          findFirst: async () => ({
            id: "s-1",
            userId: "u-1",
            workspaceId: null,
            title: "Billing",
            goal: "Billing",
          }),
        },
      },
    },
  };
});
vi.mock("../../../notifications/NotificationService.js", () => ({
  NotificationService: {
    create: async (input: Record<string, unknown>) => {
      h.created.push(input);
      return "n-1";
    },
  },
}));

import { notifySessionNeedsYou } from "../notify-needs-you.js";

const SLOT = {
  kind: "decision",
  label: "Stripe account",
  owner: "human" as const,
  blockedReason: "decision" as const,
  ask: {
    mode: "choose" as const,
    options: [
      { label: "EU account", value: "eu", recommended: true },
      { label: "US account", value: "us" },
    ],
  },
};

describe("the relay-awaiting-tap push", () => {
  beforeEach(() => {
    h.created.length = 0;
  });

  it("lands on the ask with no quick answer, and its body says the relay", async () => {
    await notifySessionNeedsYou({
      sessionId: "s-1",
      byAgent: true,
      reason: {
        kind: "relay",
        slot: {
          ...SLOT,
          pendingRelay: {
            text: "EU account",
            value: { type: "chip", chip: { label: "EU account", value: "eu" } },
            relayedBy: "a-1",
            quote: "the EU one",
            relayedAt: "2026-10-27T10:00:00.000Z",
          },
        } as never,
      },
    });
    expect(h.created).toHaveLength(1);
    const input = h.created[0]! as {
      target?: { kind: string };
      push: { quickAnswer?: unknown; body?: string; slot?: string };
      data: { summary: string };
    };
    expect(input.target?.kind).toBe("owed");
    expect(input.push.slot).toBe("Stripe account");
    expect(input.push.quickAnswer ?? null).toBeNull();
    expect(input.push.body).toBeUndefined();
    expect(input.data.summary).toBe(
      "Stripe account · Relayed by Claude Code · needs your tap · You said “the EU one”"
    );
  });

  it("names the ask by the card's heading, never the raw slot label", async () => {
    await notifySessionNeedsYou({
      sessionId: "s-1",
      byAgent: true,
      reason: {
        kind: "relay",
        slot: {
          kind: "decision",
          label: "Decide: ship the pricing page",
          owner: "human",
          blockedReason: "decision",
          ask: { mode: "confirm", prompt: "Ship the pricing page today?" },
          pendingRelay: {
            text: "Yes",
            value: { type: "confirm", confirmed: true },
            relayedBy: "a-1",
            relayedAt: "2026-10-27T10:00:00.000Z",
          },
        } as never,
      },
    });
    const input = h.created[0]! as { data: { summary: string } };
    expect(input.data.summary).toBe(
      "Ship the pricing page today? · Relayed by Claude Code · needs your tap"
    );
  });

  it("the ordinary push for the same ask still carries its quick answer", async () => {
    await notifySessionNeedsYou({
      sessionId: "s-1",
      byAgent: true,
      reason: { kind: "slots", before: [], after: [SLOT] },
    });
    const input = h.created[0]! as { push: { quickAnswer?: unknown } };
    expect(input.push.quickAnswer).toBeTruthy();
  });
});
