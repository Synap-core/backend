/**
 * `resolveProfileOrigin`: the stored `profiles.origin` value wins; only its
 * default `unknown` falls back to scope, and nothing is guessed.
 */

import { describe, it, expect } from "vitest";
import type { ProfileOrigin } from "@synap/database/schema";
import { resolveProfileOrigin } from "./profile-presentation.js";

const install = (id: string) =>
  id === "ws-crm"
    ? { templateId: "tpl-crm-v3", packageSlug: "crm" }
    : undefined;

describe("resolveProfileOrigin", () => {
  it("a stored 'unknown' on a workspace row still groups under its workspace (the column default)", () => {
    // Discriminating row: migration 0263 defaults `origin` to 'unknown' and
    // backfills only core/agent, so this is most workspace profiles.
    expect(
      resolveProfileOrigin(
        { scope: "workspace", workspaceId: "ws-crm", origin: "unknown" },
        install
      )
    ).toEqual({
      origin: "unknown",
      group: "workspace",
      workspaceId: "ws-crm",
      templateId: "tpl-crm-v3",
      packageSlug: "crm",
    });
  });

  it.each([["template"], ["authored"], ["agent"]] as Array<[ProfileOrigin]>)(
    "a stored '%s' is reported as stored, grouped by placement",
    (origin) => {
      expect(
        resolveProfileOrigin(
          { scope: "workspace", workspaceId: "ws-x", origin },
          install
        )
      ).toEqual({ origin, group: "workspace", workspaceId: "ws-x" });
      expect(resolveProfileOrigin({ scope: "shared", origin })).toEqual({
        origin,
        group: "shared",
      });
    }
  );

  it("a stored 'core' is core, and a system row with a stored 'unknown' derives core", () => {
    expect(resolveProfileOrigin({ scope: "system", origin: "core" })).toEqual({
      origin: "core",
      group: "core",
    });
    expect(
      resolveProfileOrigin({ scope: "system", origin: "unknown" })
    ).toEqual({ origin: "core", group: "core" });
  });

  it.each([
    [
      "a workspace row with no workspace id",
      { scope: "workspace", workspaceId: null, origin: "unknown" },
    ],
    ["a user-scoped row", { scope: "user", origin: "unknown" }],
    ["a missing scope and origin", {}],
    ["a value outside PROFILE_ORIGINS", { scope: "user", origin: "galaxy" }],
  ])("%s stays unknown — never guessed", (_label, profile) => {
    expect(resolveProfileOrigin(profile, install)).toEqual({
      origin: "unknown",
      group: "unknown",
    });
  });
});
