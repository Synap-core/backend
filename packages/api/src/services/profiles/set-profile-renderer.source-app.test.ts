/**
 * Places `source-app` renderer — the wire accepts it, and the write door scopes
 * it to user × profile kind detail.
 *
 * The Zod half is driven through the REAL procedure input parsers (not a copy
 * of the schema), so a router that drops the arm fails here. The refusal half
 * runs before `getDb()`, so it needs no database mock — a call that got past it
 * would crash on the unmocked DB instead of rejecting with BAD_REQUEST.
 */
import { describe, expect, it } from "vitest";

import { profilesRouter } from "../../routers/profiles.js";
import { setProfileRenderer } from "./set-profile-renderer.js";

type Parser = {
  parse: (v: unknown) => unknown;
  safeParse: (v: unknown) => { success: boolean };
};

function inputParser(r: unknown, name: string): Parser {
  const proc = (r as { _def: { procedures: Record<string, unknown> } })._def
    .procedures[name] as { _def: { inputs: Parser[] } } | undefined;
  if (!proc) throw new Error(`procedure ${name} not found`);
  return proc._def.inputs[0]!;
}

describe("RendererRef wire schemas accept source-app", () => {
  it("profiles.setProfileRendererOverride", () => {
    const parser = inputParser(profilesRouter, "setProfileRendererOverride");
    const ok = parser.safeParse({
      profileSlug: "email",
      contentKind: "entity-detail",
      scope: "user",
      ref: { kind: "source-app" },
    });
    expect(ok.success).toBe(true);
    // Non-vacuity: the same parser still rejects an unknown kind.
    expect(
      parser.safeParse({
        profileSlug: "email",
        contentKind: "entity-detail",
        scope: "user",
        ref: { kind: "open-anywhere" },
      }).success
    ).toBe(false);
  });
});

describe("setProfileRenderer scopes source-app to user × detail", () => {
  const base = {
    userId: "u-1",
    workspaceId: null,
    profileSlug: "email",
    ref: { kind: "source-app" as const },
  };

  it("refuses workspace and pod scope", async () => {
    await expect(
      setProfileRenderer({
        ...base,
        workspaceId: "ws-1",
        scope: "workspace",
        slot: "detail",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      setProfileRenderer({ ...base, scope: "pod", slot: "detail" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a non-detail slot even at user scope", async () => {
    for (const slot of ["list", "card", "dashboard"] as const) {
      await expect(
        setProfileRenderer({ ...base, scope: "user", slot })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
  });
});
