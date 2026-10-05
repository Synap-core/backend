/**
 * Brand kit service — resolution order (project → workspace → pod default),
 * typed absence vs thrown failure, and the access-layer seam of the kit read.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  visible: [] as Array<{
    id: string;
    settings: Record<string, unknown> | null;
  }>,
  projectRow: undefined as { id: string } | undefined,
  used: new Map<string, string[]>(),
  profileRows: [] as Array<{ id: string; slug: string }>,
  entityRows: [] as Array<Record<string, unknown>>,
  selectThrows: null as Error | null,
  lenses: [] as Array<unknown>,
  entityWhere: null as unknown,
  entityOrderBy: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: () => unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const k of ["from", "where"]) q[k] = () => q;
    q.orderBy = async () => {
      if (h.selectThrows) throw h.selectThrows;
      return rows();
    };
    q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej);
    return q;
  };
  return {
    ...actual,
    db: {
      select: (cols: Record<string, unknown>) =>
        "slug" in cols ? chain(() => h.profileRows) : chain(() => h.visible),
    },
  };
});

vi.mock("../../access/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../access/index.js")>();
  const ctx = (lens?: unknown) => ({
    lens,
    withLens: (l: unknown) => ctx(l),
  });
  return {
    ...actual,
    AccessContext: { agent: () => ctx(undefined) },
    scopedDb: (access: { lens: unknown }) => ({
      findFirst: async () => h.projectRow,
      findMany: async (
        _t: unknown,
        opts: { where: unknown; orderBy?: unknown }
      ) => {
        h.lenses.push(access.lens);
        h.entityWhere = opts.where;
        h.entityOrderBy = opts.orderBy;
        return h.entityRows;
      },
    }),
  };
});

vi.mock("../../utils/project-workspace.js", () => ({
  listWorkspacesUsedByProjects: async (_db: unknown, ids: string[]) =>
    new Map(ids.map((id) => [id, h.used.get(id) ?? []])),
}));

import {
  pickBrandWorkspace,
  readBrandKit,
  resolveBrandWorkspace,
} from "./brand-kit-service.js";

const brand = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  settings: { workspaceCapabilities: ["brand.library"], ...extra },
});
const plain = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  settings: { workspaceCapabilities: ["content.pipeline"], ...extra },
});

beforeEach(() => {
  h.visible = [];
  h.projectRow = undefined;
  h.used = new Map();
  h.profileRows = [];
  h.entityRows = [];
  h.selectThrows = null;
  h.lenses = [];
  h.entityWhere = null;
  h.entityOrderBy = null;
});

describe("pickBrandWorkspace — resolution order", () => {
  it("1. project: the project's used Brand Library wins over everything", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod", { sourceRoles: { brand: "provider" } }),
        brand("proj"),
        brand("ws"),
      ],
      projectUsedIds: ["other", "proj"],
      workspaceId: "ws",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "proj",
      resolvedVia: "project",
    });
  });

  it("1. project: among several used libraries, the brand-provider role wins", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod", { sourceRoles: { brand: "provider" } }),
        brand("a"),
        brand("b", { sourceRoles: { brand: "provider-consumer" } }),
      ],
      projectUsedIds: ["a", "b"],
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "b",
      resolvedVia: "project",
    });
  });

  it("1→2. a project that uses no Brand Library falls through to the workspace", () => {
    const r = pickBrandWorkspace({
      visible: [plain("content"), brand("ws")],
      projectUsedIds: ["content"],
      workspaceId: "ws",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "ws",
      resolvedVia: "workspace",
    });
  });

  it("2. workspace: a consumer's declared brand source resolves via the workspace", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod", { sourceRoles: { brand: "provider" } }),
        brand("declared"),
        plain("content", {
          defaultSources: { brand: { workspaceId: "declared" } },
        }),
      ],
      workspaceId: "content",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "declared",
      resolvedVia: "workspace",
    });
  });

  it("2. a declared source the caller cannot see is ignored", () => {
    const r = pickBrandWorkspace({
      visible: [
        brand("pod"),
        plain("content", {
          defaultSources: { brand: { workspaceId: "hidden" } },
        }),
      ],
      workspaceId: "content",
    });
    expect(r).toEqual({
      ok: true,
      brandWorkspaceId: "pod",
      resolvedVia: "pod-default",
    });
  });

  it("3. pod-default: the brand-provider role wins, else the oldest library", () => {
    expect(
      pickBrandWorkspace({
        visible: [
          brand("old"),
          brand("prov", { sourceRoles: { brand: "provider" } }),
        ],
      })
    ).toEqual({
      ok: true,
      brandWorkspaceId: "prov",
      resolvedVia: "pod-default",
    });
    expect(
      pickBrandWorkspace({ visible: [brand("old"), brand("new")] })
        ?.brandWorkspaceId
    ).toBe("old");
  });

  it("returns null when no visible workspace is a Brand Library", () => {
    expect(
      pickBrandWorkspace({
        visible: [plain("a", { sourceRoles: { brand: "provider" } })],
        projectUsedIds: ["a"],
        workspaceId: "a",
      })
    ).toBeNull();
  });
});

describe("resolveBrandWorkspace", () => {
  const USER = "u1";

  it("resolves through the project's used workspaces", async () => {
    h.projectRow = { id: "p1" };
    h.used.set("p1", ["lib"]);
    h.visible = [brand("pod"), brand("lib")];
    expect(
      await resolveBrandWorkspace({ userId: USER, projectId: "p1" })
    ).toEqual({
      ok: true,
      brandWorkspaceId: "lib",
      resolvedVia: "project",
    });
  });

  it("a project the caller cannot see is a typed project_not_found", async () => {
    h.visible = [brand("pod")];
    expect(
      await resolveBrandWorkspace({ userId: USER, projectId: "p-hidden" })
    ).toEqual({
      ok: false,
      reason: "project_not_found",
    });
  });

  it("no Brand Library is a typed no_brand_workspace", async () => {
    h.visible = [plain("a")];
    expect(await resolveBrandWorkspace({ userId: USER })).toEqual({
      ok: false,
      reason: "no_brand_workspace",
    });
  });

  it("a failed read THROWS — it is never reported as no brand", async () => {
    h.selectThrows = new Error("connection reset");
    await expect(resolveBrandWorkspace({ userId: USER })).rejects.toThrow(
      "connection reset"
    );
  });
});

describe("readBrandKit — access-layer seam", () => {
  it("reads through scopedDb lensed to the brand workspace and exports the real kit", async () => {
    h.profileRows = [
      { id: "pc", slug: "brand-color" },
      { id: "pr", slug: "brand-rule" },
    ];
    h.entityRows = [
      {
        profileId: "pc",
        title: "Ochre",
        properties: { "color-role": "primary", "color-hex": "#B67A38" },
      },
      {
        profileId: "pr",
        title: "R",
        properties: { "rule-content": "Be kind", "rule-severity": "mandatory" },
      },
    ];
    const kit = await readBrandKit({
      userId: "u1",
      brandWorkspaceId: "lib",
      format: "css",
    });
    expect(h.lenses).toEqual(["lib"]);
    // The read is pinned to the brand workspace itself, not just lensed to it.
    const where = new PgDialect().sqlToQuery(h.entityWhere as SQL);
    expect(where.sql).toContain('"workspace_id" = $1');
    expect(where.params[0]).toBe("lib");
    expect(kit.format).toBe("css");
    expect(kit.content).toContain("--brand-primary: #b67a38;");
    expect(kit.hash).toMatch(/^[0-9a-f]{14}$/);
  });

  it("voice-guide text (vocabulary / do / don't) reaches the exported kit", async () => {
    h.profileRows = [{ id: "pv", slug: "brand-voice-guide" }];
    // The row exactly as the entities table returns it: text lives in properties.
    h.entityRows = [
      {
        profileId: "pv",
        title: "General",
        properties: {
          "voice-tone-descriptors": "warm",
          "voice-vocabulary": "ship, build",
          "voice-example-do": "Say it plainly.",
          "voice-example-dont": "Synergize.",
        },
      },
    ];
    const kit = await readBrandKit({
      userId: "u1",
      brandWorkspaceId: "lib",
      format: "json",
    });
    const parsed = JSON.parse(kit.content) as {
      voice: Array<{ body?: string; tone?: string }>;
    };
    expect(parsed.voice).toEqual([
      {
        name: "General",
        tone: "warm",
        body: "Vocabulary: ship, build\nDo: Say it plainly.\nDon't: Synergize.",
      },
    ]);
  });

  it("the capped row read is ordered by id (deterministic past the cap)", async () => {
    h.profileRows = [{ id: "pc", slug: "brand-color" }];
    await readBrandKit({
      userId: "u1",
      brandWorkspaceId: "lib",
      format: "json",
    });
    const order = h.entityOrderBy as SQL[] | null;
    expect(Array.isArray(order)).toBe(true);
    const q = new PgDialect().sqlToQuery(order![0]!);
    expect(q.sql).toBe('"entities"."id" asc');
  });
});
