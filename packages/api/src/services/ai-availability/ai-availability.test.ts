/**
 * This pod's AI availability, read and told (W3 C4/C5) — over the stored
 * answer of the pull (`PodAiAvailability`), never the CP itself:
 *  - the view: payer vs member (the member only ever asks a payer, never sees
 *    the payer's link), unknown never reads "ok";
 *  - the agents' block and line: words from the deck, the person acts;
 *  - the payers' notices: on a change of state or mark only, low → status,
 *    empty / suspended / not entitled → the pushed item, available → cleared.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@synap/database", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPodAiAvailability: vi.fn(),
}));
vi.mock("../../notifications/NotificationService.js", () => ({
  NotificationService: { create: vi.fn() },
}));
vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodAdminUserIds: vi.fn(async () => []),
}));

import type { PodAiAvailability } from "@synap/database";
import { aiAvailabilityViewOf } from "./read.js";
import {
  aiAvailabilityAgentLine,
  aiAvailabilityForAgents,
} from "./for-agents.js";
import { notifyAiAvailabilityChange } from "./notify.js";

const stored = (
  state: "ok" | "low" | "empty" | "suspended" | "unmetered",
  over: Partial<{ threshold: number | null; resetsAt: string | null }> = {}
): PodAiAvailability => ({
  billing: {
    readFailed: false,
    state,
    threshold: over.threshold ?? (state === "low" ? 10 : null),
    dismissKey: state === "ok" ? null : `billing:user:a:pod:p:${state}`,
    resetsAt: over.resetsAt ?? "2026-12-01T00:00:00.000Z",
    viewerRole: "pod_owner",
    canTopUp: true,
    action:
      state === "suspended"
        ? "fix_payment"
        : state === "ok" || state === "unmetered"
          ? "none"
          : "top_up",
    actionUrl:
      state === "ok" || state === "unmetered"
        ? null
        : "https://synap.live/account/credits",
  },
  checkedAt: "2026-11-21T10:00:00.000Z",
  availableSince: state === "ok" ? "2026-11-21T10:00:00.000Z" : null,
});

describe("the view (aiAvailabilityViewOf)", () => {
  it("a payer gets the CP's action and its link", () => {
    const v = aiAvailabilityViewOf(stored("empty"), "payer");
    expect(v.availability).toMatchObject({
      kind: "credits_empty",
      action: "top_up",
      actor: "payer",
    });
    expect(v.actionUrl).toBe("https://synap.live/account/credits");
  });

  it("a member asks a payer: never the top-up, never the payer's link", () => {
    for (const state of ["empty", "low", "suspended"] as const) {
      const v = aiAvailabilityViewOf(stored(state), "member");
      expect(v.availability?.action, state).toBe("ask_admin");
      expect(v.actionUrl, state).toBeNull();
      expect(v.role).toBe("member");
    }
    // Nothing to do is nothing to ask.
    expect(aiAvailabilityViewOf(stored("ok"), "member").availability).toMatchObject(
      { kind: "ok", action: "none" }
    );
  });

  it("unknown (never answered, or a CP without the door) is null, never ok", () => {
    expect(aiAvailabilityViewOf(undefined, "payer").availability).toBeNull();
    expect(aiAvailabilityViewOf(null, "payer").availability).toBeNull();
  });

  it("a billing read the CP could not make is unmeasured, not ok", () => {
    const v = aiAvailabilityViewOf(
      { ...stored("ok"), billing: { readFailed: true } },
      "payer"
    );
    expect(v.availability).toMatchObject({ kind: null, readFailed: true });
    expect(v.actionUrl).toBeNull();
  });
});

describe("for agents", () => {
  it("names the state, the person's move, and that the agent never pays", () => {
    const view = aiAvailabilityViewOf(stored("empty"), "payer");
    expect(aiAvailabilityForAgents(view)).toMatchObject({
      kind: "credits_empty",
      title: "No AI credits left",
      whoActs: "payer",
      personAction: expect.any(String),
    });
    const line = aiAvailabilityAgentLine(view);
    expect(line).toContain("No AI credits left (credits_empty)");
    expect(line).toContain("never you");
    expect(line).toContain("never pay or file a top-up card");
  });

  it("says nothing when AI is available or the pod does not know", () => {
    expect(aiAvailabilityAgentLine(aiAvailabilityViewOf(stored("ok"), "payer"))).toBe("");
    expect(aiAvailabilityAgentLine(aiAvailabilityViewOf(undefined, "payer"))).toBe("");
    expect(aiAvailabilityForAgents(aiAvailabilityViewOf(undefined, "payer"))).toEqual({
      kind: null,
    });
  });
});

describe("the payers' notices (notifyAiAvailabilityChange)", () => {
  const deps = () => {
    const created: Array<Record<string, unknown>> = [];
    let dismissed = 0;
    return {
      created,
      dismissed: () => dismissed,
      deps: {
        recipients: async () => ["owner", "admin"],
        create: async (input: Record<string, unknown>) => {
          created.push(input);
          return "n";
        },
        dismissOpen: async () => {
          dismissed++;
        },
      },
    };
  };
  const change = (
    previous: PodAiAvailability | null | undefined,
    current: PodAiAvailability
  ) => ({ previous, current, becameAvailable: false });

  it("empty: the pushed item to every payer, in the deck's words, keyed by state, mark and reset", async () => {
    const d = deps();
    const out = await notifyAiAvailabilityChange(
      change(stored("ok"), stored("empty")),
      d.deps as never
    );
    expect(out).toEqual({ action: "notified", type: "ai.unavailable", sent: 2 });
    expect(d.created.map((c) => c.userId)).toEqual(["owner", "admin"]);
    expect(d.created[0]).toMatchObject({
      type: "ai.unavailable",
      groupKey: "ai:credits_empty:-:2026-12-01T00:00:00.000Z",
      data: { title: "No AI credits left" },
    });
    expect(d.dismissed()).toBe(1);
  });

  it("low: the status notice, once per mark", async () => {
    const d = deps();
    await notifyAiAvailabilityChange(
      change(stored("ok"), stored("low", { threshold: 20 })),
      d.deps as never
    );
    // The same mark again: nothing new.
    await notifyAiAvailabilityChange(
      change(stored("low", { threshold: 20 }), stored("low", { threshold: 20 })),
      d.deps as never
    );
    // A new mark: a new notice.
    await notifyAiAvailabilityChange(
      change(stored("low", { threshold: 20 }), stored("low", { threshold: 10 })),
      d.deps as never
    );
    expect(d.created.filter((c) => c.userId === "owner")).toMatchObject([
      { type: "ai.credits_low", groupKey: expect.stringContaining(":20:") },
      { type: "ai.credits_low", groupKey: expect.stringContaining(":10:") },
    ]);
  });

  it("back to available: the open notices are cleared, nothing new", async () => {
    const d = deps();
    const out = await notifyAiAvailabilityChange(
      change(stored("empty"), stored("ok")),
      d.deps as never
    );
    expect(out).toEqual({ action: "cleared" });
    expect(d.created).toEqual([]);
    expect(d.dismissed()).toBe(1);
  });

  it("a billing read the CP could not make tells nobody and clears nothing", async () => {
    const d = deps();
    const out = await notifyAiAvailabilityChange(
      change(stored("empty"), { ...stored("ok"), billing: { readFailed: true } }),
      d.deps as never
    );
    expect(out).toEqual({ action: "none" });
    expect(d.dismissed()).toBe(0);
  });

  it("the first answer ever is news when AI is not available", async () => {
    const d = deps();
    await notifyAiAvailabilityChange(change(undefined, stored("suspended")), d.deps as never);
    expect(d.created[0]).toMatchObject({
      type: "ai.unavailable",
      data: { title: "Payment needed" },
    });
  });
});
