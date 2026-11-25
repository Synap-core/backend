import { describe, it, expect } from "vitest";
import type { secrets } from "@synap/database/schema";

import {
  credentialKind,
  mergeCredentialViews,
} from "./capability-connections.js";

/**
 * `mergeCredentialViews` — the pure core of the MERGED credential list (the fix
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

describe("mergeCredentialViews", () => {
  it("(a) live connection with no secrets row → one SYNTHETIC row (persisted:false)", () => {
    const views = mergeCredentialViews([], {
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
    const views = mergeCredentialViews(persisted, {
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
    const views = mergeCredentialViews(persisted, {
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
    const views = mergeCredentialViews(persisted, {
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
    const views = mergeCredentialViews(persisted, {
      ok: false,
      connections: [],
    });
    expect(views.filter((v) => v.isDefault)).toHaveLength(1);
    // First row (persisted order) wins.
    expect(views[0].isDefault).toBe(true);
  });
});

/**
 * `credentialKind` gained `source` (a Storybook: a registry row with no secret
 * whose account hint names what the pod reads). Every row that classified
 * before classifies exactly as before; the rows below are the ones where the
 * old and new rules could disagree.
 */
describe("credentialKind", () => {
  const kind = (
    providerIntegrationId: string | null,
    accountHint: string | null
  ) => credentialKind({ providerIntegrationId, accountHint });

  it("keeps every existing row as it was: nango stays nango, a key stays vault", () => {
    expect(kind(null, null)).toBe("vault");
    expect(kind(null, CONN)).toBe("nango");
    expect(kind(null, "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b")).toBe("nango");
    expect(kind("pi-1", null)).toBe("nango");
    expect(kind("pi-1", CONN)).toBe("nango");
    // A hint that only CONTAINS the word, or names it without the colon, is no source.
    expect(kind(null, "my-storybook:x")).toBe("nango");
    expect(kind(null, "storybook")).toBe("nango");
  });

  it("reads a storybook hint with no provider integration as a source, and a provider integration always wins", () => {
    expect(kind(null, "storybook:Synap-core/app-bases")).toBe("source");
    expect(kind("pi-1", "storybook:Synap-core/app-bases")).toBe("nango");
  });

  it("shows a source row as a source in the merged list", () => {
    const views = mergeCredentialViews(
      [row({ id: "s1", accountHint: "storybook:https://sb.example.com" })],
      { ok: true, connections: [] }
    );
    expect(views.map((v) => [v.id, v.kind, v.provider])).toEqual([
      ["s1", "source", null],
    ]);
  });
});
