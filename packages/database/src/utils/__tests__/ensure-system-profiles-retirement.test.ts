/**
 * The seeder's RETIREMENT PASS, driven end-to-end through the real
 * `ensureSystemProfiles()` over in-memory repositories.
 *
 * Why the whole seeder and not only `planRetirementUnlink`: the defect was in
 * the LOOP's compare (`def?.slug !== retired.propertySlug`), and a helper test
 * cannot prove the loop calls the helper. These fixtures plant fossils on a pod
 * the seeder has already converged, run the seeder, and read the links back.
 *
 * The ambiguous fixture (two fold-equal links on ONE profile) is deliberately
 * not live-shaped: live data never exercises that branch, so a live-shaped test
 * would pass with the refusal missing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Def = {
  id: string;
  slug: string;
  profileId: string | null;
  workspaceId: string | null;
  uiHints?: unknown;
};
type Prof = {
  id: string;
  slug: string;
  entityScope?: string;
  uiHints?: unknown;
  defaultRenderers?: unknown;
};
type Link = { profileId: string; propertyDefId: string; required?: boolean };

const store = vi.hoisted(() => ({
  defs: [] as Def[],
  profiles: [] as Prof[],
  links: [] as Link[],
  seq: 0,
}));

vi.mock("../../client-pg.js", () => ({ getDb: async () => ({}) }));

vi.mock("../../index.js", async () => {
  const { ProfileScope } = await vi.importActual<
    typeof import("../../schema/profiles.js")
  >("../../schema/profiles.js");
  const { PropertyValueType } = await vi.importActual<
    typeof import("../../schema/property-defs.js")
  >("../../schema/property-defs.js");
  const id = () => `id-${++store.seq}`;
  class PropertyDefRepository {
    async getBySlug(
      slug: string,
      profileId?: string,
      workspaceId?: string | null
    ) {
      const ws = (d: Def) =>
        workspaceId === undefined || d.workspaceId === (workspaceId ?? null);
      if (profileId) {
        const scoped = store.defs.find(
          (d) => d.slug === slug && d.profileId === profileId && ws(d)
        );
        if (scoped) return scoped;
      }
      return (
        store.defs.find(
          (d) => d.slug === slug && d.profileId === null && ws(d)
        ) ?? null
      );
    }
    async getById(defId: string) {
      return store.defs.find((d) => d.id === defId) ?? null;
    }
    async create(input: {
      slug: string;
      profileId?: string;
      workspaceId?: string | null;
    }) {
      const def: Def = {
        ...input,
        id: id(),
        profileId: input.profileId ?? null,
        workspaceId: input.workspaceId ?? null,
      };
      store.defs.push(def);
      return def;
    }
    async update(defId: string, patch: Partial<Def>) {
      const def = store.defs.find((d) => d.id === defId)!;
      Object.assign(def, patch);
      return def;
    }
  }
  class ProfileRepository {
    async getBySlug(slug: string) {
      return store.profiles.find((p) => p.slug === slug) ?? null;
    }
    async create(input: Omit<Prof, "id">) {
      const p: Prof = { ...input, id: id() };
      store.profiles.push(p);
      return p;
    }
    async update(profileId: string, patch: Partial<Prof>) {
      const p = store.profiles.find((x) => x.id === profileId)!;
      Object.assign(p, patch);
      return p;
    }
  }
  class ProfilePropertyRepository {
    async link(input: Link) {
      const existing = store.links.find(
        (l) =>
          l.profileId === input.profileId &&
          l.propertyDefId === input.propertyDefId
      );
      if (existing) Object.assign(existing, input);
      else store.links.push({ ...input });
      return input;
    }
    async unlink(profileId: string, propertyDefId: string) {
      store.links = store.links.filter(
        (l) => !(l.profileId === profileId && l.propertyDefId === propertyDefId)
      );
    }
    async getByProfile(profileId: string) {
      return store.links.filter((l) => l.profileId === profileId);
    }
    async getByProperty(propertyDefId: string) {
      return store.links.filter((l) => l.propertyDefId === propertyDefId);
    }
  }
  return {
    PropertyDefRepository,
    ProfileRepository,
    ProfilePropertyRepository,
    PropertyValueType,
    ProfileScope,
  };
});

import {
  ensureSystemProfiles,
  planRetirementUnlink,
  reportEnsureSystemProfilesResult,
  type EnsureSystemProfilesResult,
} from "../ensure-system-profiles.js";

const profileId = (slug: string) =>
  store.profiles.find((p) => p.slug === slug)!.id;
const linkedSlugs = (slug: string) =>
  store.links
    .filter((l) => l.profileId === profileId(slug))
    .map((l) => store.defs.find((d) => d.id === l.propertyDefId)!.slug);
/** Plant a base def + link on a system profile, the shape an older writer left. */
function plantLink(profileSlug: string, defSlug: string): string {
  let def = store.defs.find(
    (d) => d.slug === defSlug && d.profileId === null && d.workspaceId === null
  );
  if (!def) {
    def = {
      id: `planted-${defSlug}`,
      slug: defSlug,
      profileId: null,
      workspaceId: null,
    };
    store.defs.push(def);
  }
  store.links.push({
    profileId: profileId(profileSlug),
    propertyDefId: def.id,
  });
  return def.id;
}

beforeEach(async () => {
  store.defs = [];
  store.profiles = [];
  store.links = [];
  store.seq = 0;
  // Converge a fresh pod first, so the fixtures below plant fossils on a pod
  // whose every declared link already exists.
  const first = await ensureSystemProfiles();
  expect(first.status).toBe("created");
});

describe("ensureSystemProfiles — retirement pass (F6 fold compare)", () => {
  it("retires a live `ek-type` link for the `ek_type` entry (exact compare could not see it)", async () => {
    plantLink("knowledge", "ek-type");
    expect(linkedSlugs("knowledge")).toContain("ek-type");

    const result = await ensureSystemProfiles();

    expect(result.status).not.toBe("error");
    expect(linkedSlugs("knowledge")).not.toContain("ek-type");
    // The seed's own knowledge contract survives.
    expect(linkedSlugs("knowledge")).toContain("knowledgeForm");
  });

  it("REFUSES when two links on one profile fold to the retired slug — neither is unlinked, the refusal is reported", async () => {
    const underscore = store.defs.find((d) => d.slug === "ek_type")!;
    store.links.push({
      profileId: profileId("knowledge"),
      propertyDefId: underscore.id,
    });
    plantLink("knowledge", "ek-type");

    const result = await ensureSystemProfiles();

    expect(result.status).not.toBe("error");
    expect(linkedSlugs("knowledge")).toEqual(
      expect.arrayContaining(["ek_type", "ek-type"])
    );
    expect(result.retirementsRefused).toEqual([
      {
        profileSlug: "knowledge",
        propertySlug: "ek_type",
        foldedSlugs: expect.arrayContaining(["ek_type", "ek-type"]),
      },
    ]);
  });

  it("retires `status` from decision and research, leaving the def and task's own `status` link intact", async () => {
    const statusDef = store.defs.find(
      (d) => d.slug === "status" && d.profileId === null
    )!;
    store.links.push({
      profileId: profileId("decision"),
      propertyDefId: statusDef.id,
    });
    store.links.push({
      profileId: profileId("research"),
      propertyDefId: statusDef.id,
    });

    await ensureSystemProfiles();

    expect(linkedSlugs("decision")).not.toContain("status");
    expect(linkedSlugs("research")).not.toContain("status");
    expect(linkedSlugs("decision")).toContain("decisionStatus");
    expect(linkedSlugs("research")).toContain("researchStatus");
    // Retirement removes the schema CLAIM only.
    expect(store.defs.some((d) => d.id === statusDef.id)).toBe(true);
    expect(linkedSlugs("task")).toContain("status");
  });

  it("a retirement never reaches another profile's fold-equal field", async () => {
    plantLink("task", "ek-type");
    await ensureSystemProfiles();
    expect(linkedSlugs("task")).toContain("ek-type");
  });
});

describe("planRetirementUnlink", () => {
  it("folds case and separators; none / unlink / ambiguous", () => {
    expect(planRetirementUnlink([], "ek_type")).toEqual({ kind: "none" });
    expect(
      planRetirementUnlink([{ propertyDefId: "a", slug: "EK-Type" }], "ek_type")
    ).toEqual({
      kind: "unlink",
      propertyDefId: "a",
      slug: "EK-Type",
    });
    expect(
      planRetirementUnlink(
        [
          { propertyDefId: "a", slug: "ek-type" },
          { propertyDefId: "b", slug: "ek_type" },
          { propertyDefId: "c", slug: null },
        ],
        "ek_type"
      )
    ).toEqual({ kind: "ambiguous", slugs: ["ek-type", "ek_type"] });
  });
});

describe("reportEnsureSystemProfilesResult", () => {
  const base: EnsureSystemProfilesResult = {
    status: "exists",
    message: "ok",
    profilesCreated: 0,
    propertiesCreated: 0,
    linksCreated: 0,
  };
  const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const messages = { ok: "reconciled", failed: "FAILED" };

  it("logs a status:error result at ERROR with the error — never INFO", () => {
    const l = logger();
    reportEnsureSystemProfilesResult(
      l,
      { ...base, status: "error", error: "boom" },
      messages
    );
    expect(l.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: "boom" }),
      "FAILED"
    );
    expect(l.info).not.toHaveBeenCalled();
  });

  it("logs success at INFO, and a refused retirement at WARN", () => {
    const l = logger();
    reportEnsureSystemProfilesResult(
      l,
      {
        ...base,
        retirementsRefused: [
          {
            profileSlug: "knowledge",
            propertySlug: "ek_type",
            foldedSlugs: ["ek_type", "ek-type"],
          },
        ],
      },
      messages
    );
    expect(l.info).toHaveBeenCalledWith(expect.anything(), "reconciled");
    expect(l.warn).toHaveBeenCalledTimes(1);
    expect(l.error).not.toHaveBeenCalled();
  });
});
