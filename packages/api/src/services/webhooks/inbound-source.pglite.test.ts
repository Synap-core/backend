/**
 * Inbound webhook sources (0362) on a real `webhook_subscriptions` table
 * (PGlite, with the migration's own CHECK and unique index):
 *   - a source is an `inbound` row with no url and no event types; its secret
 *     comes back ONCE (create, replace), never from a list;
 *   - one source per (space, name): a second create is a 409;
 *   - an automation's DECLARED source (`triggerConfig.webhookSource.name`)
 *     binds to the space's source of that name when it exists, and NEVER
 *     creates one (a source is a person's credential);
 *   - a person creating the source binds every automation of the space that
 *     declared its name (unbound, or bound to a deleted twin) — and nothing
 *     in another space or on another trigger type.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

vi.setConfig({ testTimeout: 120_000 });

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client, { schema }) };
});

import {
  bindDeclaredWebhookSource,
  createInboundWebhookSource,
  listInboundWebhookSources,
  rotateInboundWebhookSecret,
} from "./inbound-source.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const M0362 = readFileSync(
  resolve(
    HERE,
    "../../../../database/migrations/0362_webhook_subscriptions_direction.sql"
  ),
  "utf8"
);

const WS1 = "00000000-0000-4000-8000-0000000000a1";
const WS2 = "00000000-0000-4000-8000-0000000000a2";

beforeAll(async () => {
  process.env.PUBLIC_URL = "https://pod.example.test/";
  await h.client!.exec(`
    CREATE TABLE "webhook_subscriptions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "user_id" text NOT NULL,
      "name" text NOT NULL,
      "url" text NOT NULL,
      "event_types" text[] NOT NULL,
      "secret" text NOT NULL,
      "active" boolean NOT NULL DEFAULT true,
      "retry_config" jsonb DEFAULT '{"maxRetries":3}',
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "last_triggered_at" timestamp with time zone,
      "workspace_id" uuid,
      "api_key_id" uuid
    );`);
  await h.client!.exec(M0362);
  // What a created source binds (only the columns the bind reads and writes).
  await h.client!.exec(`
    CREATE TABLE "automations" (
      "id" uuid PRIMARY KEY,
      "workspace_id" uuid,
      "trigger_type" text NOT NULL,
      "trigger_config" jsonb NOT NULL DEFAULT '{}',
      "version" integer NOT NULL DEFAULT 1,
      "updated_at" timestamp with time zone
    );`);
});

const row = async (id: string) =>
  (
    await h.client!.query<{
      direction: string;
      url: string | null;
      event_types: string[];
      secret: string;
      user_id: string;
    }>(
      `SELECT direction, url, event_types, secret, user_id FROM webhook_subscriptions WHERE id = $1`,
      [id]
    )
  ).rows[0]!;

describe("inbound webhook sources", () => {
  it("creates an inbound row with no url; the secret comes back once, the list never carries it", async () => {
    const { source, secret } = await createInboundWebhookSource({
      userId: "u-1",
      workspaceId: WS1,
      name: "  GitHub ",
    });
    expect(source).toMatchObject({
      name: "GitHub",
      workspaceId: WS1,
      active: true,
      inboundPath: `/api/webhooks/inbound/${source.id}`,
      inboundUrl: `https://pod.example.test/api/webhooks/inbound/${source.id}`,
    });
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(await row(source.id)).toEqual({
      direction: "inbound",
      url: null,
      event_types: [],
      secret,
      user_id: "u-1",
    });
    const listed = await listInboundWebhookSources(WS1);
    expect(listed.map((s) => s.id)).toContain(source.id);
    expect(JSON.stringify(listed)).not.toContain(secret);
  });

  it("a second source with the same name in the space is a 409", async () => {
    await expect(
      createInboundWebhookSource({
        userId: "u-1",
        workspaceId: WS1,
        name: "github",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replacing the secret returns a new one once; another space cannot reach the row", async () => {
    const [source] = await listInboundWebhookSources(WS1);
    const before = (await row(source!.id)).secret;
    await expect(
      rotateInboundWebhookSecret({ id: source!.id, workspaceId: WS2 })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await row(source!.id)).secret).toBe(before);
    const { secret } = await rotateInboundWebhookSecret({
      id: source!.id,
      workspaceId: WS1,
    });
    expect(secret).not.toBe(before);
    expect((await row(source!.id)).secret).toBe(secret);
  });
});

const autoRow = async (id: string) =>
  (
    await h.client!.query<{
      trigger_config: Record<string, unknown>;
      version: number;
    }>(`SELECT trigger_config, version FROM automations WHERE id = $1`, [id])
  ).rows[0]!;

describe("an automation's declared source", () => {
  const A = {
    unbound: "00000000-0000-4000-8000-0000000000b1",
    stale: "00000000-0000-4000-8000-0000000000b2",
    otherSpace: "00000000-0000-4000-8000-0000000000b3",
    otherTrigger: "00000000-0000-4000-8000-0000000000b4",
    otherName: "00000000-0000-4000-8000-0000000000b5",
  };

  beforeAll(async () => {
    for (const [id, ws, type, config] of [
      [A.unbound, WS2, "webhook", { webhookSource: { name: "CI" } }],
      [
        A.stale,
        WS2,
        "webhook",
        {
          webhookSource: { name: "ci" },
          webhookSubscriptionId: "00000000-0000-4000-8000-00000000dead",
        },
      ],
      [A.otherSpace, WS1, "webhook", { webhookSource: { name: "CI" } }],
      [A.otherTrigger, WS2, "event", { webhookSource: { name: "CI" } }],
      [A.otherName, WS2, "webhook", { webhookSource: { name: "Forms" } }],
    ] as const) {
      await h.client!.query(
        `INSERT INTO automations (id, workspace_id, trigger_type, trigger_config) VALUES ($1,$2,$3,$4::jsonb)`,
        [id, ws, type, JSON.stringify(config)]
      );
    }
  });

  const declare = (name: unknown, over: Record<string, unknown> = {}) =>
    bindDeclaredWebhookSource({
      workspaceId: WS2,
      triggerType: "webhook",
      triggerConfig: { webhookSource: { name }, keep: 1 },
      ...over,
    });

  it("binds to nothing — and creates nothing — while the space has no such source", async () => {
    const out = await declare("CI");
    expect(out).toEqual({
      triggerConfig: { webhookSource: { name: "CI" }, keep: 1 },
      source: null,
    });
    expect(
      (await listInboundWebhookSources(WS2)).map((s) => s.name)
    ).not.toContain("CI");
  });

  it("a person creating the source binds the space's automations that declared it, nothing else", async () => {
    const { source, boundAutomations } = await createInboundWebhookSource({
      userId: "u-1",
      workspaceId: WS2,
      name: "CI",
    });
    expect(boundAutomations).toBe(2);
    for (const id of [A.unbound, A.stale]) {
      const r = await autoRow(id);
      expect(r.trigger_config.webhookSubscriptionId, id).toBe(source.id);
      expect(r.version, id).toBe(2);
    }
    for (const id of [A.otherSpace, A.otherTrigger, A.otherName]) {
      const r = await autoRow(id);
      expect(r.trigger_config.webhookSubscriptionId, id).toBeUndefined();
      expect(r.version, id).toBe(1);
    }
  });

  it("then an install (any case of the name) binds to that same source", async () => {
    const [ci] = (await listInboundWebhookSources(WS2)).filter(
      (s) => s.name === "CI"
    );
    const out = await declare("ci");
    expect(out.source?.id).toBe(ci!.id);
    expect(out.triggerConfig).toEqual({
      webhookSource: { name: "ci" },
      keep: 1,
      webhookSubscriptionId: ci!.id,
    });
  });

  it("a config that declares nothing is returned as is", async () => {
    const config = { webhookSubscriptionId: "x" };
    const out = await bindDeclaredWebhookSource({
      workspaceId: WS2,
      triggerType: "webhook",
      triggerConfig: config,
    });
    expect(out).toEqual({ triggerConfig: config, source: null });
  });

  it.each([
    ["a malformed declaration", () => declare(""), /webhookSource must be/],
    [
      "a non-webhook trigger",
      () => declare("CI", { triggerType: "event" }),
      /read only by a `webhook` trigger/,
    ],
    [
      "an automation with no space",
      () => declare("CI", { workspaceId: null }),
      /needs a space/,
    ],
  ])("refuses %s", async (_label, call, reason) => {
    await expect(call()).rejects.toThrow(reason);
  });
});
