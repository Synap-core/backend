/**
 * Inbound webhook sources (0362) on a real `webhook_subscriptions` table
 * (PGlite, with the migration's own CHECK and unique index):
 *   - a source is an `inbound` row with no url and no event types; its secret
 *     comes back ONCE (create, replace), never from a list;
 *   - one source per (space, name): a second create is a 409;
 *   - an automation's DECLARED source (`triggerConfig.webhookSource.name`)
 *     binds to the space's source of that name, created when missing, and
 *     every later bind (a re-install, a concurrent one) gets the SAME row.
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

describe("bindDeclaredWebhookSource — an automation's declared source", () => {
  const declare = (name: unknown, over: Record<string, unknown> = {}) =>
    bindDeclaredWebhookSource({
      userId: "u-2",
      workspaceId: WS2,
      triggerType: "webhook",
      triggerConfig: { webhookSource: { name }, keep: 1 },
      ...over,
    });

  it("creates the space's source when missing, then binds every later install to the SAME row", async () => {
    const first = await declare("CI");
    expect(first.source).toMatchObject({ name: "CI", created: true });
    expect(first.triggerConfig).toEqual({
      webhookSource: { name: "CI" },
      keep: 1,
      webhookSubscriptionId: first.source!.id,
    });
    // The created source's secret is never handed to the declaring caller.
    expect(JSON.stringify(first)).not.toContain(
      (await row(first.source!.id)).secret
    );

    const again = await declare("ci");
    expect(again.source).toMatchObject({
      id: first.source!.id,
      created: false,
    });
    // Concurrent installs converge on one row.
    const racing = await Promise.all([declare("Forms"), declare("forms")]);
    expect(racing[0].source!.id).toBe(racing[1].source!.id);
  });

  it("binds to an existing source a person created", async () => {
    const { source } = await createInboundWebhookSource({
      userId: "u-1",
      workspaceId: WS2,
      name: "Stripe",
    });
    const bound = await declare("stripe");
    expect(bound.triggerConfig.webhookSubscriptionId).toBe(source.id);
    expect(bound.source!.created).toBe(false);
  });

  it("a config that declares nothing is returned as is", async () => {
    const config = { webhookSubscriptionId: "x" };
    const out = await bindDeclaredWebhookSource({
      userId: "u-2",
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
