import { describe, expect, it } from "vitest";

import { staleConnectionIds } from "./stale-connections.js";
import type { SyncConnectorConnection } from "./SyncConnector.js";

function conn(
  connectionId: string,
  over: Partial<SyncConnectorConnection> = {}
): SyncConnectorConnection {
  return {
    connectionId,
    provider: "google",
    userId: "user-1",
    createdAt: null,
    ...over,
  };
}
const at = (iso: string) => new Date(iso);

describe("staleConnectionIds — one connection per user and provider", () => {
  it("the founder's pod: a new connection beside three dead ones keeps only the new one", () => {
    // 2026-10-28: the reconnect's 4dd59bd0 listed first, the three dead after.
    const stale = staleConnectionIds([
      conn("new", { createdAt: at("2026-10-28T10:20:00Z") }),
      conn("dead-1", { createdAt: at("2026-09-13T00:00:00Z"), hasError: true }),
      conn("dead-2", { createdAt: at("2026-10-04T00:00:00Z"), hasError: true }),
      conn("dead-3", { createdAt: at("2026-10-20T00:00:00Z"), hasError: true }),
    ]);
    expect(stale.sort()).toEqual(["dead-1", "dead-2", "dead-3"]);
  });

  it("keeps the newest by date, not the first listed", () => {
    // List order is what the old dedupe kept once every date read as null.
    const stale = staleConnectionIds([
      conn("old", { createdAt: at("2026-09-01T00:00:00Z") }),
      conn("new", { createdAt: at("2026-10-01T00:00:00Z") }),
    ]);
    expect(stale).toEqual(["old"]);
  });

  it("keeps a healthy connection over a newer dead one", () => {
    const stale = staleConnectionIds([
      conn("live", { createdAt: at("2026-09-01T00:00:00Z") }),
      conn("dead", { createdAt: at("2026-10-01T00:00:00Z"), hasError: true }),
    ]);
    expect(stale).toEqual(["dead"]);
  });

  it("never revokes a healthy connection whose age is unknown", () => {
    const stale = staleConnectionIds([
      conn("a", { createdAt: null }),
      conn("b", { createdAt: at("2026-10-01T00:00:00Z") }),
    ]);
    expect(stale).toEqual([]);
  });

  it("revokes an undated dead connection beside a live one", () => {
    const stale = staleConnectionIds([
      conn("live", { createdAt: null }),
      conn("dead", { createdAt: null, hasError: true }),
    ]);
    expect(stale).toEqual(["dead"]);
  });

  it("all dead: keeps the newest, so the person still has one to reconnect", () => {
    const stale = staleConnectionIds([
      conn("older", { createdAt: at("2026-09-01T00:00:00Z"), hasError: true }),
      conn("newer", { createdAt: at("2026-10-01T00:00:00Z"), hasError: true }),
    ]);
    expect(stale).toEqual(["older"]);
  });

  it("never touches an object-scoped connection (a deliberate second account)", () => {
    const stale = staleConnectionIds([
      conn("scoped", {
        createdAt: at("2026-09-01T00:00:00Z"),
        hasError: true,
        objectScoped: true,
      }),
      conn("plain", { createdAt: at("2026-10-01T00:00:00Z") }),
    ]);
    expect(stale).toEqual([]);
  });

  it("each provider keeps its own one; a single connection is never stale", () => {
    const stale = staleConnectionIds([
      conn("g-old", { createdAt: at("2026-09-01T00:00:00Z") }),
      conn("g-new", { createdAt: at("2026-10-01T00:00:00Z") }),
      conn("slack", {
        provider: "slack",
        createdAt: at("2026-08-01T00:00:00Z"),
        hasError: true,
      }),
    ]);
    expect(stale).toEqual(["g-old"]);
  });
});
