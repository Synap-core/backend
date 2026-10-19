/**
 * `provisionInboundWebhook` on a real Postgres (PGlite): the real visibility
 * floor (`userVisibleWhere`), the real write gate (`assertWorkspaceWrite` →
 * `workspace_members`), the real row-locked merge. And the seam the door
 * exists for: a token it mints is the token the ROUTE accepts — every
 * `INBOUND_WEBHOOK_PROVIDERS` row is minted and then delivered to through the
 * real `webhooksInboundRouter`.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  audits: [] as unknown[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  // The routes redeem a signing secret after the token matches; a resolved
  // secret makes them answer the signature check (401), never the 404.
  mocked.resolveVaultSecret = async () => "signing-secret";
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../utils/audit-log.js", () => ({
  auditLog: vi.fn(async (opts: unknown) => {
    holder.audits.push(opts);
    return null;
  }),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import * as schema from "@synap/database/schema";
import { webhooksInboundRouter } from "../../routers/webhooks-inbound.js";
import {
  provisionInboundWebhook,
  provisionInstalledToolWebhooks,
} from "./provision-inbound-webhook.js";
import { INBOUND_WEBHOOK_PROVIDERS } from "./inbound-webhook-providers.js";

const OWNER = "owner-1";
const EDITOR = "editor-1";
const VIEWER = "viewer-1";
const STRANGER = "stranger-1";
const WS = "0aaaaaaa-0000-4000-8000-0000000000a1";
const ORIGIN = "https://pod.example.test";
const URL_RE = new RegExp(
  `^${ORIGIN.replace(/\./g, "\\.")}/api/webhooks/([a-z]+)/([A-Za-z0-9_-]{43})$`
);

/** CREATE TABLE from the drizzle definition (same shape as webhooks-postiz.pglite). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

let pg: PGlite;
let db: any;

const app = new Hono();
app.route("/api/webhooks", webhooksInboundRouter);

async function insertTool(values: {
  name: string;
  createdBy?: string;
  workspaceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const [t] = await db
    .insert(schema.tools)
    .values({
      createdBy: values.createdBy ?? OWNER,
      workspaceId: values.workspaceId ?? null,
      name: values.name,
      kind: "api",
      metadata: values.metadata ?? {},
    })
    .returning();
  return t.id as string;
}

async function metadataOf(id: string): Promise<Record<string, unknown>> {
  const r = await pg.query<{ metadata: Record<string, unknown> }>(
    `select metadata from tools where id = $1`,
    [id]
  );
  return r.rows[0]!.metadata;
}

function tokenOf(url: string): string {
  const m = URL_RE.exec(url);
  if (!m) throw new Error(`not a webhook URL: ${url}`);
  return m[2]!;
}

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.tools,
    schema.workspaces,
    schema.workspaceMembers,
    schema.projects,
    schema.projectMembers,
    schema.podMembers,
    schema.users,
    schema.entities,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  await pg.exec(
    `insert into users (id, email) values ('${OWNER}', 'o@x.test'), ('${EDITOR}', 'e@x.test'), ('${VIEWER}', 'v@x.test'), ('${STRANGER}', 's@x.test')`
  );
  db = drizzle(pg, { schema });
  holder.db = db;
  await db
    .insert(schema.workspaces)
    .values({ id: WS, name: "Content", ownerId: OWNER });
  await db.insert(schema.workspaceMembers).values([
    { workspaceId: WS, userId: OWNER, role: "owner" },
    { workspaceId: WS, userId: EDITOR, role: "editor" },
    { workspaceId: WS, userId: VIEWER, role: "viewer" },
  ]);
}, 120_000);
afterAll(async () => pg?.close());

beforeEach(() => {
  process.env.PUBLIC_URL = `${ORIGIN}/`;
  holder.audits.length = 0;
});

describe("provisionInboundWebhook", () => {
  it("mints a 32-byte url-safe token at the provider's URL, then returns the same one", async () => {
    const id = await insertTool({ name: "postiz" });
    const first = await provisionInboundWebhook({ userId: OWNER, toolId: id });
    expect(first.provider).toBe("postiz");
    expect(first.url).toMatch(URL_RE);
    expect(URL_RE.exec(first.url)![1]).toBe("postiz");
    expect(first.rotated).toBe(false);
    expect(first.missingConfig).toEqual([]);
    expect(first.setupStep).toMatch(/Settings → Webhooks/);
    expect(
      ((await metadataOf(id)).postiz as { webhook: { token: string } }).webhook
        .token
    ).toBe(tokenOf(first.url));

    const again = await provisionInboundWebhook({ userId: OWNER, toolId: id });
    expect(again.url).toBe(first.url);
    expect(again.rotated).toBe(false);
    // One write, one audit row — and the token is not in it.
    expect(holder.audits).toHaveLength(1);
    expect(JSON.stringify(holder.audits)).not.toContain(tokenOf(first.url));
  });

  it("rotate replaces the token; the old one is gone", async () => {
    const id = await insertTool({ name: "postiz" });
    const first = await provisionInboundWebhook({ userId: OWNER, toolId: id });
    const rotated = await provisionInboundWebhook({
      userId: OWNER,
      toolId: id,
      rotate: true,
    });
    expect(rotated.rotated).toBe(true);
    expect(tokenOf(rotated.url)).not.toBe(tokenOf(first.url));
    const res = await app.request(
      `/api/webhooks/postiz/${tokenOf(first.url)}`,
      { method: "POST", body: "[]" }
    );
    expect(res.status).toBe(404);
  });

  it("merges the token in: every other metadata key and webhook field survives", async () => {
    const id = await insertTool({
      name: "mailgun",
      metadata: {
        discord: { channel: "c1" },
        mailgun: {
          domain: "mg.example.test",
          webhook: { secretVaultRef: "vault://sig", seen: { a: "1" } },
        },
      },
    });
    const out = await provisionInboundWebhook({ userId: OWNER, toolId: id });
    expect(out.missingConfig).toEqual([]);
    expect(await metadataOf(id)).toEqual({
      discord: { channel: "c1" },
      mailgun: {
        domain: "mg.example.test",
        webhook: {
          secretVaultRef: "vault://sig",
          seen: { a: "1" },
          token: tokenOf(out.url),
        },
      },
    });
  });

  it("reports the config the route still needs instead of a URL that silently 404s", async () => {
    const id = await insertTool({ name: "cal_com" });
    const out = await provisionInboundWebhook({ userId: OWNER, toolId: id });
    expect(out.provider).toBe("calcom");
    expect(out.missingConfig).toEqual(["secretVaultRef"]);
  });

  it("refuses a pod-wide tool to anyone but its owner, and writes nothing", async () => {
    const id = await insertTool({ name: "postiz", createdBy: OWNER });
    await expect(
      provisionInboundWebhook({ userId: STRANGER, toolId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await metadataOf(id)).toEqual({});
  });

  it("a workspace tool: an editor may, a viewer may not, a non-member does not even see it", async () => {
    const id = await insertTool({ name: "postiz", workspaceId: WS });
    await expect(
      provisionInboundWebhook({ userId: VIEWER, toolId: id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      provisionInboundWebhook({ userId: STRANGER, toolId: id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await metadataOf(id)).toEqual({});
    const out = await provisionInboundWebhook({ userId: EDITOR, toolId: id });
    expect(out.url).toMatch(URL_RE);
  });

  it("refuses a tool no provider calls back, and a pod with no PUBLIC_URL", async () => {
    const plain = await insertTool({ name: "github" });
    await expect(
      provisionInboundWebhook({ userId: OWNER, toolId: plain })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    delete process.env.PUBLIC_URL;
    const id = await insertTool({ name: "postiz" });
    await expect(
      provisionInboundWebhook({ userId: OWNER, toolId: id })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(await metadataOf(id)).toEqual({});
  });
});

describe("provisionInstalledToolWebhooks (capability install)", () => {
  it("provisions each webhook tool, skips the others and the proposed ones, reports a refusal", async () => {
    const mine = await insertTool({ name: "postiz" });
    const theirs = await insertTool({ name: "fireflies", createdBy: STRANGER });
    const other = await insertTool({ name: "github" });
    const out = await provisionInstalledToolWebhooks(
      [
        { name: "postiz", toolId: mine },
        { name: "fireflies", toolId: theirs },
        { name: "github", toolId: other },
        { name: "mailgun", toolId: null },
      ],
      OWNER
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      tool: "postiz",
      toolId: mine,
      provider: "postiz",
    });
    expect((out[0] as { url: string }).url).toMatch(URL_RE);
    expect(out[1]).toMatchObject({
      tool: "fireflies",
      toolId: theirs,
      provider: "fireflies",
      error: expect.stringMatching(/owner/i),
    });
  });
});

describe("every provider row: the token the door mints is the token its route accepts", () => {
  const providers = Object.entries(INBOUND_WEBHOOK_PROVIDERS);

  it("non-vacuous: the table has the four known providers", () => {
    expect(providers.map(([p]) => p).sort()).toEqual(
      expect.arrayContaining(["calcom", "fireflies", "mailgun", "postiz"])
    );
  });

  it.each(providers)("%s", async (provider, spec) => {
    const id = await insertTool({
      name: spec.toolName,
      // Give the route every key it requires, so only the token decides.
      metadata: {
        [spec.metadataKey]: { webhook: { secretVaultRef: "vault://sig" } },
      },
    });
    const out = await provisionInboundWebhook({ userId: OWNER, toolId: id });
    expect(URL_RE.exec(out.url)![1]).toBe(provider);

    const deliver = (token: string) =>
      app.request(`/api/webhooks/${provider}/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    expect((await deliver("not-the-token")).status).toBe(404);
    const res = await deliver(tokenOf(out.url));
    expect(res.status).not.toBe(404);
  });
});
