import { describe, it, expect, vi, beforeEach } from "vitest";

// connector.health_check probes a connector via a cheap verb and, when the OAuth
// connection is dead, nudges the operator via the SHARED notifyConnectorUnhealthy
// helper (never reimplements the nudge). We mock the lazy-imported
// executeCapability + notifyConnectorUnhealthy and assert: a dead connector
// triggers the nudge path, a healthy one is a no-op.
const h = vi.hoisted(() => ({
  exec: vi.fn(),
  notify: vi.fn(),
  findMany: vi.fn(),
}));

// Lazy-imported by the handler (path is relative to builtin-verbs.ts, which
// lives in this same directory as the test).
vi.mock("./execute-capability.js", () => ({ executeCapability: h.exec }));
vi.mock(
  "../connection-health/notify-connector-unhealthy.js",
  async (importOriginal) => {
    // Keep the REAL capErrorMessage / isConnectionAuthError / resolveNoticeChannelId
    // (they are the decision core we want exercised) — only mock the nudge emit.
    const actual =
      await importOriginal<
        typeof import("../connection-health/notify-connector-unhealthy.js")
      >();
    return { ...actual, notifyConnectorUnhealthy: h.notify };
  }
);

// Keep sibling module-load deps happy (mirrors builtin-verbs-generate.test.ts),
// plus a db.query.tools.findMany for resolveTool's watermark-tool lookup (the
// handler routes through the ONE door, not a raw findFirst-by-name — see
// ../tools/resolve-tool.ts). Deliberately UNSCOPED (no workspaceId passed) —
// this is a pod-wide ops-alert channel, not a per-workspace feature; see the
// "pod-wide" test below.
vi.mock("@synap/database", () => {
  const mk = (name: string) =>
    new Proxy(
      { __table: name },
      { get: (t, p) => (p in t ? (t as never)[p] : `${name}.${String(p)}`) }
    );
  return {
    db: { query: { tools: { findMany: h.findMany } } },
    eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
    and: (...xs: unknown[]) => ({ op: "and", xs }),
    or: (...xs: unknown[]) => ({ op: "or", xs }),
    isNull: (col: unknown) => ({ op: "isNull", col }),
    desc: (col: unknown) => ({ op: "desc", col }),
    drizzleSql: (strings: TemplateStringsArray, ...vals: unknown[]) => ({
      op: "sql",
      strings,
      vals,
    }),
    channels: mk("channels"),
    views: mk("views"),
    entities: mk("entities"),
    relations: mk("relations"),
    messages: mk("messages"),
    tools: mk("tools"),
    getWorkspaceMembership: vi.fn(),
    insertChannelMessage: vi.fn(),
  };
});
// resolveTool imports `tools` from @synap/database/schema (not the re-export
// above) and `asc`/`eq` straight from drizzle-orm.
vi.mock("@synap/database/schema", () => ({
  tools: { name: "name", createdAt: "created_at" },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ a, b }),
  asc: (a: unknown) => ({ asc: a }),
}));
vi.mock("./place-artboard-deck.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./place-artboard-deck.js")>();
  return { ...actual, placeArtboardDeck: vi.fn() };
});
vi.mock("../mail-feed/triage.js", () => ({ triageEmails: vi.fn() }));
vi.mock("../mail-feed/generate.js", () => ({ generateViaIS: vi.fn() }));

import {
  BUILTIN_VERBS,
  BUILTIN_VERB_PARAM_SCHEMAS,
  READ_ONLY_BUILTIN_VERBS,
} from "./builtin-verbs.js";

const DISCORD_TOOL = {
  id: "tool-discord",
  createdBy: "owner-1",
  workspaceId: "ws-1",
  metadata: { discord: { feedbackChannel: "chan-notices" } },
};

describe("connector.health_check — registry", () => {
  it("is registered, schema-paired, and auto-runs (read-only w.r.t. graph data)", () => {
    expect(typeof BUILTIN_VERBS["connector.health_check"]).toBe("function");
    expect(BUILTIN_VERB_PARAM_SCHEMAS["connector.health_check"]).toBeTruthy();
    expect(READ_ONLY_BUILTIN_VERBS.has("connector.health_check")).toBe(true);
  });
});

describe("connector.health_check — handler", () => {
  beforeEach(() => vi.clearAllMocks());

  const run = () =>
    BUILTIN_VERBS["connector.health_check"](
      {
        provider: "google",
        connectorName: "Google Workspace",
        reconnectHint: "Reconnect in Settings → Connectors.",
        probeVerbId: "gmail_search",
        probeParameters: { query: "newer_than:1d", maxResults: 1 },
      },
      { userId: "u1", workspaceId: "ws-1" }
    ) as Promise<{ unhealthy: boolean; nudged: boolean; error?: string }>;

  it("DEAD connector → nudges via the shared helper", async () => {
    // Auth error envelope inside a kind:"run" result (post masking-fix shape).
    h.exec.mockResolvedValueOnce({
      kind: "run",
      result: {
        success: false,
        error: "invalid_grant: refresh the access token",
      },
    });
    h.findMany.mockResolvedValueOnce([DISCORD_TOOL]);
    h.notify.mockResolvedValueOnce(true);

    const out = await run();

    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        connectorKey: "google",
        connectorName: "Google Workspace",
        userId: "owner-1",
        watermarkToolId: "tool-discord",
        // resolveNoticeChannelId picks the configured feedbackChannel.
        discordTeamChannelId: "chan-notices",
      })
    );
    expect(out).toEqual({
      unhealthy: true,
      nudged: true,
      error: "invalid_grant: refresh the access token",
    });
  });

  it("HEALTHY connector → no-op (never calls the nudge, never looks up the tool)", async () => {
    h.exec.mockResolvedValueOnce({
      kind: "run",
      result: { results: [{ id: "m1" }] },
    });

    const out = await run();

    expect(h.notify).not.toHaveBeenCalled();
    expect(h.findMany).not.toHaveBeenCalled();
    expect(out).toEqual({ unhealthy: false, nudged: false });
  });

  it("non-auth transient error → no-op (only auth/credential signals nudge)", async () => {
    h.exec.mockResolvedValueOnce({
      kind: "run",
      result: { success: false, error: "rate limit exceeded (429)" },
    });

    const out = await run();

    expect(h.notify).not.toHaveBeenCalled();
    expect(out).toEqual({ unhealthy: false, nudged: false });
  });

  it("DEAD connector but no discord watermark tool → unhealthy, not nudged", async () => {
    h.exec.mockResolvedValueOnce({
      kind: "run",
      result: { success: false, error: "invalid_grant" },
    });
    h.findMany.mockResolvedValueOnce([]);

    const out = await run();

    expect(h.notify).not.toHaveBeenCalled();
    expect(out).toEqual({
      unhealthy: true,
      nudged: false,
      error: "invalid_grant",
    });
  });

  it("nudges via the pod's discord tool even when the CALLER's workspace does not own it — pod-wide ops alert, not per-workspace", async () => {
    // Regression lock: an earlier version of this call scoped the lookup to
    // `ctx.workspaceId`, which would have silently stopped nudging here (a
    // DIFFERENT workspace, "ws-other", owns the only discord row). The
    // watermark + notice channel are a pod-wide singleton — the same row
    // run-mail-feed.ts uses — so any workspace's connector failure must
    // still reach it.
    h.exec.mockResolvedValueOnce({
      kind: "run",
      result: { success: false, error: "invalid_grant" },
    });
    const otherWorkspaceDiscordTool = {
      ...DISCORD_TOOL,
      workspaceId: "ws-other",
    };
    h.findMany.mockResolvedValueOnce([otherWorkspaceDiscordTool]);
    h.notify.mockResolvedValueOnce(true);

    // ctx.workspaceId ("ws-1") does NOT match the discord row's workspace
    // ("ws-other") — must still nudge.
    const out = await run();

    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(out).toEqual({
      unhealthy: true,
      nudged: true,
      error: "invalid_grant",
    });
  });
});
