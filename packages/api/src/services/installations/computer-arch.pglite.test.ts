/**
 * "Install it on my Mac" (founder's dogfood, 2026-11-09, build df644e0b):
 *
 *   1. `computer: "Mac"` answered COMPUTER_NOT_FOUND although the person had
 *      exactly one macOS computer, `MacBook-Pro-de-Antoine.local`;
 *   2. every computer read `arch: null`, so a capability built for one
 *      processor (mlx-whisper: Apple silicon only) could never be refused on
 *      another: nothing ever wrote the computer's processor.
 *
 * On PGlite through the real doors: the runner's lease route (Hub REST
 * `POST /host-jobs/lease`, which now carries `os` and `arch`), the roster
 * (`listMachines`), `market.search` and MCP `synap_request_installation`. The
 * catalog row is Synap's media-ffmpeg definition narrowed to Apple silicon on
 * a Mac. Stubbed: the catalog signature check (network; official-catalog-trust
 * tests pin it).
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

vi.mock("../capabilities/official-catalog-trust.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assertOfficialDefinition: async () => {} };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { officialCatalogUrl } from "@synap/jobs/workers/cp-catalog-sync.js";
import { registerHostJobsRoutes } from "../../routers/hub-protocol/rest/host-jobs.js";
import type {
  HubHono,
  HubVariables,
} from "../../routers/hub-protocol/rest/_shared.js";
import { installationHandlers } from "../../routers/mcp/handlers/installations.js";
import { BUILTIN_VERBS } from "../capabilities/builtin-verbs.js";
import { listMachines } from "../machine-roster.js";
import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";

const here = dirname(fileURLToPath(import.meta.url));
const FFMPEG = JSON.parse(
  readFileSync(
    resolve(here, "__fixtures__/media-ffmpeg.0.35.0.definition.json"),
    "utf8"
  )
) as Record<string, unknown>;
/** media-ffmpeg narrowed as mlx-whisper is: on a Mac, Apple silicon only. */
const ARM_ONLY_ON_MAC = {
  ...FFMPEG,
  placement: {
    ...(FFMPEG.placement as Record<string, unknown>),
    platforms: [
      { os: "darwin", arch: ["arm64"] },
      { os: "linux", arch: ["x64", "arm64"] },
    ],
  },
};

const PERSON = randomUUID();
const MAC = randomUUID();
const DEVBOX = randomUUID();
const HERMES = randomUUID();
const AGENT = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  // As the device flow left them: a system, no processor.
  const meta = (platform: string, hostsServices: boolean) =>
    JSON.stringify({ platform, hostsServices });
  await q(
    `INSERT INTO users (id, email, name, user_type, agent_type, created_by_user_id, host_user_id, agent_metadata) VALUES
      ($1, 'a@x', 'person', 'human', NULL, NULL, NULL, '{}'::jsonb),
      ($2, 'm@x', 'MacBook-Pro-de-Antoine.local', 'agent', 'machine', $1, NULL, $6::jsonb),
      ($3, 'd@x', 'devbox', 'agent', 'machine', $1, NULL, $7::jsonb),
      ($4, 'h@x', 'hermes', 'agent', 'machine', $1, NULL, $7::jsonb),
      ($5, 'c@x', 'Claude Code', 'agent', 'claude-code', $1, $2, '{}'::jsonb)`,
    [
      PERSON,
      MAC,
      DEVBOX,
      HERMES,
      AGENT,
      meta("darwin", false),
      meta("linux", true),
    ]
  );
  await q(
    `INSERT INTO cp_catalog_cache (source, kind, slug, name, description, version, definition)
     VALUES ($1, 'capability', 'media-ffmpeg', $2, $3, '0.35.0', $4::jsonb)`,
    [
      officialCatalogUrl(),
      ARM_ONLY_ON_MAC.name,
      ARM_ONLY_ON_MAC.description,
      JSON.stringify(ARM_ONLY_ON_MAC),
    ]
  );
}, 60_000);

async function asAgent(args: Record<string, unknown>) {
  const res = await installationHandlers.synap_request_installation!({
    toolName: "synap_request_installation",
    args: { capabilityKey: "media-ffmpeg", ...args },
    userId: PERSON,
    agentUserId: AGENT,
    apiKeyScopes: ["mcp.read", "mcp.write"],
  } as never);
  return JSON.parse((res.content[0] as { text: string }).text) as Record<
    string,
    unknown
  >;
}

async function searchMac() {
  const out = (await BUILTIN_VERBS["market.search"]!(
    { query: "ffmpeg", kind: "capability" },
    { userId: PERSON, workspaceId: null, agentUserId: AGENT }
  )) as { entries: Array<Record<string, unknown>> };
  const entry = out.entries.find((e) => e.slug === "media-ffmpeg")!;
  return (entry.computers as Array<Record<string, unknown>>).find(
    (c) => c.id === MAC
  )!;
}

/** The Mac's own runner key, as `hubAuthMiddleware` sets it. */
function macRunner(): HubHono {
  const app = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "hub-protocol.write", "host.runner"]);
    c.set("userId", PERSON);
    c.set("agentUserId", MAC);
    await next();
  });
  registerHostJobsRoutes(app);
  return app;
}

describe('"Mac" is the person\'s one macOS computer', () => {
  it("the founder's exact call finds it: the answer is about the computer, not its name", async () => {
    const out = await asAgent({ computer: "Mac" });
    expect(out.code, JSON.stringify(out)).not.toBe("COMPUTER_NOT_FOUND");
    expect(out).toMatchObject({
      status: "refused",
      code: "CANNOT_INSTALL",
      reason: "INSTALLS_FROM_POD_OFF",
    });
    expect(out.error).toMatch(/MacBook-Pro-de-Antoine\.local/);
  });

  it("the CLI's name for it (no .local) finds it too", async () => {
    const out = await asAgent({ computer: "MacBook-Pro-de-Antoine" });
    expect(out).toMatchObject({ reason: "INSTALLS_FROM_POD_OFF" });
  });

  it('"linux" fits two computers: refused with both as candidates, and all of them', async () => {
    const out = await asAgent({ computer: "linux" });
    expect(out).toMatchObject({
      status: "refused",
      code: "COMPUTER_AMBIGUOUS",
    });
    expect(
      (out.candidates as Array<{ name: string }>).map((c) => c.name)
    ).toEqual(["devbox", "hermes"]);
    expect((out.computers as unknown[]).length).toBe(3);
  });

  it("a computer the person does not have: not found, with all of them", async () => {
    const out = await asAgent({ computer: "Laptop" });
    expect(out).toMatchObject({ code: "COMPUTER_NOT_FOUND" });
    expect((out.computers as unknown[]).length).toBe(3);
  });
});

describe("the processor: reported by the runner, read by the roster and market.search", () => {
  it("before any report it is unknown: allowed, and the why says so", async () => {
    await q(
      `UPDATE users SET agent_metadata = agent_metadata || '{"hostsServices": true}'::jsonb WHERE id = $1`,
      [MAC]
    );
    const mac = await searchMac();
    expect(mac).toMatchObject({ arch: null, canInstall: true });
    expect(mac.why).toMatch(/processor is not known yet/);
  });

  it("the runner's lease carries it; the roster reads it", async () => {
    const res = await macRunner().request("/host-jobs/lease", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ os: "darwin", arch: "x64" }),
    });
    expect(res.status).toBe(200);
    const roster = await listMachines(PERSON);
    expect(roster.find((m) => m.id === MAC)).toMatchObject({
      platform: "darwin",
      arch: "x64",
    });
  });

  it("market.search: an Intel Mac cannot take an Apple-silicon-only tool", async () => {
    const mac = await searchMac();
    expect(mac).toMatchObject({ arch: "x64", canInstall: false });
    expect(mac.why).toMatch(/processor \(x64\)/);
  });

  it("asked anyway, the processor check refuses it", async () => {
    const out = await asAgent({ computer: "mac" });
    expect(out).toMatchObject({
      status: "refused",
      code: "CANNOT_INSTALL",
      reason: "UNSUPPORTED_COMPUTER",
    });
    expect(out.error).toMatch(/processor \(x64\)/);
  });
});
