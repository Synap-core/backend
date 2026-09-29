/**
 * `describeServingIntelligence` — the service that ACTUALLY serves, as the
 * status surfaces (`/api/provision/status`, `/diagnose-intelligence`) name it.
 *
 * Both routes used to read `workspaces.findFirst().settings.intelligenceServiceId`
 * — whichever space came first — so a pod whose first space carried no pin
 * described the env fallback (`source: env`, `intelligenceService: null`) while
 * `intelligenceRegistry.list` marked a registered row `isDefault` and routing
 * sent traffic to it. The description must be a projection of the SAME ladder
 * routing walks (`selectIntelligenceService`).
 *
 * Driven through the REAL `describeServingIntelligence` → REAL
 * `selectIntelligenceService` / `selectPodDefaultService` → SQL on PGlite.
 * Stubbed: only the db handle.
 *
 * NOT covered: user-preference (step 2) and capability-first (step 0) rungs —
 * the routes pass no user or capability, so those rungs are unreachable from
 * them; and PGlite has no FKs/enums/one-default partial index.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { workspaces, intelligenceServices } from "@synap/database/schema";
import { describeServingIntelligence } from "@synap/intelligence-client";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

async function addService(
  serviceId: string,
  url: string,
  opts: { isDefault?: boolean; status?: string } = {}
) {
  await h.client!.query(
    `insert into intelligence_services
       (id, service_id, name, webhook_url, api_key, capabilities, status, enabled,
        is_default, created_at, updated_at)
     values ($1, $2, $2, $3, 'real-key', '["chat"]'::jsonb, $4, true, $5, now(), now())`,
    [
      randomUUID(),
      serviceId,
      url,
      opts.status ?? "active",
      opts.isDefault ?? false,
    ]
  );
}

async function addWorkspace(settings: Record<string, unknown>) {
  const id = randomUUID();
  await h.client!.query(
    `insert into workspaces (id, name, settings, created_at, updated_at)
     values ($1, $2, $3::jsonb, now(), now())`,
    [id, `ws-${id.slice(0, 4)}`, JSON.stringify(settings)]
  );
  return id;
}

const ENV_KEY = "INTELLIGENCE_HUB_URL";
let savedEnv: string | undefined;

beforeAll(async () => {
  await h.client!.exec(ddlFor(workspaces));
  await h.client!.exec(ddlFor(intelligenceServices));
});
beforeEach(async () => {
  await h.client!.exec(
    "delete from intelligence_services; delete from workspaces;"
  );
  savedEnv = process.env[ENV_KEY];
  process.env[ENV_KEY] = "http://env-is:3001";
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
});

describe("describeServingIntelligence", () => {
  it("no registered row qualifies → the ENV service, named as such", async () => {
    await addWorkspace({});
    const s = await describeServingIntelligence();
    expect(s.source).toBe("env");
    expect(s.via).toBe("env");
    expect(s.url).toBe("http://env-is:3001");
    expect(s.service).toBeNull();
  });

  it("names the POD DEFAULT even when the first space carries no pin (the live bug)", async () => {
    await addWorkspace({}); // the space a findFirst() would read: no pin
    await addService("hub", "http://registered-is:3001", { isDefault: true });
    const s = await describeServingIntelligence();
    expect(s.source).toBe("registered");
    expect(s.via).toBe("pod_default");
    expect(s.service?.serviceId).toBe("hub");
    expect(s.url).toBe("http://registered-is:3001");
  });

  it("honours a workspaceId: that space's pinned service wins over the pod default", async () => {
    await addService("hub", "http://registered-is:3001", { isDefault: true });
    await addService("other", "http://other-is:3001");
    const ws = await addWorkspace({ intelligenceServiceId: "other" });

    const lensed = await describeServingIntelligence({ workspaceId: ws });
    expect(lensed.via).toBe("workspace");
    expect(lensed.service?.serviceId).toBe("other");
    expect(lensed.url).toBe("http://other-is:3001");

    // Unlensed → the pod default, NOT the pinned space's service.
    const podLevel = await describeServingIntelligence();
    expect(podLevel.service?.serviceId).toBe("hub");
  });

  it("a space pinned to an unusable service falls through to the pod default, like routing", async () => {
    await addService("hub", "http://registered-is:3001", { isDefault: true });
    await addService("dead", "http://dead-is:3001", { status: "suspended" });
    const ws = await addWorkspace({ intelligenceServiceId: "dead" });
    const s = await describeServingIntelligence({ workspaceId: ws });
    expect(s.via).toBe("pod_default");
    expect(s.service?.serviceId).toBe("hub");
  });
});
