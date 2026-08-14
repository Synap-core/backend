/**
 * Capability Issues — PURE drift-composition gate (no DB).
 *
 * `composeCapabilityIssues` folds the already-derived drift signals (structural
 * gaps, producer-mode health, inbound/outbound channel rollups) into ONE ranked
 * Issues list. These tests pin its contract without a database:
 *   - each Issue KIND fires from its own signal;
 *   - severity is NOT boolean (error / warning / info) and ranks worst-first;
 *   - the no-fabrication guard: an unobserved unknown-mode capability, a
 *     suppressed-only channel, and a merely-low success rate produce NO Issue.
 */

import { describe, it, expect } from "vitest";
import {
  composeCapabilityIssues,
  type CapabilityHealthResult,
  type CapabilityProducerMode,
  type CapabilityModeSource,
  type SignalChannelRollup,
  type SignalFate,
  type SignalEgressChannelRollup,
} from "./index.js";

const CAP = "cap-1";

function fate(
  over: Partial<Record<SignalFate, number>> = {}
): Record<SignalFate, number> {
  return {
    extracted: 0,
    no_insight: 0,
    no_run: 0,
    unprocessed_unbound: 0,
    suppressed: 0,
    failed: 0,
    ...over,
  };
}

function channel(over: Partial<SignalChannelRollup> = {}): SignalChannelRollup {
  return {
    channelId: "c1",
    name: "Client A",
    provider: "discord",
    bound: true,
    boundEntityId: "e1",
    messageCount: 0,
    extractionRatePct: 0,
    fate: fate(),
    originTrust: "trusted",
    lastActivityAt: new Date("2026-08-08T10:00:00Z"),
    ...over,
  };
}

function egress(
  over: Partial<SignalEgressChannelRollup> = {}
): SignalEgressChannelRollup {
  return {
    channelId: "c1",
    name: "Client A",
    provider: "discord",
    sentCount: 0,
    failedCount: 0,
    lastSentAt: null,
    ...over,
  };
}

function health(over: {
  mode?: CapabilityProducerMode;
  modeSource?: CapabilityModeSource;
  channelCount?: number;
  messageCount?: number;
  liveness?: "live" | "idle" | "unknown";
  fate?: Record<SignalFate, number>;
}): CapabilityHealthResult {
  const mode = over.mode ?? "unknown";
  const standing =
    mode === "standing"
      ? {
          lastSeenAt: null,
          lastSeenAgeMs: null,
          liveness: over.liveness ?? "unknown",
          freshnessWindowMs: 24 * 60 * 60 * 1000,
          failedChannels: 0,
        }
      : null;
  return {
    capabilityId: CAP,
    mode,
    modeSource: over.modeSource ?? "unknown",
    standing,
    callable: null,
    fate: over.fate ?? fate(),
    messageCount: over.messageCount ?? 0,
    channelCount: over.channelCount ?? 0,
    truncated: false,
  };
}

function base(over: Parameters<typeof composeCapabilityIssues>[0]) {
  return composeCapabilityIssues(over);
}

describe("composeCapabilityIssues (pure)", () => {
  it("consolidates a 'not found' gap as an ERROR member_missing", () => {
    const res = base({
      capabilityId: CAP,
      gaps: ["Tool member abc not found"],
      members: [{ kind: "tool", id: "abc", name: "abc", wired: false }],
      health: health({}),
      channels: [],
      egress: [],
      truncated: false,
    });
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0].kind).toBe("member_missing");
    expect(res.issues[0].severity).toBe("error");
    // gap string is used verbatim as the human title.
    expect(res.issues[0].title).toBe("Tool member abc not found");
    expect(res.issues[0].fix?.action).toEqual({ kind: "open_composition" });
  });

  it("consolidates a non-'not found' gap as a WARNING member_unwired, with a member targetRef", () => {
    const res = base({
      capabilityId: CAP,
      gaps: ['Verb "Summarize" has no parent tool (unwired)'],
      members: [{ kind: "skill", id: "s1", name: "Summarize", wired: false }],
      health: health({}),
      channels: [],
      egress: [],
      truncated: false,
    });
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0].kind).toBe("member_unwired");
    expect(res.issues[0].severity).toBe("warning");
    expect(res.issues[0].targetRef).toEqual({ kind: "skill", id: "s1" });
  });

  it("flags a produced channel with fate.failed as an ERROR run_failure → rerun_channel", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      health: health({ mode: "callable", messageCount: 3 }),
      members: [],
      channels: [channel({ messageCount: 3, fate: fate({ failed: 2 }) })],
      egress: [],
      truncated: false,
    });
    const issue = res.issues.find((i) => i.kind === "run_failure");
    expect(issue?.severity).toBe("error");
    expect(issue?.fix?.action).toEqual({
      kind: "rerun_channel",
      channelId: "c1",
    });
    expect(issue?.targetRef).toEqual({ kind: "channel", id: "c1" });
  });

  it("flags an unbound channel receiving signal as a WARNING channel_unbound → bind_channel", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({ mode: "callable", messageCount: 4, channelCount: 1 }),
      channels: [
        channel({
          bound: false,
          boundEntityId: null,
          messageCount: 4,
          fate: fate({ unprocessed_unbound: 4 }),
        }),
      ],
      egress: [],
      truncated: false,
    });
    const issue = res.issues.find((i) => i.kind === "channel_unbound");
    expect(issue?.severity).toBe("warning");
    expect(issue?.fix?.action).toEqual({
      kind: "bind_channel",
      channelId: "c1",
    });
  });

  it("flags failed egress as an ERROR delivery_failure → open_egress", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({ mode: "callable" }),
      channels: [],
      egress: [egress({ failedCount: 5 })],
      truncated: false,
    });
    const issue = res.issues.find((i) => i.kind === "delivery_failure");
    expect(issue?.severity).toBe("error");
    expect(issue?.fix?.action).toEqual({ kind: "open_egress" });
  });

  it("a DECLARED standing source with zero channels is a WARNING silent_producer; a DERIVED one is INFO", () => {
    const declared = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({
        mode: "standing",
        modeSource: "declared",
        channelCount: 0,
      }),
      channels: [],
      egress: [],
      truncated: false,
    });
    expect(
      declared.issues.find((i) => i.kind === "silent_producer")?.severity
    ).toBe("warning");

    const derived = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({
        mode: "standing",
        modeSource: "derived_transport",
        channelCount: 0,
      }),
      channels: [],
      egress: [],
      truncated: false,
    });
    expect(
      derived.issues.find((i) => i.kind === "silent_producer")?.severity
    ).toBe("info");
  });

  it("a standing source that has gone idle (had channels) is a WARNING standing_idle, never failed", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({
        mode: "standing",
        modeSource: "declared",
        channelCount: 1,
        liveness: "idle",
      }),
      channels: [channel({ messageCount: 2, fate: fate({ extracted: 2 }) })],
      egress: [],
      truncated: false,
    });
    const kinds = res.issues.map((i) => i.kind);
    expect(kinds).toContain("standing_idle");
    expect(res.issues.find((i) => i.kind === "standing_idle")?.severity).toBe(
      "warning"
    );
  });

  it("an OBSERVED unknown-mode capability yields an INFO mode_undeclared → declare_mode", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({ mode: "unknown", messageCount: 6, channelCount: 1 }),
      channels: [channel({ messageCount: 6, fate: fate({ extracted: 6 }) })],
      egress: [],
      truncated: false,
    });
    const issue = res.issues.find((i) => i.kind === "mode_undeclared");
    expect(issue?.severity).toBe("info");
    expect(issue?.fix?.action).toEqual({ kind: "declare_mode" });
  });

  // ── The no-fabrication guard ────────────────────────────────────────────────

  it("an UNOBSERVED unknown-mode capability (no signal, no gaps) produces ZERO issues", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({ mode: "unknown", messageCount: 0, channelCount: 0 }),
      channels: [],
      egress: [],
      truncated: false,
    });
    expect(res.issues).toHaveLength(0);
    expect(res.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("a channel with ONLY suppressed no-ops (correct filter) produces NO issue", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({ mode: "callable", messageCount: 3, channelCount: 1 }),
      // bound, no failures — every unit was an intentional filter.
      channels: [channel({ messageCount: 3, fate: fate({ suppressed: 3 }) })],
      egress: [],
      truncated: false,
    });
    expect(res.issues).toHaveLength(0);
  });

  it("a merely-low success rate from no_insight (ran, found nothing) is NOT an issue", () => {
    const res = base({
      capabilityId: CAP,
      gaps: [],
      members: [],
      health: health({ mode: "callable", messageCount: 5, channelCount: 1 }),
      channels: [channel({ messageCount: 5, fate: fate({ no_insight: 5 }) })],
      egress: [],
      truncated: false,
    });
    expect(res.issues).toHaveLength(0);
  });

  it("ranks worst-first: error before warning before info, counts tally per severity", () => {
    const res = base({
      capabilityId: CAP,
      gaps: ['Automation "Nightly" is archived (unwired)'], // warning
      members: [
        { kind: "automation", id: "a1", name: "Nightly", wired: false },
      ],
      health: health({
        mode: "unknown",
        messageCount: 4,
        channelCount: 1,
      }), // → info mode_undeclared (observed)
      channels: [channel({ messageCount: 4, fate: fate({ failed: 1 }) })], // error run_failure
      egress: [egress({ failedCount: 2 })], // error delivery_failure
      truncated: true,
    });
    const severities = res.issues.map((i) => i.severity);
    // Every error precedes every warning precedes every info.
    const rank = { error: 0, warning: 1, info: 2 } as const;
    for (let i = 1; i < severities.length; i++) {
      expect(rank[severities[i]]).toBeGreaterThanOrEqual(
        rank[severities[i - 1]]
      );
    }
    expect(res.counts.error).toBe(2);
    expect(res.counts.warning).toBe(1);
    expect(res.counts.info).toBe(1);
    expect(res.truncated).toBe(true);
  });
});
