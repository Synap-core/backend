import { describe, it, expect } from "vitest";
import type { secrets } from "@synap/database/schema";

import { mergeConnectionViews } from "./capability-connections.js";

/**
 * `mergeConnectionViews` — the pure core of the MERGED connection list (the fix
 * for "Connected card + empty list"). It unions the persisted registry rows with
 * the live Nango connections so the list shows what the card shows, deduped on
 * accountHint == Nango connectionId, and — crucially — preserves persisted rows
 * when Nango faults (live-truth must survive an outage).
 */

/** Minimal `secrets` row factory — only the fields the view mapper reads. */
function row(
  over: Partial<typeof secrets.$inferSelect>
): typeof secrets.$inferSelect {
  return {
    id: "sec-id",
    name: "label",
    contextType: null,
    contextId: null,
    isDefault: false,
    accountHint: null,
    providerIntegrationId: null,
    isPodWide: false,
    connectionState: null,
    ...over,
  } as typeof secrets.$inferSelect;
}

const CONN = "conn_abcdef123456";

describe("mergeConnectionViews", () => {
  it("(a) live connection with no secrets row → one SYNTHETIC row (persisted:false)", () => {
    const views = mergeConnectionViews([], {
      ok: true,
      connections: [{ connectionId: CONN, provider: "google" }],
    });

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: `nango:${CONN}`,
      accountHint: CONN,
      kind: "nango",
      provider: "google",
      persisted: false,
      health: "connected",
    });
    // Only row → it is the enforced default.
    expect(views[0].isDefault).toBe(true);
    // Label carries the provider + a last-6 tail.
    expect(views[0].label).toContain("google");
    expect(views[0].label).toContain("123456");
  });

  it("(b) same connection also in secrets → appears ONCE (dedup), persisted:true", () => {
    const persisted = [
      row({ id: "sec-1", accountHint: CONN, name: "google · 123456" }),
    ];
    const views = mergeConnectionViews(persisted, {
      ok: true,
      connections: [{ connectionId: CONN, provider: "google" }],
    });

    // Deduped on connectionId — the persisted row wins, no synthetic twin.
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      id: "sec-1",
      accountHint: CONN,
      persisted: true,
      // provider comes from the live join even though the row doesn't store it.
      provider: "google",
    });
  });

  it("(c) Nango fault → persisted rows preserved, nothing blanked or synthesized", () => {
    const persisted = [
      row({ id: "sec-1", accountHint: CONN, isDefault: true }),
      row({ id: "sec-2", accountHint: "conn_other999999" }),
    ];
    const views = mergeConnectionViews(persisted, {
      ok: false,
      connections: [],
    });

    expect(views.map((v) => v.id)).toEqual(["sec-1", "sec-2"]);
    expect(views.every((v) => v.persisted)).toBe(true);
    // The stored default survives the fault.
    expect(views.find((v) => v.id === "sec-1")?.isDefault).toBe(true);
    expect(views.find((v) => v.id === "sec-2")?.isDefault).toBe(false);
  });

  it("annotates health from the connection_state mirror (needs_reauth)", () => {
    const persisted = [
      row({ id: "sec-1", accountHint: CONN, connectionState: "needs_reauth" }),
    ];
    const views = mergeConnectionViews(persisted, {
      ok: false,
      connections: [],
    });
    expect(views[0].health).toBe("needs_reauth");
  });

  it("collapses cross-tier double defaults to exactly one", () => {
    // A per-user default AND a pod-wide default can coexist in storage; the view
    // must present exactly one so a picker has a single target.
    const persisted = [
      row({ id: "sec-user", isDefault: true, isPodWide: false }),
      row({ id: "sec-pod", isDefault: true, isPodWide: true }),
    ];
    const views = mergeConnectionViews(persisted, {
      ok: false,
      connections: [],
    });
    expect(views.filter((v) => v.isDefault)).toHaveLength(1);
    // First row (persisted order) wins.
    expect(views[0].isDefault).toBe(true);
  });
});
