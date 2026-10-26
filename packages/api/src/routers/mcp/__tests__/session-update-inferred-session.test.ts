/**
 * F2 (plan v5, lane be-context) — `synap_update_session` with NO `sessionId`
 * files the write on the ONE open session this conversation started, and
 * refuses — changing nothing — when there are several, none, a shared key, or
 * the read failed.
 *
 * Drives the REAL handler with the REAL tool schema; the resolver
 * (`resolveClientOpenSession`, pinned on PGlite in
 * `services/focus-sessions/__tests__/client-open-session.pglite.test.ts`) and
 * the service are the only things replaced. Asserts REACHABILITY: which id
 * the service was called with, and that a refusal never reaches it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const h = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  resolverCalls: 0,
  found: { status: "none" } as Record<string, unknown>,
}));

vi.mock("../../../services/focus-sessions/update-session.js", async (orig) => {
  const actual =
    await orig<
      typeof import("../../../services/focus-sessions/update-session.js")
    >();
  return {
    ...actual,
    updateFocusSession: async (params: Record<string, unknown>) => {
      h.calls.push(params);
      return { status: "updated", session: { id: params.sessionId } };
    },
  };
});

vi.mock(
  "../../../services/focus-sessions/resolve-work-session.js",
  async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    resolveClientOpenSession: async () => {
      h.resolverCalls += 1;
      return h.found;
    },
  })
);

// The nudge read rides every success; keep it off the database.
vi.mock("../../../services/focus-sessions/session-nudges.js", () => ({
  loadSessionNudges: async () => undefined,
}));

const { sessionHandlers } = await import("../handlers/session.js");

const MANIFEST = JSON.parse(
  readFileSync(
    join(import.meta.dirname, "../tools/mcp-tools.manifest.json"),
    "utf8"
  )
) as { tools: Array<{ name: string; inputSchema: Record<string, any> }> };

const MINE = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const PR = {
  key: "pr-backend-281",
  kind: "pull_request",
  label: "backend#281",
  ref: { url: "https://github.com/Synap-core/backend/pull/281" },
};

const run = async (args: Record<string, unknown>) =>
  JSON.parse(
    (
      (await sessionHandlers.synap_update_session!({
        toolName: "synap_update_session",
        args,
        userId: "user-1",
        apiKeyScopes: ["mcp.write", "mcp.read"],
        workspaceAccessible: false,
        caller: {} as never,
        lensCaller: {} as never,
      } as never)) as { content: Array<{ text: string }> }
    ).content[0]!.text
  ) as Record<string, unknown>;

beforeEach(() => {
  h.calls.length = 0;
  h.resolverCalls = 0;
});

describe("the manifest no longer REQUIRES sessionId on update_session", () => {
  it("advertises it as optional, and says what happens without it", () => {
    const tool = MANIFEST.tools.find((t) => t.name === "synap_update_session");
    expect(tool).toBeDefined();
    expect(tool!.inputSchema.required ?? []).not.toContain("sessionId");
    expect(
      String(tool!.inputSchema.properties.sessionId.description)
    ).toContain("Optional");
  });
});

describe("update_session with no sessionId", () => {
  it("ONE open session this conversation started: the write lands on it, said as inferred", async () => {
    h.found = { status: "one", sessionId: MINE };
    const out = await run({ outcomes: [PR] });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ sessionId: MINE });
    expect(out).toMatchObject({
      status: "updated",
      inferred: true,
      via: "client",
    });
  });

  it("SEVERAL: refused with the list, and the service is never reached", async () => {
    h.found = {
      status: "several",
      count: 2,
      sessions: [
        { id: MINE, title: "Work map", startedAt: null },
        { id: OTHER, title: "Fixes", startedAt: null },
      ],
    };
    const out = await run({ outcomes: [PR] });
    expect(h.calls).toHaveLength(0);
    expect(String(out.error)).toContain("NOTHING WAS CHANGED");
    expect(out.sessions).toEqual([
      expect.objectContaining({ id: MINE }),
      expect.objectContaining({ id: OTHER }),
    ]);
  });

  it.each(["none", "no_client", "unavailable"])(
    "%s: refused in words, never guessed",
    async (status) => {
      h.found = { status };
      const out = await run({ outcomes: [PR] });
      expect(h.calls).toHaveLength(0);
      expect(String(out.error)).toContain("sessionId is required");
    }
  );

  it("a named sessionId never asks the resolver", async () => {
    h.found = { status: "one", sessionId: OTHER };
    await run({ sessionId: MINE, outcomes: [PR] });
    expect(h.resolverCalls).toBe(0);
    expect(h.calls[0]).toMatchObject({ sessionId: MINE });
  });
});
