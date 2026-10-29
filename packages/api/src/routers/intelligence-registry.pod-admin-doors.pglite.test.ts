/**
 * Every door that WRITES an `intelligence_services` row is pod-admin only
 * (audit 2026-10-28, pod-routers F4).
 *
 * WHY: the row is pod-wide. Its `webhookUrl` receives chat turns with the
 * stored key and a per-turn delegation token for the person whose turn it is,
 * and hub auth accepts that token whenever its audience is the origin of an
 * active row. `register` / `update` / `setDefault` / `unregister` / `rotateKey`
 * used to read no `ctx` at all, so any invited member could point the pod
 * default at their own server. `approveMcp` let a space editor flip a pod-wide
 * flag, and `intelligence.registerCustomService` let any space owner add an
 * origin hub auth then trusts.
 *
 * The non-admin here is the OWNER of a space: owning a space is exactly what
 * `workspaces.create` gives any member, so it must not be enough.
 *
 * Driven through the REAL procedures → the REAL `isPodAdmin` (a pod-admin
 * system workspace + membership on PGlite) → SQL. Stubbed: the db handle, the
 * split-brain read-only probe, and `fetch` (registerCustomService probes the
 * service before inserting).
 *
 * What this CANNOT see: the device-session step-up on register / update /
 * rotateKey / registerCustomService (the callers here are session callers,
 * which pass it; `credential-doors-refuse-device-session` covers the predicate).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  vi,
  afterEach,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";

process.env.SYNAP_FIELD_KEYS = `t1:${randomBytes(32).toString("base64")}`;

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  publicFetch: vi.fn(
    async (..._args: unknown[]): Promise<Response> =>
      new Response(JSON.stringify({ capabilities: ["chat"] }), { status: 200 })
  ),
}));

vi.mock("@synap/shared-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safePublicFetch: h.publicFetch,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    eventRepository: { append: async () => undefined },
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  workspaces,
  workspaceMembers,
  intelligenceServices,
  syncGeneration,
} from "@synap/database/schema";
import { resolveServiceKey } from "@synap/database";
import { intelligenceRegistryRouter } from "./intelligence-registry.js";
import { intelligenceRouter } from "./intelligence.js";

const WS = randomUUID();
const POD_ADMIN_WS = randomUUID();
const SPACE_OWNER = "space-owner-1";
const ADMIN = "pod-admin-1";
const SVC_ROW = "svc-row-1";
const GOOD_URL = "https://is.synap.example";
const EVIL_URL = "https://evil.example";

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

const ctxFor = (userId: string) =>
  ({
    db: h.db,
    authenticated: true,
    userId,
    workspaceId: WS,
  }) as never;
const registry = (userId: string) =>
  intelligenceRegistryRouter.createCaller(ctxFor(userId));
const intelligence = (userId: string) =>
  intelligenceRouter.createCaller(ctxFor(userId));

type Row = {
  id: string;
  service_id: string;
  webhook_url: string;
  api_key: string;
  status: string;
  is_default: boolean | null;
  mcp_approved: boolean | null;
};
async function rows(): Promise<Row[]> {
  return (
    await h.client!.query<Row>(
      `select id, service_id, webhook_url, api_key, status, is_default, mcp_approved
         from intelligence_services order by service_id`
    )
  ).rows;
}

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    intelligenceServices,
    syncGeneration,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Builder', $2, '{}'::jsonb, now(), now())`,
    [WS, SPACE_OWNER]
  );
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, system_slug, created_at, updated_at)
     values ($1, 'Pod admin', $2, '{}'::jsonb, 'pod-admin', now(), now())`,
    [POD_ADMIN_WS, ADMIN]
  );
  for (const [ws, user, role] of [
    [WS, SPACE_OWNER, "owner"],
    [WS, ADMIN, "admin"],
    [POD_ADMIN_WS, ADMIN, "owner"],
  ])
    await h.client!.query(
      `insert into workspace_members (id, workspace_id, user_id, role)
       values ($1, $2, $3, $4)`,
      [randomUUID(), ws, user, role]
    );
});

// `fetchSpy` is the pinned door the probes go through (`safePublicFetch`,
// mocked above); a raw `fetch` must never be reached.
const fetchSpy = h.publicFetch;
const rawFetchSpy = vi.fn(async () => {
  throw new Error("a probe reached a raw fetch");
});

beforeEach(async () => {
  await h.client!.exec(`delete from intelligence_services;`);
  await h.client!.query(
    `insert into intelligence_services
       (id, service_id, name, webhook_url, api_key, capabilities, status, enabled,
        is_default, mcp_endpoint, mcp_approved, created_at, updated_at)
     values ($1, 'svc-house', 'House', $2, 'stored-key', '["chat"]'::jsonb, 'active', true,
        true, 'https://is.synap.example/mcp', false, now(), now())`,
    [SVC_ROW, GOOD_URL]
  );
  await h.client!.query(
    `insert into intelligence_services
       (id, service_id, name, webhook_url, api_key, capabilities, status, enabled,
        is_default, created_at, updated_at)
     values ('svc-row-2', 'svc-other', 'Other', $1, 'other-key', '["chat"]'::jsonb, 'active', true,
        false, now(), now())`,
    [GOOD_URL]
  );
  fetchSpy.mockClear();
  rawFetchSpy.mockClear();
  vi.stubGlobal("fetch", rawFetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("intelligenceRegistry writes — a space owner who is not a pod admin is refused", () => {
  it("register does not add a row", async () => {
    await expect(
      registry(SPACE_OWNER).register({
        serviceId: "svc-evil",
        name: "Evil",
        webhookUrl: EVIL_URL,
        apiKey: "k",
        capabilities: ["chat"],
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rows()).map((r) => r.service_id)).toEqual([
      "svc-house",
      "svc-other",
    ]);
  });

  it("update cannot move the default's webhookUrl", async () => {
    await expect(
      registry(SPACE_OWNER).update({ id: SVC_ROW, webhookUrl: EVIL_URL })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rows())[0]!.webhook_url).toBe(GOOD_URL);
  });

  it("setDefault does not move the pod default", async () => {
    await expect(
      registry(SPACE_OWNER).setDefault({ serviceId: "svc-other" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [house, other] = await rows();
    expect(house!.is_default).toBe(true);
    expect(other!.is_default).toBe(false);
  });

  it("unregister does not delete the service", async () => {
    await expect(
      registry(SPACE_OWNER).unregister({ id: SVC_ROW })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await rows()).toHaveLength(2);
  });

  it("rotateKey does not replace the stored key", async () => {
    await expect(
      registry(SPACE_OWNER).rotateKey({ id: SVC_ROW, newApiKey: "attacker" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rows())[0]!.api_key).toBe("stored-key");
  });

  it("approveMcp does not flip the pod-wide flag", async () => {
    await expect(
      registry(SPACE_OWNER).approveMcp({ serviceId: "svc-house" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await rows())[0]!.mcp_approved).toBe(false);
  });

  it("intelligence.registerCustomService adds no origin and never probes the URL", async () => {
    await expect(
      intelligence(SPACE_OWNER).registerCustomService({
        displayName: "Mine",
        hubUrl: EVIL_URL,
        apiKey: "k",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(2);
  });
});

describe("intelligenceRegistry writes — a pod admin still can", () => {
  it("update moves the webhookUrl and setDefault moves the default", async () => {
    await registry(ADMIN).update({
      id: SVC_ROW,
      webhookUrl: "https://is2.synap.example",
    });
    await registry(ADMIN).setDefault({ serviceId: "svc-other" });
    const [house, other] = await rows();
    expect(house!.webhook_url).toBe("https://is2.synap.example");
    expect(house!.is_default).toBe(false);
    expect(other!.is_default).toBe(true);
  });

  it("registerCustomService stores the key enveloped, never in plaintext", async () => {
    const res = await intelligence(ADMIN).registerCustomService({
      displayName: "Mine",
      hubUrl: "https://custom.synap.example",
      apiKey: "plain-secret",
    });
    const row = (await rows()).find((r) => r.service_id === res.serviceId)!;
    expect(row.api_key).not.toContain("plain-secret");
    expect(
      resolveServiceKey(row.api_key, {
        column: "intelligence_services.api_key",
        rowId: row.id,
      })
    ).toBe("plain-secret");
  });
});

/*
 * The URL a pod admin stores is fetched downstream with no further check
 * (~40 sites trust `webhookUrl`), so the writer refuses what the SSRF guard
 * refuses, as the Hub Protocol `services.register` door does. And the two
 * custom-service doors fetch a caller-chosen URL from inside the pod: guard
 * first, then the pinned `safePublicFetch` (no redirect followed, the key is
 * a header; a public name resolving to a private address is refused).
 */
describe("service URLs — the SSRF guard holds at every writer and probe", () => {
  it("register refuses a cloud metadata webhookUrl and adds no row", async () => {
    await expect(
      registry(ADMIN).register({
        serviceId: "svc-meta",
        name: "Meta",
        webhookUrl: "http://169.254.169.254/latest",
        apiKey: "k",
        capabilities: ["chat"],
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await rows()).toHaveLength(2);
  });

  it("update refuses a loopback webhookUrl and keeps the old one", async () => {
    await expect(
      registry(ADMIN).update({
        id: SVC_ROW,
        webhookUrl: "http://localhost:5432",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect((await rows())[0]!.webhook_url).toBe(GOOD_URL);
  });

  it("registerCustomService refuses a private hubUrl before probing it", async () => {
    await expect(
      intelligence(ADMIN).registerCustomService({
        displayName: "Inside",
        hubUrl: "http://10.0.0.5:8080",
        apiKey: "k",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(2);
  });

  it("registerCustomService probes through the pinned door, no redirect followed (the key is a header)", async () => {
    // The door answers a redirect at maxRedirects 0 with its typed refusal
    // (pinned-fetch.test.ts drives that on a real socket). Here: the probe
    // goes through it, asks for no redirect, and its refusal stores nothing.
    fetchSpy.mockImplementationOnce((async (
      _url: string,
      _init: unknown,
      maxRedirects?: number
    ) => {
      if ((maxRedirects ?? 0) === 0) {
        const { BlockedOutboundError } = await import("@synap/shared-utils");
        throw new BlockedOutboundError("too many redirects");
      }
      return new Response(JSON.stringify({ capabilities: ["chat"] }), {
        status: 200,
      });
    }) as never);
    await expect(
      intelligence(ADMIN).registerCustomService({
        displayName: "Bounce",
        hubUrl: "https://bounce.synap.example",
        apiKey: "k",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]).toEqual([
      "https://bounce.synap.example/api/capabilities",
      expect.objectContaining({
        headers: { Authorization: "Bearer k" },
      }),
      0,
      { allowedPorts: "any" },
    ]);
    expect(rawFetchSpy).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(2);
  });

  it("testCustomServiceConnection: a space owner is refused and nothing is fetched", async () => {
    await expect(
      intelligence(SPACE_OWNER).testCustomServiceConnection({
        hubUrl: GOOD_URL,
        apiKey: "k",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("testCustomServiceConnection: a pod admin cannot probe an internal host", async () => {
    await expect(
      intelligence(ADMIN).testCustomServiceConnection({
        hubUrl: "http://169.254.169.254",
        apiKey: "k",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("testCustomServiceConnection: a pod admin still tests a public service", async () => {
    const res = await intelligence(ADMIN).testCustomServiceConnection({
      hubUrl: GOOD_URL,
      apiKey: "k",
    });
    expect(res).toMatchObject({ ok: true, capabilities: ["chat"] });
  });
});
