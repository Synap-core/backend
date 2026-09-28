/**
 * The built space brief, MEASURED from the REAL templates (WT source), with
 * W3's steady-state fields (purpose, anchors, rule refs) in the installed
 * shape: the root anchor resolved to an entity id, every template rule
 * installed (a ref with a rule id). Worst case on purpose: every template
 * profile counts as a kind owned here, every template playbook as an active
 * playbook of this space.
 *
 * Asserts, for EVERY template that ships a brief (derived, not hand-listed):
 *   - the serialized brief fits `BRIEF_BUDGET_BYTES`;
 *   - purpose, persona (when authored), the root anchor and every kind's slug
 *     survive — the playbook LIST is shed before any of them.
 * Brand Library and CRM byte counts are pinned in the report below.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  ranked: [] as unknown[],
  playbooks: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: () => unknown[]) => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: () => self,
      limit: () => self,
      then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) =>
        Promise.resolve(rows()).then(r, j),
    };
    return self;
  };
  return {
    ...actual,
    db: { selectDistinct: () => chain(() => []), select: () => chain(() => []) },
  };
});
vi.mock("./start-here.js", () => ({
  readRankedLensProfiles: async () => h.ranked,
}));
vi.mock("../../routers/hub-protocol/playbook-doors.js", () => ({
  listPlaybooksDoor: async () => ({ playbooks: h.playbooks, nextCursor: null }),
}));

import {
  buildSpaceBrief,
  briefBytes,
  BRIEF_BUDGET_BYTES,
  BRIEF_PROSE_CAP,
  type BuiltSpaceBrief,
} from "./space-brief.js";

const here = dirname(fileURLToPath(import.meta.url));
const WT = join(here, "../../../../../../synap-app/packages/workspace-templates/src");
const WS = "f001a1a7-56d1-4734-8b9a-cbbe9c28bb01";
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Tpl = {
  slug: string;
  description?: string;
  onboarding?: Record<string, unknown>;
  profiles: Array<Record<string, unknown>>;
  playbooks: Array<Record<string, unknown>>;
  rules: Array<{ key: string }>;
};

async function templates(): Promise<Tpl[]> {
  const define = await import(/* @vite-ignore */ join(WT, "define.ts"));
  const index = await import(/* @vite-ignore */ join(WT, "index.ts"));
  const slugs: string[] = Object.keys(index.WORKSPACE_TEMPLATES);
  return slugs.map((slug) => {
    const ws = define.toWorkspaceDefinition(slug).definition;
    const pkg = define.toPackageDefinition(slug);
    return {
      slug,
      description: ws.description,
      onboarding: ws.onboarding,
      profiles: ws.profiles ?? [],
      playbooks: pkg.playbooks ?? [],
      rules: pkg.rules ?? [],
    };
  });
}

/** The brief as the pod stores it after install (create path + rule applier). */
function installedBrief(t: Tpl): Record<string, unknown> {
  const o = { ...(t.onboarding ?? {}) };
  if (Array.isArray(o.anchors)) {
    o.anchors = (o.anchors as Array<Record<string, unknown>>).map((a, i) =>
      a.role === "root" ? { ...a, entityId: uuid(900 + i) } : a
    );
  }
  if (t.rules.length) {
    o.rules = t.rules.map((r, i) => ({ key: r.key, ruleId: uuid(800 + i) }));
  }
  return o;
}

async function build(t: Tpl): Promise<BuiltSpaceBrief> {
  let rank = 0;
  h.ranked = t.profiles
    .filter((p) => (p.profileKind ?? "kind") === "kind")
    .map((p) => ({
      profile: {
        id: `id-${String(p.slug)}`,
        slug: p.slug,
        displayName: p.displayName ?? p.slug,
        profileKind: "kind",
        workspaceId: WS,
        uiHints: p.uiHints ?? {},
        description: p.description,
      },
      rank: ++rank,
      score: 1,
      entityCount: 3,
      lastActivityAt: null,
      origin: { origin: "core", group: "core" },
    }));
  h.playbooks = t.playbooks.map((pb, i) => ({
    id: uuid(i),
    name: pb.name,
    description: pb.description ?? null,
    workspaceId: WS,
  }));
  return (await buildSpaceBrief({
    caller: {} as never,
    userId: "u1",
    scopes: ["mcp.read"],
    workspaceId: WS,
    workspace: {
      id: WS,
      name: t.slug,
      description: t.description ?? null,
      settings: { onboarding: installedBrief(t) },
    },
  })) as BuiltSpaceBrief;
}

let all: Tpl[] = [];
beforeEach(async () => {
  if (!all.length) all = await templates();
});

describe("built brief — measured from the real templates", () => {
  it("non-vacuity: the scan sees the templates that ship a brief", () => {
    const withBrief = all.filter((t) => t.onboarding);
    expect(all.length).toBeGreaterThan(20);
    expect(withBrief.length).toBeGreaterThan(10);
    expect(withBrief.map((t) => t.slug)).toEqual(
      expect.arrayContaining(["brand-library", "crm"])
    );
  });

  it("every template's brief fits the cap and keeps purpose, persona, root anchor and every kind", async () => {
    const report: Record<string, number> = {};
    for (const t of all.filter((x) => x.onboarding)) {
      const brief = await build(t);
      const bytes = briefBytes(brief);
      report[t.slug] = bytes;
      expect(bytes, t.slug).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
      expect(brief.purpose, `${t.slug}: purpose`).toBeDefined();
      if (typeof t.onboarding?.framing === "string")
        expect(brief.persona, `${t.slug}: persona`).toBeDefined();
      const root = (
        t.onboarding?.anchors as Array<{ role: string; profileSlug: string }>
      )?.find((a) => a.role === "root");
      if (root)
        expect(brief.anchors?.root?.kind, `${t.slug}: root`).toBe(
          root.profileSlug
        );
      // The kind LIST is capped by BRIEF_KIND_CAP by design (builder has
      // 25); the budget must never be what drops a kind.
      expect(brief.trimmed ?? [], `${t.slug}: kinds shed`).not.toContain(
        "keyKinds.items"
      );
    }
    console.info("[space-brief bytes]", JSON.stringify(report));
  });

  it("Brand Library: the W3 fields arrive; the playbook list goes before them", async () => {
    const t = all.find((x) => x.slug === "brand-library")!;
    const brief = await build(t);
    // ONE ladder: the authored description (the template's own) wins.
    const flat = t.description!.replace(/\s+/g, " ").trim();
    expect(brief.purpose).toBe(
      flat.length > BRIEF_PROSE_CAP
        ? `${flat.slice(0, BRIEF_PROSE_CAP - 1)}…`
        : flat
    );
    expect(brief.anchors?.root).toEqual({
      kind: "brand-identity",
      entityId: uuid(900),
    });
    const trimmed = brief.trimmed ?? [];
    for (const kept of ["persona", "anchors.root", "keyKinds.items"])
      expect(trimmed).not.toContain(kept);
    console.info(
      "[brand-library]",
      briefBytes(brief),
      "B trimmed:",
      JSON.stringify(trimmed),
      "rules:",
      JSON.stringify(brief.rules ?? null)
    );
  });

  it("CRM fits and keeps its kinds", async () => {
    const brief = await build(all.find((x) => x.slug === "crm")!);
    expect(briefBytes(brief)).toBeLessThanOrEqual(BRIEF_BUDGET_BYTES);
    console.info(
      "[crm]",
      briefBytes(brief),
      "B trimmed:",
      JSON.stringify(brief.trimmed ?? [])
    );
  });

  it("every key the pod emits is declared on hub-rest-client's HubBuiltSpaceBrief", async () => {
    // RIGHT: the client mirror's top-level keys, parsed from SOURCE (the
    // package is zero-dependency; nothing to import at runtime).
    const src = readFileSync(
      join(here, "../../../../hub-rest-client/src/types.ts"),
      "utf8"
    );
    const start = src.indexOf("export interface HubBuiltSpaceBrief {");
    expect(start, "HubBuiltSpaceBrief not found").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const declared = new Set(
      [...body.matchAll(/^  ([A-Za-z]+)\??:/gm)].map((m) => m[1]!)
    );
    // LEFT: every top-level key a REAL built brief carries, across templates.
    const emitted = new Set<string>();
    for (const t of all.filter((x) => x.onboarding))
      for (const k of Object.keys(await build(t))) emitted.add(k);
    // Non-vacuity on both sides.
    expect(declared.size).toBeGreaterThan(10);
    expect([...emitted]).toEqual(
      expect.arrayContaining(["purpose", "anchors", "rules", "keyKinds", "more"])
    );
    expect([...emitted].filter((k) => !declared.has(k))).toEqual([]);
  });
});
