/**
 * The status-banner type list has two readers: `placeSignal` (client lens,
 * `STATUS_BANNER_NOTIFICATION_TYPES` in @synap-core/types/lens) and the server
 * read (`needsYouRole(type) === "status"`, registry.ts). This holds them equal,
 * derived from the registry so a new `needsYou: "status"` type fails here.
 * Not covered: a type that is neither flagged nor listed (that is Blocking on
 * both sides, by design).
 */
import { describe, expect, it } from "vitest";
import { STATUS_BANNER_NOTIFICATION_TYPES } from "@synap-core/types/lens";
import { NOTIFICATION_REGISTRY, needsYouRole } from "../registry.js";

describe("status banner types: client list === server registry", () => {
  const server = NOTIFICATION_REGISTRY.filter(
    (d) => needsYouRole(d.type) === "status"
  )
    .map((d) => d.type)
    .sort();
  it("is non-vacuous", () => {
    expect(server.length).toBeGreaterThan(0);
  });
  it("matches exactly", () => {
    expect(server).toEqual([...STATUS_BANNER_NOTIFICATION_TYPES].sort());
  });
  it("workspace.invite (system category, an ask) is not health on either side", () => {
    expect(needsYouRole("workspace.invite")).not.toBe("status");
    expect(STATUS_BANNER_NOTIFICATION_TYPES.has("workspace.invite")).toBe(
      false
    );
  });
});
