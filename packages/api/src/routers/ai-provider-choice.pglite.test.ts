/**
 * `aiProviderChoice.*` + `GET /api/hub/ai-providers/choice` — the pod's choice
 * of who runs its AI (founder decision 2026-10-27), through the REAL router,
 * service and hub route on PGlite.
 *
 * Pinned:
 *   - a pod with no record reads `choice: null` (existing pods are never
 *     backfilled), and the IS's hub door says the same;
 *   - only a signed-in pod admin chooses: a member and an agent credential
 *     acting for the admin are refused, and NOTHING is recorded;
 *   - the record carries who, when, the wording version and the exact words
 *     of the chosen option; a stale wording version is refused (CONFLICT);
 *   - a change of mind is a new record, the previous one kept in `history`;
 *   - the IS's hub door returns the choice and no user id.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { OpenAPIHono } from "@hono/zod-openapi";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  admins: new Set<string>(),
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
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => null }));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { aiProviderChoiceRouter } from "./ai-provider-choice.js";
import { CURRENT_AI_PROVIDER_CHOICE_WORDING } from "../services/ai-provider-choice.js";
import { registerAiProvidersRoutes } from "./hub-protocol/rest/ai-providers.js";
import type { HubHono, HubVariables } from "./hub-protocol/rest/_shared.js";

const ADMIN = "human-admin";
const MEMBER = "human-member";
const AGENT = "agent-of-admin";
const VERSION = CURRENT_AI_PROVIDER_CHOICE_WORDING.version;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const caller = (userId: string, extra: Record<string, unknown> = {}) =>
  aiProviderChoiceRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
    ...extra,
  } as never);

function hub(scopes = ["hub-protocol.read"]): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", scopes);
    c.set("userId", "is-service");
    c.set("keyType", "is_internal");
    await next();
  });
  registerAiProvidersRoutes(app);
  return app;
}

async function storedChoice(): Promise<Record<string, unknown> | null> {
  const rows = await q<{ settings: Record<string, unknown> }>(
    `select settings from pod_settings`
  );
  return (
    (rows[0]?.settings?.aiProviderChoice as Record<string, unknown>) ?? null
  );
}

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  // An existing pod: settings of its own, no choice recorded.
  await q(`insert into pod_settings (settings) values ($1::jsonb)`, [
    JSON.stringify({ podApps: { allowUnverified: true } }),
  ]);
  h.admins.add(ADMIN);
}, 120_000);

describe("before anyone chooses", () => {
  it("reads null (no backfill) with the current wording, and the IS door agrees", async () => {
    const state = await caller(ADMIN).get();
    expect(state).toMatchObject({
      choice: null,
      decidedAt: null,
      wordingVersion: null,
      mayChoose: true,
      ownProviderReady: false,
    });
    expect(state.wording.options.deepseek.label).toBe(
      "Use DeepSeek (servers in China)"
    );
    const res = await hub().request("/ai-providers/choice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      choice: null,
      decidedAt: null,
      wordingVersion: null,
    });
  });

  it("a member may read but not choose", async () => {
    expect((await caller(MEMBER).get()).mayChoose).toBe(false);
    await expect(
      caller(MEMBER).choose({ choice: "deepseek", wordingVersion: VERSION })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await storedChoice()).toBeNull();
  });

  it("an agent credential acting for the admin cannot choose", async () => {
    const agent = caller(ADMIN, { agentUserId: AGENT, keyType: "agent" });
    expect((await agent.get()).mayChoose).toBe(false);
    await expect(
      agent.choose({ choice: "deepseek", wordingVersion: VERSION })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await storedChoice()).toBeNull();
  });

  it("a stale wording version is refused and records nothing", async () => {
    await expect(
      caller(ADMIN).choose({ choice: "deepseek", wordingVersion: "2020-01-01" })
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await storedChoice()).toBeNull();
  });

  it("the IS door needs the hub read scope", async () => {
    const res = await hub([]).request("/ai-providers/choice");
    expect(res.status).toBe(403);
  });
});

describe("a pod admin chooses", () => {
  it("records who, when, the version and the exact words shown", async () => {
    const before = Date.now();
    const state = await caller(ADMIN).choose({
      choice: "deepseek",
      wordingVersion: VERSION,
    });
    expect(state).toMatchObject({
      choice: "deepseek",
      decidedBy: ADMIN,
      wordingVersion: VERSION,
    });
    const stored = await storedChoice();
    expect(stored).toMatchObject({
      choice: "deepseek",
      decidedBy: ADMIN,
      wordingVersion: VERSION,
      history: [],
    });
    expect(Date.parse(String(stored!.decidedAt))).toBeGreaterThanOrEqual(
      before - 1000
    );
    expect(stored!.wording).toContain("Use DeepSeek (servers in China)");
    expect(stored!.wording).toContain("you consent to that transfer");
    // The pod's other settings are untouched by the merge.
    const rows = await q<{ settings: Record<string, unknown> }>(
      `select settings from pod_settings`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.settings.podApps).toEqual({ allowUnverified: true });
  });

  it("the IS door returns the choice and no user id", async () => {
    const body = await (await hub().request("/ai-providers/choice")).json();
    expect(body).toMatchObject({ choice: "deepseek", wordingVersion: VERSION });
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });

  it("a change of mind is a new record; the previous one stays in history", async () => {
    await caller(ADMIN).choose({
      choice: "own_provider",
      wordingVersion: VERSION,
    });
    const stored = await storedChoice();
    expect(stored).toMatchObject({ choice: "own_provider", decidedBy: ADMIN });
    expect(stored!.wording).toContain("Use my own provider");
    expect(stored!.history).toEqual([
      expect.objectContaining({ choice: "deepseek", decidedBy: ADMIN }),
    ]);
    const body = await (await hub().request("/ai-providers/choice")).json();
    expect(body.choice).toBe("own_provider");
  });

  it("says when the pod has a provider of its own", async () => {
    await q(
      `insert into ai_providers (provider_id, name, base_url, encrypted_api_key, enabled)
       values ('mistral', 'Mistral AI', 'https://api.mistral.ai/v1', 'enc', true)`
    );
    expect((await caller(MEMBER).get()).ownProviderReady).toBe(true);
  });
});
