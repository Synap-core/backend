/**
 * The ONE brand-resolution rule: the Brand SPACE (given → declared → provider
 * role → oldest), then the brand IDENTITY inside it (project → default flag →
 * only brand), and the kit rows that follow the identity's project.
 */
import { describe, expect, it } from "vitest";

import {
  BRAND_ABSENCE_MESSAGES,
  pickBrandIdentity,
  pickBrandWorkspace,
  type BrandSpaceRow,
} from "./resolve.js";

const brand = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  settings: { workspaceCapabilities: ["brand.library"], ...extra },
});
const plain = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  settings: { workspaceCapabilities: ["content.pipeline"], ...extra },
});

describe("pickBrandWorkspace — the Brand space", () => {
  it("the given workspace wins when it IS a Brand Library", () => {
    expect(
      pickBrandWorkspace({
        visible: [
          brand("pod", { sourceRoles: { brand: "provider" } }),
          brand("ws"),
        ],
        workspaceId: "ws",
      })
    ).toBe("ws");
  });

  it("a consumer's declared brand source resolves", () => {
    expect(
      pickBrandWorkspace({
        visible: [
          brand("pod", { sourceRoles: { brand: "provider" } }),
          brand("declared"),
          plain("content", {
            defaultSources: { brand: { workspaceId: "declared" } },
          }),
        ],
        workspaceId: "content",
      })
    ).toBe("declared");
  });

  it("a declared source the caller cannot see is ignored", () => {
    expect(
      pickBrandWorkspace({
        visible: [
          brand("pod"),
          plain("content", {
            defaultSources: { brand: { workspaceId: "hidden" } },
          }),
        ],
        workspaceId: "content",
      })
    ).toBe("pod");
  });

  it("the brand-provider role wins, else the oldest library", () => {
    expect(
      pickBrandWorkspace({
        visible: [
          brand("old"),
          brand("prov", { sourceRoles: { brand: "provider" } }),
        ],
      })
    ).toBe("prov");
    expect(pickBrandWorkspace({ visible: [brand("old"), brand("new")] })).toBe(
      "old"
    );
  });

  it("null when no visible workspace is a Brand Library", () => {
    expect(
      pickBrandWorkspace({
        visible: [plain("a", { sourceRoles: { brand: "provider" } })],
        workspaceId: "a",
      })
    ).toBeNull();
  });
});

const row = (
  id: string,
  profileSlug: string,
  projectIds: string[],
  properties: Record<string, unknown> = {}
): BrandSpaceRow => ({ id, profileSlug, title: id, properties, projectIds });

const SYNAP = row("i-synap", "brand-identity", ["S"]);
const ARCH = row("i-arch", "brand-identity", ["A"]);
const S_COLOR = row("c-s", "brand-color", ["S"]);
const A_COLOR = row("c-a", "brand-color", ["A"]);
const LOOSE_COLOR = row("c-loose", "brand-color", []);
const TWO = [SYNAP, ARCH, S_COLOR, A_COLOR, LOOSE_COLOR];
const ids = (r: BrandSpaceRow[]) => r.map((x) => x.id).sort();

describe("pickBrandIdentity — brands differ by project", () => {
  it("project S → S's identity and ONLY S's rows", () => {
    const p = pickBrandIdentity({ rows: TWO, projectId: "S" });
    expect(p).toMatchObject({
      ok: true,
      brandIdentityId: "i-synap",
      projectId: "S",
      resolvedVia: "project",
    });
    expect(p.ok && ids(p.kitRows)).toEqual(["c-s", "i-synap"]);
  });

  it("project A → A's identity and ONLY A's rows", () => {
    const p = pickBrandIdentity({ rows: TWO, projectId: "A" });
    expect(p.ok && p.brandIdentityId).toBe("i-arch");
    expect(p.ok && ids(p.kitRows)).toEqual(["c-a", "i-arch"]);
  });

  it("a project with no identity → no-brand-for-project, never another project's brand", () => {
    expect(pickBrandIdentity({ rows: TWO, projectId: "X" })).toEqual({
      ok: false,
      reason: "no-brand-for-project",
      message: BRAND_ABSENCE_MESSAGES["no-brand-for-project"],
    });
  });

  it("no project, two identities, no flag → no-default-brand", () => {
    expect(pickBrandIdentity({ rows: TWO })).toEqual({
      ok: false,
      reason: "no-default-brand",
      message: BRAND_ABSENCE_MESSAGES["no-default-brand"],
    });
  });

  it("no project, the flagged identity wins, with its project's rows", () => {
    const flaggedS = row("i-synap", "brand-identity", ["S"], {
      "default-brand": true,
    });
    const p = pickBrandIdentity({
      rows: [flaggedS, ARCH, S_COLOR, A_COLOR, LOOSE_COLOR],
    });
    expect(p).toMatchObject({
      ok: true,
      brandIdentityId: "i-synap",
      projectId: "S",
      resolvedVia: "default-flag",
    });
    expect(p.ok && ids(p.kitRows)).toEqual(["c-s", "i-synap"]);
  });

  it("no project, a single identity → it (only-brand)", () => {
    const p = pickBrandIdentity({ rows: [SYNAP, S_COLOR, A_COLOR] });
    expect(p).toMatchObject({
      ok: true,
      brandIdentityId: "i-synap",
      resolvedVia: "only-brand",
    });
  });

  it("an identity in no project builds its kit from the rows in no project", () => {
    const solo = row("i-solo", "brand-identity", []);
    const p = pickBrandIdentity({ rows: [solo, S_COLOR, LOOSE_COLOR] });
    expect(p).toMatchObject({ ok: true, projectId: null });
    expect(p.ok && ids(p.kitRows)).toEqual(["c-loose", "i-solo"]);
  });

  it("an archived identity is never picked", () => {
    const archived = row("i-arch", "brand-identity", ["A"], {
      "brand-status": "archived",
    });
    expect(pickBrandIdentity({ rows: [SYNAP, archived] })).toMatchObject({
      ok: true,
      brandIdentityId: "i-synap",
      resolvedVia: "only-brand",
    });
  });

  it("no identity at all → no-default-brand with an honest message", () => {
    const p = pickBrandIdentity({ rows: [S_COLOR] });
    expect(p).toMatchObject({ ok: false, reason: "no-default-brand" });
    expect(!p.ok && p.message).toMatch(/no brand identity/);
  });
});
