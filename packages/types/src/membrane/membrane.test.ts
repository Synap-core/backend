/**
 * The ONE connection rule. The fixture table is kind × state: every row names
 * the plausible WRONG rule it rules out, because a row that agrees with every
 * candidate rule is decoration (`.claude/rules/guards-and-tests.md`).
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTION_ACTIONS,
  CONNECTION_KINDS,
  CONNECTION_QUIET_AFTER_DAYS,
  CONNECTION_STATES,
  connectionView,
  isAppPublicId,
  needsYouConnections,
  resolveAccountConnectionState,
  resolveAgentConnectionState,
  resolveAppConnection,
  resolveAppConnectionState,
  resolveChannelConnectionState,
  resolveConnectionAction,
  resolveModelConnectionState,
  resolveToolConnectionState,
  resolveWebhookConnectionState,
  type ConnectionKind,
  type ConnectionState,
} from "./index.js";
import { appStateFacts } from "../apps/app-view.js";

const NOW = Date.parse("2026-10-07T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const daysAhead = (n: number) => new Date(NOW + n * 86_400_000).toISOString();
const GRANT = [{ permissions: ["entity.person.create"], workspaceIds: ["w1"] }];
const PENDING = {
  proposal_id: "p1",
  requests: [{ permission: "entity.note.read", workspaceId: "w2" }],
  requested_at: daysAgo(0),
};

interface Row {
  kind: ConnectionKind;
  state: ConnectionState;
  rulesOut: string;
  resolve: () => ConnectionState;
}

const ROWS: Row[] = [
  // ── app ──
  {
    kind: "app",
    state: "revoked",
    rulesOut: "an open request outranks revocation",
    resolve: () =>
      resolveAppConnectionState(
        { revoked_at: daysAgo(1), grants: GRANT, pending_request: PENDING },
        NOW
      ),
  },
  {
    kind: "app",
    state: "asking",
    rulesOut: "holding reach means ready (a widening ask must still surface)",
    resolve: () =>
      resolveAppConnectionState(
        { grants: GRANT, pending_request: PENDING, last_used_at: daysAgo(0) },
        NOW
      ),
  },
  {
    kind: "app",
    state: "setting_up",
    rulesOut: "no grant means available / revoked",
    resolve: () =>
      resolveAppConnectionState({ grants: [], created_at: daysAgo(1) }, NOW),
  },
  {
    kind: "app",
    state: "needs_signin",
    rulesOut: "grants alone mean ready, ignoring that every key expired",
    resolve: () =>
      resolveAppConnectionState(
        {
          grants: GRANT,
          last_used_at: daysAgo(1),
          keys: [{ isActive: true, revokedAt: null, expiresAt: daysAgo(2) }],
        },
        NOW
      ),
  },
  {
    kind: "app",
    state: "ready",
    rulesOut: "one expired key among live ones means needs_signin",
    resolve: () =>
      resolveAppConnectionState(
        {
          grants: GRANT,
          last_used_at: daysAgo(1),
          keys: [
            { isActive: true, expiresAt: daysAgo(2) },
            { isActive: true, expiresAt: daysAhead(30) },
          ],
        },
        NOW
      ),
  },
  {
    kind: "app",
    state: "quiet",
    rulesOut: "never used means ready forever (falls back to created_at)",
    resolve: () =>
      resolveAppConnectionState(
        {
          grants: GRANT,
          last_used_at: null,
          created_at: daysAgo(CONNECTION_QUIET_AFTER_DAYS + 4),
        },
        NOW
      ),
  },
  // ── agent ──
  {
    kind: "agent",
    state: "asking",
    rulesOut: "a pending key reads as setting up",
    resolve: () =>
      resolveAgentConnectionState(
        { id: "a", name: "C", lastSeenAt: null, activeKeys: 0, pendingKeys: 1 },
        NOW
      ),
  },
  {
    kind: "agent",
    state: "revoked",
    rulesOut: "a revoked-only agent reads as available (never had a key)",
    resolve: () =>
      resolveAgentConnectionState(
        {
          id: "a",
          name: "C",
          lastSeenAt: daysAgo(3),
          activeKeys: 0,
          pendingKeys: 0,
          revokedKeys: 1,
        },
        NOW
      ),
  },
  {
    kind: "agent",
    state: "ready",
    rulesOut: "the 7-day roster staleness decides quiet on Connected",
    resolve: () =>
      resolveAgentConnectionState(
        { id: "a", name: "C", lastSeenAt: daysAgo(10), activeKeys: 1 },
        NOW
      ),
  },
  {
    kind: "agent",
    state: "quiet",
    rulesOut: "seen once means ready forever",
    resolve: () =>
      resolveAgentConnectionState(
        { id: "a", name: "X", lastSeenAt: daysAgo(34), activeKeys: 1 },
        NOW
      ),
  },
  {
    kind: "agent",
    state: "setting_up",
    rulesOut: "a live key never called reads ready",
    resolve: () =>
      resolveAgentConnectionState(
        { id: "a", name: "C", lastSeenAt: null, activeKeys: 1 },
        NOW
      ),
  },
  {
    kind: "agent",
    state: "available",
    rulesOut: "no key at all reads setting up ('waiting for first call')",
    resolve: () =>
      resolveAgentConnectionState(
        { id: "a", name: "C", lastSeenAt: null, activeKeys: 0, pendingKeys: 0 },
        NOW
      ),
  },
  // ── account ──
  {
    kind: "account",
    state: "needs_signin",
    rulesOut: "a broker 'connected' outranks a recorded needs_reauth",
    resolve: () =>
      resolveAccountConnectionState(
        { status: "connected", connectionState: "needs_reauth" },
        NOW
      ),
  },
  {
    kind: "account",
    state: "failing",
    rulesOut: "an unknown status is calm",
    resolve: () =>
      resolveAccountConnectionState({ status: "weird_new_token" }, NOW),
  },
  {
    kind: "account",
    state: "setting_up",
    rulesOut: "every sync in flight is setting up (only the first is)",
    resolve: () =>
      resolveAccountConnectionState(
        { status: "syncing", everSynced: false },
        NOW
      ),
  },
  {
    kind: "account",
    state: "ready",
    rulesOut: "a re-sync of a working account is setting up",
    resolve: () =>
      resolveAccountConnectionState(
        { status: "syncing", everSynced: true },
        NOW
      ),
  },
  {
    kind: "account",
    state: "asking",
    rulesOut: "an install awaiting an admin reads as setting up",
    resolve: () => resolveAccountConnectionState({ status: "pending" }, NOW),
  },
  {
    kind: "account",
    state: "revoked",
    rulesOut: "a disconnected credential reads as available",
    resolve: () =>
      resolveAccountConnectionState(
        { status: "connected", connectionState: "disconnected" },
        NOW
      ),
  },
  {
    kind: "account",
    state: "quiet",
    rulesOut: "a connected account with no sync in 30 days is ready",
    resolve: () =>
      resolveAccountConnectionState(
        { status: "connected", lastSyncedAt: daysAgo(40) },
        NOW
      ),
  },
  // ── channel ──
  {
    kind: "channel",
    state: "available",
    rulesOut: "a linkable channel without a link is hidden or 'off'",
    resolve: () => resolveChannelConnectionState(null, NOW),
  },
  {
    kind: "channel",
    state: "failing",
    rulesOut: "a link existing means healthy (today's 'linked' = connected)",
    resolve: () =>
      resolveChannelConnectionState(
        { channel: "telegram", failedDeliveries: 4 },
        NOW
      ),
  },
  {
    kind: "channel",
    state: "ready",
    rulesOut: "an unmeasured last message reads quiet",
    resolve: () => resolveChannelConnectionState({ channel: "telegram" }, NOW),
  },
  // ── tool ──
  {
    kind: "tool",
    state: "off",
    rulesOut: "a broken sign-in on a tool you turned off is 'needs you'",
    resolve: () =>
      resolveToolConnectionState(
        { enabled: false, reconnect: true, approved: true },
        NOW
      ),
  },
  {
    kind: "tool",
    state: "asking",
    rulesOut: "an unapproved tool reads ready",
    resolve: () =>
      resolveToolConnectionState({ approved: false, status: "active" }, NOW),
  },
  {
    kind: "tool",
    state: "needs_signin",
    rulesOut: "an expired connection reads as failing",
    resolve: () =>
      resolveToolConnectionState(
        {
          approved: true,
          status: "error",
          connection: { required: true, state: "expired" },
        },
        NOW
      ),
  },
  {
    kind: "tool",
    state: "failing",
    rulesOut: "tools.status error is ignored",
    resolve: () =>
      resolveToolConnectionState({ approved: true, status: "error" }, NOW),
  },
  {
    kind: "tool",
    state: "available",
    rulesOut: "a tool missing its account reads ready",
    resolve: () =>
      resolveToolConnectionState(
        { approved: true, connection: { required: true, state: "missing" } },
        NOW
      ),
  },
  {
    kind: "tool",
    state: "ready",
    rulesOut: "a not-required connection's missing state counts",
    resolve: () =>
      resolveToolConnectionState(
        { approved: true, connection: { required: false, state: "missing" } },
        NOW
      ),
  },
  // ── model ──
  {
    kind: "model",
    state: "off",
    rulesOut: "a disabled provider without a key reads 'no key'",
    resolve: () =>
      resolveModelConnectionState({ enabled: false, hasKey: false }),
  },
  {
    kind: "model",
    state: "available",
    rulesOut: "an enabled provider without a key reads ready",
    resolve: () =>
      resolveModelConnectionState({ enabled: true, hasKey: false }),
  },
  {
    kind: "model",
    state: "failing",
    rulesOut: "a stored key means it works",
    resolve: () =>
      resolveModelConnectionState({
        enabled: true,
        hasKey: true,
        lastTestFailed: true,
      }),
  },
  {
    kind: "model",
    state: "ready",
    rulesOut: "never tested reads failing",
    resolve: () => resolveModelConnectionState({ enabled: true, hasKey: true }),
  },
  // ── webhook ──
  {
    kind: "webhook",
    state: "off",
    rulesOut: "a failed last delivery on a paused webhook is 'needs you'",
    resolve: () =>
      resolveWebhookConnectionState(
        { active: false, lastDeliveryStatus: "failed" },
        NOW
      ),
  },
  {
    kind: "webhook",
    state: "failing",
    rulesOut: "active means healthy",
    resolve: () =>
      resolveWebhookConnectionState(
        { active: true, lastDeliveryStatus: "failed" },
        NOW
      ),
  },
  {
    kind: "webhook",
    state: "ready",
    rulesOut: "a pending delivery reads as failing",
    resolve: () =>
      resolveWebhookConnectionState(
        {
          active: true,
          lastDeliveryStatus: "pending",
          lastTriggeredAt: daysAgo(1),
        },
        NOW
      ),
  },
];

describe("kind × state fixture table", () => {
  for (const row of ROWS) {
    it(`${row.kind} → ${row.state} (rules out: ${row.rulesOut})`, () => {
      expect(row.resolve()).toBe(row.state);
    });
  }

  it("non-vacuity: every kind and every state is exercised", () => {
    expect(new Set(ROWS.map((r) => r.kind))).toEqual(new Set(CONNECTION_KINDS));
    expect(new Set(ROWS.map((r) => r.state))).toEqual(
      new Set(CONNECTION_STATES)
    );
  });
});

describe("the states table — one primary action per state", () => {
  const PRIMARY: Record<ConnectionState, string | null> = {
    asking: "review",
    needs_signin: "reconnect",
    failing: "see_failure",
    setting_up: null,
    ready: "open",
    quiet: "open",
    off: "turn_on",
    revoked: "remove",
    available: "connect",
  };
  for (const state of CONNECTION_STATES) {
    it(`${state} → ${PRIMARY[state]}`, () => {
      const v = connectionView("app", state);
      expect(v.primaryAction).toBe(PRIMARY[state]);
      if (v.primaryAction) expect(v.actions[0]).toBe(v.primaryAction);
    });
  }

  it("needs you = asking, needs_signin, failing — and nothing else", () => {
    const yes = CONNECTION_STATES.filter(
      (s) => connectionView("tool", s).needsYou
    );
    expect(yes).toEqual(["asking", "needs_signin", "failing"]);
  });

  it("only a healthy row drops its chip (quiet still shows one)", () => {
    expect(
      CONNECTION_STATES.filter((s) => !connectionView("tool", s).showChip)
    ).toEqual(["ready"]);
  });

  it("ready orders Open, Rename, Pin, Notifications, then the kind's danger verb last", () => {
    expect(connectionView("app", "ready").actions).toEqual([
      "open",
      "rename",
      "pin",
      "notifications",
      "revoke",
    ]);
    expect(connectionView("account", "ready").actions).toEqual([
      "open",
      "rename",
      "pin",
      "notifications",
      "disconnect",
    ]);
    expect(connectionView("tool", "ready", { pinned: true }).actions).toEqual([
      "open",
      "rename",
      "unpin",
      "notifications",
      "remove",
    ]);
  });

  it("the danger action is always last where there is one", () => {
    for (const kind of CONNECTION_KINDS)
      for (const state of CONNECTION_STATES) {
        const actions = connectionView(kind, state).actions;
        const dangerAt = actions.findIndex(
          (a) => resolveConnectionAction(a).tone === "danger"
        );
        if (dangerAt >= 0 && state !== "revoked")
          expect(dangerAt).toBe(actions.length - 1);
      }
  });

  it("asking is ochre (primary), never the orange of 'you must act'", () => {
    expect(connectionView("app", "asking").tone).toBe("primary");
    expect(connectionView("app", "needs_signin").tone).toBe("warning");
  });

  it("an app's lapsed key reads 'Key expired'; an account's reads 'Sign-in expired'", () => {
    expect(connectionView("app", "needs_signin").label).toBe("Key expired");
    expect(connectionView("account", "needs_signin").label).toBe(
      "Sign-in expired"
    );
    expect(connectionView("tool", "ready").label).toBe("Connected");
    expect(connectionView("tool", "revoked").label).toBe("Access removed");
    expect(connectionView("tool", "failing").label).toBe("Failing");
  });
});

describe("action rules", () => {
  it("every action has its words in both moods (imperative, past)", () => {
    // Typed by action, so a new action cannot ship without its words here.
    const WORDS: Record<(typeof CONNECTION_ACTIONS)[number], [string, string]> =
      {
        review: ["Review", "Reviewed"],
        approve: ["Approve", "Approved"],
        decline: ["Decline", "Declined"],
        reconnect: ["Reconnect", "Reconnected"],
        retry: ["Retry", "Retried"],
        see_failure: ["See what failed", "Saw what failed"],
        open: ["Open", "Opened"],
        rename: ["Rename", "Renamed"],
        pin: ["Pin", "Pinned"],
        unpin: ["Unpin", "Unpinned"],
        notifications: ["Set notifications", "Set notifications"],
        turn_on: ["Turn on", "Turned on"],
        revoke: ["Revoke", "Revoked"],
        disconnect: ["Disconnect", "Disconnected"],
        remove: ["Remove for good", "Removed for good"],
        issue_key: ["Issue key", "Issued key"],
        add_again: ["Add again", "Added again"],
        connect: ["Connect", "Connected"],
        cancel: ["Cancel", "Cancelled"],
      };
    for (const a of CONNECTION_ACTIONS) {
      const spec = resolveConnectionAction(a);
      expect([spec.label, spec.pastLabel], a).toEqual(WORDS[a]);
    }
  });

  it("revoke / disconnect / remove confirm and are danger; approve never confirms", () => {
    for (const a of ["revoke", "disconnect", "remove"] as const) {
      expect(resolveConnectionAction(a)).toMatchObject({
        tone: "danger",
        confirm: true,
      });
    }
    expect(resolveConnectionAction("approve")).toMatchObject({
      confirm: false,
      tone: "primary",
    });
    expect(
      CONNECTION_ACTIONS.filter((a) => resolveConnectionAction(a).confirm)
    ).toEqual(["revoke", "disconnect", "remove"]);
  });

  it("words come from the vocabulary in the right mood", () => {
    expect(resolveConnectionAction("remove")).toMatchObject({
      label: "Remove for good",
      pastLabel: "Removed for good",
    });
    expect(resolveConnectionAction("issue_key")).toMatchObject({
      label: "Issue key",
      pastLabel: "Issued key",
    });
    expect(resolveConnectionAction("see_failure").label).toBe(
      "See what failed"
    );
    expect(resolveConnectionAction("turn_on")).toMatchObject({
      label: "Turn on",
      pastLabel: "Turned on",
    });
    expect(resolveConnectionAction("decline")).toMatchObject({
      label: "Decline",
      pastLabel: "Declined",
    });
    expect(resolveConnectionAction("revoke").pastLabel).toBe("Revoked");
  });
});

describe("needsYouConnections", () => {
  it("orders asking, then sign-in, then failing, stable within a state, and drops the rest", () => {
    const views = [
      { id: "f1", ...connectionView("channel", "failing") },
      { id: "r", ...connectionView("tool", "ready") },
      { id: "s", ...connectionView("account", "needs_signin") },
      { id: "a1", ...connectionView("app", "asking") },
      { id: "f2", ...connectionView("webhook", "failing") },
      { id: "a2", ...connectionView("agent", "asking") },
    ];
    expect(needsYouConnections(views).map((v) => v.id)).toEqual([
      "a1",
      "a2",
      "s",
      "f1",
      "f2",
    ]);
  });
});

describe("isAppPublicId", () => {
  it("names an app's public id, never an OAuth client or a bare uuid", () => {
    expect(isAppPublicId("app_1e1e1e1e-0000-4000-8000-0000000000aa")).toBe(
      true
    );
    expect(isAppPublicId("dcr_someclient")).toBe(false);
    expect(isAppPublicId("1e1e1e1e-0000-4000-8000-0000000000aa")).toBe(false);
    expect(isAppPublicId(null)).toBe(false);
    expect(isAppPublicId(undefined)).toBe(false);
  });
});

describe("app-view is a projection of the membrane rule", () => {
  it("an asking app with no grant has no reach and is not revoked", () => {
    const app = { grants: [], pending_request: PENDING };
    expect(resolveAppConnection(app, { now: NOW }).state).toBe("asking");
    expect(appStateFacts(app)).toMatchObject({
      revoked: false,
      hasReach: false,
      label: "No access yet",
    });
  });

  it("revoked wins in both — a revoked app with stale grants never reads 'Has access'", () => {
    const app = { revoked_at: daysAgo(1), grants: GRANT };
    expect(resolveAppConnection(app, { now: NOW }).state).toBe("revoked");
    expect(appStateFacts(app)).toMatchObject({
      revoked: true,
      hasReach: false,
      tone: "none",
    });
  });
});
