/**
 * Renderer bundle UPDATES on real rows (PGlite, the real 0436 + 0449
 * migrations, the real install, receipts, standing and Undo), with the
 * control plane faked at `fetch` under its `?meta=1` contract
 * (`{ package: { slug, version, contentHash, publishedAt, retired } }`):
 *
 *   - a pod with no bundle installs it on its first pass; a refusal (no
 *     plan) is recorded with the pod's machine reason, nothing installed;
 *   - a newer version waits for its soak (1 h fast, 24 h stable, from its
 *     publish), then applies on its own as the owner, receipt `automatic`;
 *     automatic updates off or unreadable, a pause, a frozen catalog leave it
 *     for the person, and the row says why (`waitReason`);
 *   - a retired installed version skips the soak;
 *   - HOLDS: a version whose `requires` this pod does not meet, one that drops
 *     a kit export another frame cell imports, one whose apply on its own
 *     failed: never installed on their own, never fetched again by the pass;
 *   - the package-updates doors: the standing lists Synap's bundle, a
 *     person's apply writes a receipt, an agent's is filed through
 *     `market.install`; pausing is a person's act, written to the log;
 *   - Undo re-installs the version kept on the pod after re-checking its
 *     recorded digest, and the undone version does not come back by itself.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  owner: "owner-1" as string | null,
  blocked: null as string | null,
  marketInstalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return {
    ...actual,
    db,
    getDb: async () => db,
    getCatalogSyncStamps: async () => ({}),
    podCpAuthHeaders: async () => ({
      via: "pod-jwt",
      headers: { Authorization: "Bearer pod.jwt" },
      bearer: "pod.jwt",
    }),
    readMarketplaceSources: async () => ({
      sources: [],
      official: null,
      status: {},
      tombstones: {},
      officialSignature: null,
    }),
    readOfficialCatalogDigest: async () => null,
  };
});
vi.mock("@synap-core/core/control-plane-url", () => ({
  controlPlaneBaseUrl: () => "https://cp.test",
}));
vi.mock("../../utils/domain-event-bridge.js", () => ({
  emitHubRealtimeEvent: () => undefined,
}));
// The signature standing (its own tests cover when the catalog is frozen).
vi.mock(
  "../capabilities/official-catalog-trust.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    officialCatalogStandingNow: async () => ({
      mode: "unsigned",
      verified: false,
      blocked: h.blocked,
      notice: null,
    }),
  })
);
vi.mock("../capabilities/pod-owner.js", () => ({
  resolvePodOwnerUserId: async () => h.owner,
}));
// The agent's door is `market.install` (its own tests cover the filing).
vi.mock("../capabilities/marketplace-install.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runMarketInstall: async (input: Record<string, unknown>) => {
    h.marketInstalls.push(input);
    return {
      status: "proposed",
      proposalId: "install-proposal-1",
      reviewUrl: "/p",
    };
  },
}));

import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { officialContentHash } from "@synap/jobs/workers/marketplace-source-verify.js";
import type { Context } from "../../types/context.js";
import {
  rendererSetSha256,
  RENDERER_BUNDLE_REQUIRES_UNMET,
} from "./install-renderer-bundle.js";
import {
  readRendererBundleUpdateState,
  setRendererBundleUpdatesPaused,
  syncRendererBundleUpdates,
} from "./renderer-bundle-updates.js";
import { listInstalledPackages } from "../package-updates/standing.js";
import {
  applyPackageUpdate,
  undoPackageUpdate,
} from "../package-updates/apply.js";
import { listPackageUpdateReceipts } from "../package-updates/receipts.js";

process.env.CONTROL_PLANE_URL = "https://cp.test";

const HERE = dirname(fileURLToPath(import.meta.url));
const migration = (file: string) =>
  readFileSync(
    resolve(HERE, `../../../../database/migrations/${file}`),
    "utf8"
  );

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const isArray = t.endsWith("[]");
    const base = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const type = isArray && !base.endsWith("[]") ? `${base}[]` : base;
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : c.name === "content_kind"
            ? " default 'widget'"
            : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const SLUG = "synap-renderers";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const mod = (source: string) => ({ source, sha256: sha(source) });

/** A valid bundle; `tokens` makes each build a different version. */
function bundle(
  tokens: string,
  requires?: Record<string, unknown>,
  kit: string = "Card"
) {
  const hostModules = {
    react: mod("export default {};"),
    reactDom: mod("export default { dom: true };"),
    reactDomClient: mod("export const createRoot = () => null;"),
    jsxRuntime: mod("export const jsx = () => null;"),
    kit: mod(`export const ${kit} = () => null;`),
    tokensCss: mod(tokens),
  };
  const card = `import { ${kit} } from "@synap/kit";\nexport default function C() { return null; }`;
  return {
    _meta: { slug: SLUG, version: "build", kind: "renderer-bundle" as const },
    bundleApi: 1 as const,
    reactVersion: "19.2.3",
    setSha256: rendererSetSha256(
      Object.fromEntries(
        Object.entries(hostModules).map(([k, v]) => [k, v.sha256])
      )
    ),
    kitExports: [kit],
    hostModules,
    cells: [
      {
        key: "entity-card",
        name: "Entity card",
        code: card,
        sha256: sha(card),
        contentKind: "entity-card",
        kitImports: [kit],
      },
    ],
    defaults: { "entity-card": "entity-card" },
    ...(requires ? { requires } : {}),
  };
}

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-23T12:00:00.000Z");

/** The control plane's rows, as the fake serves them. */
interface CpRow {
  version: string;
  contentHash: string;
  definition: Record<string, unknown>;
  publishedAt: Date;
  retired: boolean;
}
const cp = {
  rows: [] as CpRow[],
  refuse: null as null | string,
  calls: [] as string[],
  /** The definition read answers 500 (a failed apply). */
  failDefinition: false,
};
function publish(
  definition: Record<string, unknown>,
  publishedAt: Date
): CpRow {
  const contentHash = officialContentHash("renderer-bundle", definition);
  const row = {
    version: `h-${contentHash.slice(0, 12)}`,
    contentHash,
    definition,
    publishedAt,
    retired: false,
  };
  cp.rows.push(row);
  return row;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const fakeCp = vi.fn(async (input: string | URL) => {
  const url = new URL(String(input));
  cp.calls.push(url.pathname + url.search);
  if (cp.refuse) return json(403, { code: cp.refuse });
  const [slug, version] = url.pathname
    .replace("/internal/renderer-bundles/", "")
    .split("/")
    .map(decodeURIComponent);
  if (slug !== SLUG) return json(404, { error: "not found" });
  const row = version
    ? cp.rows.find((r) => r.version === version)
    : [...cp.rows]
        .filter((r) => !r.retired)
        .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0];
  if (!row) return json(404, { error: "not found" });
  if (url.searchParams.get("meta") === "1") {
    return json(200, {
      package: {
        slug,
        version: row.version,
        contentHash: row.contentHash,
        publishedAt: row.publishedAt.toISOString(),
        retired: row.retired,
      },
    });
  }
  if (cp.failDefinition) return json(500, { error: "boom" });
  return json(200, {
    package: { slug, version: row.version, definition: row.definition },
  });
});

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const installedVersion = async () =>
  (
    await q<{ version: string }>(
      `select version from renderer_bundles where slug = '${SLUG}'`
    )
  ).rows[0]?.version ?? null;
const keptVersions = async () =>
  (
    await q<{ version: string }>(
      `select version from renderer_bundle_versions order by version`
    )
  ).rows.map((r) => r.version);

const person = (): Context =>
  ({ db, authenticated: true, userId: "owner-1" }) as unknown as Context;
const agent = (): Context =>
  ({ ...person(), agentUserId: randomUUID() }) as unknown as Context;
const auto = { auto: true, channel: "stable" as const };
const waits = (latest: string, reason: string, extra = {}) => ({
  kind: "waits",
  latest,
  reason,
  ...extra,
});
const definitionReads = () => cp.calls.filter((c) => !c.includes("meta=1"));

beforeAll(async () => {
  const skip = new Set([
    "renderer_bundles",
    "renderer_host_modules",
    "renderer_bundle_versions",
    "renderer_bundle_updates",
  ]);
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const [name, t] of byName) {
    if (!skip.has(name)) await h.client!.exec(ddlFor(t));
  }
  await h.client!.exec(
    `CREATE UNIQUE INDEX widget_def_type_key_workspace_uniq ON widget_definitions (type_key, workspace_id);`
  );
  await h.client!.exec(migration("0436_renderer_bundles.sql"));
  await h.client!.exec(migration("0449_renderer_bundle_updates.sql"));
}, 120_000);

beforeEach(async () => {
  await h.client!.exec(
    `delete from renderer_host_modules; delete from renderer_bundles;
     delete from renderer_bundle_versions; delete from renderer_bundle_updates;
     delete from widget_definitions; delete from events;`
  );
  cp.rows = [];
  cp.refuse = null;
  cp.calls = [];
  h.owner = "owner-1";
  h.blocked = null;
  cp.failDefinition = false;
  h.marketInstalls = [];
  fakeCp.mockClear();
  vi.stubGlobal("fetch", fakeCp);
});

/** v1 installed by the first pass, v2 published `ageOfV2` before NOW. */
async function installedV1ThenV2(ageOfV2: number) {
  // Published before any v2 below, so v2 is the newest row.
  const v1 = publish(bundle(":root{}"), new Date(NOW.getTime() - 96 * HOUR));
  expect(await syncRendererBundleUpdates({ settings: auto, now: NOW })).toEqual(
    { kind: "installed", version: v1.version }
  );
  const v2 = publish(bundle(":root{--v:2}"), new Date(NOW.getTime() - ageOfV2));
  return { v1, v2 };
}

describe("the first pass", () => {
  it("a plan pod with no bundle installs it, with no receipt (nothing to undo)", async () => {
    const v1 = publish(bundle(":root{}"), NOW);
    const out = await syncRendererBundleUpdates({ settings: auto, now: NOW });
    expect(out).toEqual({ kind: "installed", version: v1.version });
    expect(await installedVersion()).toBe(v1.version);
    expect(await keptVersions()).toEqual([v1.version]);
    const row = await q<{ content_hash: string }>(
      `select content_hash from renderer_bundles`
    );
    expect(row.rows[0]!.content_hash).toBe(v1.contentHash);
    expect(await listPackageUpdateReceipts()).toEqual([]);
    // It asked the metadata first, then the definition at that version.
    expect(cp.calls).toEqual([
      `/internal/renderer-bundles/${SLUG}?meta=1`,
      `/internal/renderer-bundles/${SLUG}/${v1.version}`,
    ]);
  });

  it("installs even with automatic updates off (presence is not an update)", async () => {
    const v1 = publish(bundle(":root{}"), NOW);
    expect(
      await syncRendererBundleUpdates({
        settings: { auto: false, channel: "stable" },
        now: NOW,
      })
    ).toEqual({ kind: "installed", version: v1.version });
  });

  // Catches: a refusal that leaves the Renderers card saying nothing.
  it("a pod no plan covers: the refusal is recorded, nothing installed", async () => {
    publish(bundle(":root{}"), NOW);
    cp.refuse = "OFFICIAL_BUNDLE_PLAN_REQUIRED";
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual({ kind: "refused", reasonCode: "renderer_bundle_plan_required" });
    expect(await installedVersion()).toBeNull();
    const state = await readRendererBundleUpdateState();
    expect(state?.refusal?.reasonCode).toBe("renderer_bundle_plan_required");
    expect(state?.latestVersion).toBeNull();

    // A later pass that goes through clears it.
    cp.refuse = null;
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    expect((await readRendererBundleUpdateState())?.refusal).toBeNull();
  });

  it("another bundle holds the host set: the pass reads nothing", async () => {
    await h.client!.exec(
      `insert into renderer_bundles (slug, version, set_sha256, react_version, source, installed_by)
         values ('acme', '1', 's', '19', 'synap', 'u');
       insert into renderer_host_modules (bundle_slug, module, source, sha256, byte_length)
         values ('acme', 'react', 'x', 'y', 1);`
    );
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual({ kind: "other-bundle", holder: "acme" });
    expect(cp.calls).toEqual([]);
  });
});

describe("a newer version", () => {
  it("waits for its soak (stable 24 h from its publish), then applies on its own with a receipt", async () => {
    const { v1, v2 } = await installedV1ThenV2(2 * HOUR);
    const waiting = await syncRendererBundleUpdates({
      settings: auto,
      now: NOW,
    });
    expect(waiting).toEqual(
      waits(v2.version, "soak", {
        applyAfter: new Date(v2.publishedAt.getTime() + 24 * HOUR),
      })
    );
    expect(await installedVersion()).toBe(v1.version);
    expect(await readRendererBundleUpdateState()).toMatchObject({
      waitReason: "soak",
      applyAfter: new Date(v2.publishedAt.getTime() + 24 * HOUR).toISOString(),
    });

    const later = new Date(v2.publishedAt.getTime() + 24 * HOUR + 1);
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: later })
    ).toEqual({ kind: "updated", from: v1.version, to: v2.version });
    expect(await installedVersion()).toBe(v2.version);
    expect(await keptVersions()).toEqual([v1.version, v2.version].sort());
    const [receipt] = await listPackageUpdateReceipts();
    expect(receipt).toMatchObject({
      slug: SLUG,
      kind: "renderer-bundle",
      fromVersion: v1.version,
      toVersion: v2.version,
      source: "automatic",
      changes: [
        {
          rowKind: "renderer-bundle",
          rowId: SLUG,
          field: "version",
          before: v1.version,
          after: v2.version,
        },
      ],
    });
    expect(await readRendererBundleUpdateState()).toMatchObject({
      waitReason: null,
      applyAfter: null,
    });
  });

  it("the fast channel waits 1 h", async () => {
    const { v2 } = await installedV1ThenV2(90 * 60 * 1000);
    expect(
      await syncRendererBundleUpdates({
        settings: { auto: true, channel: "fast" },
        now: NOW,
      })
    ).toEqual({ kind: "updated", from: expect.any(String), to: v2.version });
  });

  it("automatic updates off, or unreadable: it waits for the person, and says which", async () => {
    const { v1, v2 } = await installedV1ThenV2(72 * HOUR);
    expect(
      await syncRendererBundleUpdates({
        settings: { auto: false, channel: "stable" },
        now: NOW,
      })
    ).toEqual(waits(v2.version, "auto_off"));
    expect((await readRendererBundleUpdateState())?.waitReason).toBe(
      "auto_off"
    );
    // An unreadable setting is not a yes, and not "off" either.
    expect(
      await syncRendererBundleUpdates({ settings: null, now: NOW })
    ).toEqual(waits(v2.version, "setting_unreadable"));
    expect(await installedVersion()).toBe(v1.version);
  });

  // Catches: the pass fetching (and the CP recording) while the catalog is frozen.
  it("a frozen catalog: it waits, and the definition is not fetched", async () => {
    const { v1, v2 } = await installedV1ThenV2(72 * HOUR);
    h.blocked = "Synap's catalog signature expired.";
    cp.calls = [];
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "frozen"));
    expect(definitionReads()).toEqual([]);
    expect(await installedVersion()).toBe(v1.version);
  });

  it("paused: it waits for the person; resumed, it applies; each is a person's act on the log", async () => {
    const { v2 } = await installedV1ThenV2(72 * HOUR);
    await expect(
      setRendererBundleUpdatesPaused(agent(), { slug: SLUG, paused: true })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const paused = await setRendererBundleUpdatesPaused(person(), {
      slug: SLUG,
      paused: true,
    });
    expect(paused?.pausedAt).not.toBeNull();
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "paused"));
    await setRendererBundleUpdatesPaused(person(), {
      slug: SLUG,
      paused: false,
    });
    const logged = await q<{ type: string; subject_id: string }>(
      `select type, subject_id from events where type like 'package.updates_%' order by timestamp`
    );
    expect(logged.rows).toEqual([
      { type: "package.updates_paused", subject_id: SLUG },
      { type: "package.updates_resumed", subject_id: SLUG },
    ]);
    expect(
      (await syncRendererBundleUpdates({ settings: auto, now: NOW })).kind
    ).toBe("updated");
  });

  // Synap retired the version this pod runs.
  it("a retired installed version converges without waiting", async () => {
    const { v1, v2 } = await installedV1ThenV2(5 * 60 * 1000);
    cp.rows.find((r) => r.version === v1.version)!.retired = true;
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual({ kind: "updated", from: v1.version, to: v2.version });
    expect(cp.calls).toContain(
      `/internal/renderer-bundles/${SLUG}/${v1.version}?meta=1`
    );
  });

  // Built for a newer pod.
  it("a version this pod cannot run is held for the owner, never installed", async () => {
    const v1 = publish(bundle(":root{}"), new Date(NOW.getTime() - 72 * HOUR));
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    const v2 = publish(
      bundle(":root{--v:2}", { bridgeOps: ["entities.get", "pods.teleport"] }),
      new Date(NOW.getTime() - 72 * HOUR + 1)
    );
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "held", { hold: "requires" }));
    expect(await installedVersion()).toBe(v1.version);
    const state = await readRendererBundleUpdateState();
    expect(state?.hold).toMatchObject({
      version: v2.version,
      reason: "requires",
    });
    expect(state?.hold?.detail).toContain("pods.teleport");

    // Held: the next pass does not fetch the definition again.
    cp.calls = [];
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "held", { hold: "requires" }));
    expect(definitionReads()).toEqual([]);

    // A person's apply is refused the same way, nothing written.
    const err = await applyPackageUpdate(person(), {
      slug: SLUG,
      expectedVersion: v2.version,
    }).catch((e: unknown) => e);
    expect((err as { cause?: { reasonCode?: string } }).cause?.reasonCode).toBe(
      RENDERER_BUNDLE_REQUIRES_UNMET
    );
    expect(await installedVersion()).toBe(v1.version);
  });
});

describe("holds that keep the pass from fetching again", () => {
  /** A person's own frame cell on the pod, importing `name` from the kit. */
  async function personCellImporting(name: string) {
    await q(
      `insert into widget_definitions (id, type_key, name, renderer_type, is_active, renderer_source)
       values (gen_random_uuid(), 'cell:mine:chart', 'Mine', 'frame', true, $1)`,
      [`import { ${name} } from "@synap/kit";\nexport default () => null;`]
    );
  }

  // Catches: a bundle dropping a kit export another cell imports, applied on its own.
  it("a version that drops a kit export another cell imports is held ('kit'); a person may apply it", async () => {
    const v1 = publish(bundle(":root{}"), new Date(NOW.getTime() - 96 * HOUR));
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    await personCellImporting("Card");
    const v2 = publish(
      bundle(":root{--v:2}", undefined, "Board"),
      new Date(NOW.getTime() - 72 * HOUR)
    );
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "held", { hold: "kit" }));
    expect(await installedVersion()).toBe(v1.version);
    expect((await readRendererBundleUpdateState())?.hold?.detail).toContain(
      "Card"
    );
    cp.calls = [];
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    expect(definitionReads()).toEqual([]);

    // The person's apply is their consent: it lands, and the hold goes.
    await applyPackageUpdate(person(), {
      slug: SLUG,
      expectedVersion: v2.version,
    });
    expect(await installedVersion()).toBe(v2.version);
    expect((await readRendererBundleUpdateState())?.hold).toBeNull();
  });

  it("a dropped kit export no other cell imports does not hold", async () => {
    publish(bundle(":root{}"), new Date(NOW.getTime() - 96 * HOUR));
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    await personCellImporting("Something");
    const v2 = publish(
      bundle(":root{--v:2}", undefined, "Board"),
      new Date(NOW.getTime() - 72 * HOUR)
    );
    expect(
      (await syncRendererBundleUpdates({ settings: auto, now: NOW })).kind
    ).toBe("updated");
    expect(await installedVersion()).toBe(v2.version);
  });

  // Catches: a failed apply refetching ~3 MB (and a CP delivery row) every pass.
  it("a failed apply on its own holds that version: not fetched again until a newer one", async () => {
    const { v1, v2 } = await installedV1ThenV2(72 * HOUR);
    cp.failDefinition = true;
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "held", { hold: "failed" }));
    expect(await installedVersion()).toBe(v1.version);
    cp.calls = [];
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    expect(definitionReads()).toEqual([]);

    cp.failDefinition = false;
    const v3 = publish(
      bundle(":root{--v:3}"),
      new Date(NOW.getTime() - 48 * HOUR)
    );
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual({ kind: "updated", from: v1.version, to: v3.version });
  });

  it("a refusal on an installed pod is recorded too, and says why the update waits", async () => {
    await installedV1ThenV2(72 * HOUR);
    cp.refuse = "OFFICIAL_BUNDLE_POD_NOT_LIVE";
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    expect(await readRendererBundleUpdateState()).toMatchObject({
      waitReason: "refused",
      refusal: { reasonCode: "renderer_bundle_pod_not_live" },
    });
  });
});

describe("the package-updates doors", () => {
  it("the standing lists the bundle with the one rule's verdict", async () => {
    const { v1, v2 } = await installedV1ThenV2(2 * HOUR);
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    const pkg = (await listInstalledPackages()).find(
      (p) => p.kind === "renderer-bundle"
    );
    expect(pkg).toMatchObject({
      slug: SLUG,
      name: "Synap renderers",
      installedVersion: v1.version,
      latestVersion: v2.version,
      hasUpdate: true,
    });
  });

  it("never read: 'can't check' with why, never 'up to date'", async () => {
    await h.client!.exec(
      `insert into renderer_bundles (slug, version, set_sha256, react_version, source, installed_by)
         values ('${SLUG}', 'h-0123456789ab', 's', '19', 'synap', 'u')`
    );
    const pkg = (await listInstalledPackages()).find(
      (p) => p.kind === "renderer-bundle"
    );
    expect(pkg?.hasUpdate).toBeNull();
    expect(pkg?.reason).toContain("not read");
  });

  it("a person applies it now (no soak) with a receipt; an agent's apply is filed through market.install", async () => {
    const { v1, v2 } = await installedV1ThenV2(5 * 60 * 1000);
    await syncRendererBundleUpdates({ settings: auto, now: NOW });

    const filed = await applyPackageUpdate(agent(), {
      slug: SLUG,
      expectedVersion: v2.version,
    });
    expect(filed).toEqual({
      status: "proposed",
      proposalIds: ["install-proposal-1"],
    });
    expect(h.marketInstalls[0]).toMatchObject({
      kind: "renderer-bundle",
      slug: SLUG,
      version: v2.version,
    });
    expect(await installedVersion()).toBe(v1.version);

    const applied = await applyPackageUpdate(person(), {
      slug: SLUG,
      expectedVersion: v2.version,
    });
    expect(applied.status).toBe("applied");
    expect(await installedVersion()).toBe(v2.version);
    const [receipt] = await listPackageUpdateReceipts();
    expect(receipt).toMatchObject({
      source: "person",
      fromVersion: v1.version,
      toVersion: v2.version,
    });
  });
});

describe("Undo", () => {
  async function updated() {
    const { v1, v2 } = await installedV1ThenV2(72 * HOUR);
    await syncRendererBundleUpdates({ settings: auto, now: NOW });
    expect(await installedVersion()).toBe(v2.version);
    const [receipt] = await listPackageUpdateReceipts();
    return { v1, v2, receipt: receipt! };
  }

  it("re-installs the version kept on the pod, without the control plane, and holds the undone one", async () => {
    const { v1, v2, receipt } = await updated();
    cp.calls = [];
    const out = await undoPackageUpdate(person(), receipt.id);
    expect(out.status).toBe("applied");
    expect(cp.calls).toEqual([]); // never fetched again
    expect(await installedVersion()).toBe(v1.version);
    // Both still kept: the update can be applied again by hand.
    expect(await keptVersions()).toEqual([v1.version, v2.version].sort());
    const [again] = await listPackageUpdateReceipts();
    expect(again!.undoneAt).not.toBeNull();

    // The undone version does not come back on its own…
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual(waits(v2.version, "held", { hold: "undone" }));
    expect(await installedVersion()).toBe(v1.version);
    // …a newer one does.
    const v3 = publish(
      bundle(":root{--v:3}"),
      new Date(NOW.getTime() - 48 * HOUR)
    );
    expect(
      await syncRendererBundleUpdates({ settings: auto, now: NOW })
    ).toEqual({ kind: "updated", from: v1.version, to: v3.version });
  });

  // Catches: a kept copy re-installed without its recorded digest.
  it("a kept copy that no longer matches its recorded digest is refused, nothing written", async () => {
    const { v1, v2, receipt } = await updated();
    await q(
      `update renderer_bundle_versions
          set definition = jsonb_set(definition, '{kitExports}', '["Card","Exfiltrate"]')
        where version = $1`,
      [v1.version]
    );
    const err = await undoPackageUpdate(person(), receipt.id).catch(
      (e: unknown) => e
    );
    expect((err as { code?: string }).code).toBe("PRECONDITION_FAILED");
    expect((err as Error).message).toContain("digest");
    expect(await installedVersion()).toBe(v2.version);
  });

  it("refused when the pod moved on since, and for an agent", async () => {
    const { receipt } = await updated();
    const byAgent = await undoPackageUpdate(agent(), receipt.id).catch(
      (e: unknown) => e
    );
    expect((byAgent as { code?: string }).code).toBe("FORBIDDEN");

    await q(`update renderer_bundles set version = 'h-ffffffffffff'`);
    const moved = await undoPackageUpdate(person(), receipt.id).catch(
      (e: unknown) => e
    );
    expect((moved as { code?: string }).code).toBe("CONFLICT");
  });
});
