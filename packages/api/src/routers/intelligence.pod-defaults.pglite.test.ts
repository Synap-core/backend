/**
 * `intelligence.setPodDefaults` / `getPodDefaults` driven through the REAL
 * procedures on PGlite, read back through the REAL capture reader
 * (`readPodThirdPartyDecisionModelConsent`).
 *
 * What this pins: the decision-model consent is written through the SAME door
 * as the model tiers, and the door PATCHES `intelligenceDefaults` — saving the
 * tiers never clears the consent, toggling the consent never clears the tiers.
 * (The previous body did `settings || {intelligenceDefaults: input}`, which
 * replaced the whole object.)
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
import { readPodThirdPartyDecisionModelConsent } from "../services/intake/pod-vision-preference.js";

const caller = () =>
  intelligenceRouter.createCaller({
    authenticated: true,
    userId: "admin-1",
  } as never);

const consent = () =>
  readPodThirdPartyDecisionModelConsent(
    h.db as Parameters<typeof readPodThirdPartyDecisionModelConsent>[0]
  );

const TIERS = {
  chatModelId: "chat-x",
  reasoningModelId: null,
  embeddingModelId: null,
  visionModelId: "vision-y",
};

describe("intelligence.setPodDefaults — decision-model consent (real door, PGlite)", () => {
  beforeAll(async () => {
    await h.client!.exec(
      `create table pod_settings (id uuid primary key default gen_random_uuid(), settings jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now());`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(`delete from pod_settings;`);
  });

  it("default OFF: no row, or tiers saved without the key", async () => {
    expect(await consent()).toEqual({ allowed: false, reason: "not_opted_in" });
    expect(
      (await caller().getPodDefaults()).defaults.thirdPartyDecisionModel
    ).toBe(false);
    await caller().setPodDefaults(TIERS);
    expect(await consent()).toEqual({ allowed: false, reason: "not_opted_in" });
  });

  it("a consent-only call opts in, and a later tiers save does NOT clear it", async () => {
    await caller().setPodDefaults(TIERS);
    await caller().setPodDefaults({ thirdPartyDecisionModel: true });
    expect(await consent()).toEqual({ allowed: true });
    // The consent-only patch kept the tiers.
    expect((await caller().getPodDefaults()).defaults).toMatchObject({
      ...TIERS,
      thirdPartyDecisionModel: true,
    });

    await caller().setPodDefaults({ ...TIERS, chatModelId: "chat-z" });
    expect(await consent()).toEqual({ allowed: true });
    expect((await caller().getPodDefaults()).defaults.chatModelId).toBe(
      "chat-z"
    );

    await caller().setPodDefaults({ thirdPartyDecisionModel: false });
    expect(await consent()).toEqual({ allowed: false, reason: "not_opted_in" });
  });

  it("first write on an empty pod (insert path) records the consent", async () => {
    await caller().setPodDefaults({ thirdPartyDecisionModel: true });
    expect(await consent()).toEqual({ allowed: true });
  });

  it("validates: a non-boolean consent is refused at the door", async () => {
    await expect(
      caller().setPodDefaults({ thirdPartyDecisionModel: "yes" as never })
    ).rejects.toThrow();
    expect(await consent()).toEqual({ allowed: false, reason: "not_opted_in" });
  });
});
