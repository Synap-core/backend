/**
 * `intelligence.setPodDefaults` / `getPodDefaults` driven through the REAL
 * procedures on PGlite.
 *
 * What this pins: the door PATCHES `intelligenceDefaults` instead of replacing
 * it, so saving ONE field never clears its siblings. The previous body did
 * `settings || { intelligenceDefaults: input }`, which replaced the whole
 * object — a partial save silently dropped every key it did not mention.
 * (Found while adding a key here; the key itself, a TypeSafe-only consent
 * flag, was withdrawn on 2026-09-20 — provider choice is an operator decision,
 * uniform across providers — but the patch semantics it exposed are the real
 * regression guard and stay.)
 *
 * Stubbed: `db` → a PGlite drizzle over `pod_settings`; `isPodAdmin` → true
 * (the admin gate is not what this test is about).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client);
  return { ...actual, db: h.db, getDb: async () => h.db };
});

vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async () => true,
}));

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));

import { intelligenceRouter } from "./intelligence.js";
import { readPodVisionModelPreference } from "../services/intake/pod-vision-preference.js";

const caller = () =>
  intelligenceRouter.createCaller({
    authenticated: true,
    userId: "admin-1",
  } as never);

/** Read back through the REAL capture-side reader, not the router's own echo. */
const storedVisionModel = () =>
  readPodVisionModelPreference(
    h.db as Parameters<typeof readPodVisionModelPreference>[0]
  );

const TIERS = {
  chatModelId: "chat-x",
  reasoningModelId: null,
  embeddingModelId: null,
  visionModelId: "vision-y",
};

describe("intelligence.setPodDefaults — patch, never replace (real door, PGlite)", () => {
  beforeAll(async () => {
    await h.client!.exec(
      `create table pod_settings (id uuid primary key default gen_random_uuid(), settings jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(`delete from pod_settings;`);
  });

  it("first write on an empty pod (insert path) stores what was sent", async () => {
    await caller().setPodDefaults(TIERS);
    expect(await storedVisionModel()).toBe("vision-y");
    expect((await caller().getPodDefaults()).defaults).toMatchObject(TIERS);
  });

  it("a PARTIAL save keeps the keys it did not mention", async () => {
    // The discriminating row: with the old replace-the-object body, this
    // second call dropped visionModelId entirely.
    await caller().setPodDefaults(TIERS);
    await caller().setPodDefaults({ chatModelId: "chat-z" });
    expect((await caller().getPodDefaults()).defaults).toMatchObject({
      ...TIERS,
      chatModelId: "chat-z",
    });
    expect(await storedVisionModel()).toBe("vision-y");
  });

  it("an explicit null CLEARS that key without touching the others", async () => {
    await caller().setPodDefaults(TIERS);
    await caller().setPodDefaults({ visionModelId: null });
    expect(await storedVisionModel()).toBeUndefined();
    expect((await caller().getPodDefaults()).defaults.chatModelId).toBe(
      "chat-x"
    );
  });
});
