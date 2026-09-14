/**
 * synap_get_session — same malformed-id-as-500 trap as Hub REST GET
 * /focus-sessions/:id (see `hub-protocol/rest/focus-sessions.malformed-id.test.ts`).
 *
 * MCP tool schemas are ADVISORY — nothing validates `sessionId` server-side —
 * so a non-uuid handle reached `eq(focusSessions.id, wantedId)` and Postgres
 * threw invalid-uuid-syntax. `db.select` is spied (not the whole
 * `@synap/database` module — its barrel is real and import-safe) so the
 * assertion is "the row lookup never ran".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { db } from "@synap/database";
import { sessionHandlers } from "./session.js";
import type { McpToolContext } from "./shared.js";

function makeCtx(overrides: Partial<McpToolContext> = {}): McpToolContext {
  return {
    toolName: "synap_get_session",
    args: { sessionId: "not-a-uuid" },
    userId: "user-1",
    apiKeyScopes: ["mcp.read"],
    caller: {} as McpToolContext["caller"],
    lensCaller: {} as McpToolContext["lensCaller"],
    workspaceAccessible: false,
    ...overrides,
  };
}

describe("synap_get_session — malformed sessionId refused before the DB", () => {
  let selectSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    selectSpy = vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db.select must not be called for a malformed id");
    });
  });

  afterEach(() => {
    selectSpy.mockRestore();
  });

  it("reports 'not found' rather than throwing, and never queries the DB", async () => {
    const result = await sessionHandlers.synap_get_session!(makeCtx());
    expect(selectSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(
      (result.content?.[0] as { text: string }).text
    ) as { error?: string };
    expect(payload.error).toContain("not found");
  });

  it("a truncated (display-shortened) uuid is refused the same way", async () => {
    const result = await sessionHandlers.synap_get_session!(
      makeCtx({ args: { sessionId: "c074e8ac" } })
    );
    expect(selectSpy).not.toHaveBeenCalled();
    const payload = JSON.parse(
      (result.content?.[0] as { text: string }).text
    ) as { error?: string };
    expect(payload.error).toContain("not found");
  });
});
