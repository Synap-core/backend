/**
 * Onboarding start reads (A5) through the REAL procedures on PGlite: when
 * onboarding is due (`startState.due`), the starts list (bundled, offline),
 * `recordStartStep` (deep merge, transitions, never replaces the completed
 * list) and the cloud pull with a mocked CP (ok / empty / not-linked / failed,
 * and a non-owner email gets no answers).
 *
 * NOT covered: the agent / first-work facts (their rule is the pure model's,
 * `packages/types/src/onboarding/start.test.ts`).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  admins: new Set<string>(),
  link: null as null | { podId: string; url: string | null },
  fetch: vi.fn(),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: { onboardingJourneys: actual.onboardingJourneys as never },
  });
  return {
    ...actual,
    getDb: async () => h.db,
    readControlPlaneLink: async () => h.link,
    podCpAuthHeaders: async () => ({
      via: "pod-jwt",
      headers: { Authorization: "Bearer test" },
      bearer: "test",
    }),
  };
});

vi.mock("../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: async () => false,
}));
vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: async (userId: string) => h.admins.has(userId),
}));
vi.mock("../services/agent-presence.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAgentPresence: async () => new Map(),
}));

const startOf = (order: number, views: string[]) => ({
  order,
  label: `Start ${order}`,
  promise: "A promise.",
  suggestFor: ["founder"],
  profile: "deal",
  views,
});
vi.mock("@synap-core/workspace-templates", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listWorkspaceTemplates: () => [
    {
      meta: {
        slug: "crm",
        icon: "briefcase",
        start: startOf(2, ["a", "b", "c"]),
      },
    },
    { meta: { slug: "content-os", icon: "pen", start: startOf(1, ["only"]) } },
    { meta: { slug: "broken", icon: "x", start: { order: 3 } } },
    { meta: { slug: "plain", icon: "x" } },
  ],
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { onboardingJourneys } from "@synap/database";
import { onboardingRouter } from "./onboarding.js";

const ADMIN = "admin-1";
const MEMBER = "member-1";
const OWNER_EMAIL = "ada@ex.com";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|timestamp|date|varchar)/;

/** A column default derived from the Drizzle definition (the procedure's
 *  inserts rely on them: `id`, `offered_at`, `created_at`). */
function defaultFor(
  c: { hasDefault: boolean; default?: unknown },
  type: string
): string {
  if (!c.hasDefault) return "";
  if (type === "uuid") return " default gen_random_uuid()";
  if (type.startsWith("timestamp")) return " default now()";
  if (c.default === undefined) return "";
  const literal =
    typeof c.default === "string" ? c.default : JSON.stringify(c.default);
  return ` default '${literal.replace(/'/g, "''")}'`;
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${defaultFor(c, type)}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string) =>
  onboardingRouter.createCaller({ authenticated: true, userId } as never);

async function seedJourney(
  userId: string,
  status: string,
  progress: Record<string, unknown>
) {
  await q(
    `insert into onboarding_journeys (id, user_id, lens_kind, lens_key, template_version, status, progress, evidence, offered_at, created_at, updated_at)
     values ($1, $2, 'pod', 'pod', '1', $3, $4::jsonb, '{"meaningfulEntityIds":[],"completedCriteria":[]}'::jsonb, now(), now(), now())`,
    [randomUUID(), userId, status, JSON.stringify(progress)]
  );
}

async function progressOf(userId: string) {
  const { rows } = await q<{ status: string; progress: any }>(
    `select status, progress from onboarding_journeys where user_id = $1`,
    [userId]
  );
  return rows[0];
}

const addSpace = (settings: object = {}, systemSlug: string | null = null) =>
  q(
    `insert into workspaces (id, archived_at, system_slug, settings) values ($1, null, $2, $3::jsonb)`,
    [randomUUID(), systemSlug, JSON.stringify(settings)]
  );

const cpAnswers = (over: Record<string, unknown> = {}) => ({
  v: 1,
  owner: { email: OWNER_EMAIL, adminEmail: null, name: "Ada" },
  answers: { start: "crm", workingOn: "a newsletter", identity: ["founder"] },
  experiments: { setupPath: "quick" },
  billing: { tier: "solo", paidAt: null },
  ...over,
});
const cpOk = (body: unknown) =>
  h.fetch.mockResolvedValue({ ok: true, status: 200, json: async () => body });

describe("onboarding start reads (real procedures, PGlite)", () => {
  beforeAll(async () => {
    await h.client!.exec(ddlFor(onboardingJourneys as unknown as PgTable));
    await h.client!.exec(`
      create unique index onboarding_journeys_user_lens_version_unique on onboarding_journeys (user_id, lens_key, template_version);
      create table users (id text primary key, email text);
      create table workspaces (id uuid primary key, archived_at timestamptz, system_slug text, settings jsonb);
      create table proposals (id uuid primary key, status text, reviewed_at timestamptz, data jsonb, agent_user_id text);
      create table api_keys (user_id text, key_type text, linked_user_id text, revoked_at timestamptz);
    `);
    vi.stubGlobal("fetch", h.fetch);
  });

  beforeEach(async () => {
    await h.client!.exec(
      `delete from onboarding_journeys; delete from users; delete from workspaces;`
    );
    await q(
      `insert into users (id, email) values ($1, $2), ($3, 'other@ex.com')`,
      [ADMIN, OWNER_EMAIL, MEMBER]
    );
    h.admins = new Set([ADMIN]);
    h.link = { podId: "pod-1", url: "https://cp.example" };
    h.fetch.mockReset();
    cpOk(cpAnswers());
  });

  describe("startState.due (the four cases of the gate)", () => {
    it("an admin on an empty pod with no journey: due", async () => {
      await addSpace({}, "pod-admin"); // a system space is not a space
      expect((await caller(ADMIN).startState()).due).toBe(true);
    });

    it("an existing pod with spaces: not due, even with an `offered` row from an unrelated values write", async () => {
      await addSpace();
      expect((await caller(ADMIN).startState()).due).toBe(false);
      await seedJourney(ADMIN, "offered", {
        completedActionIds: [],
        values: { firstRun: { focus: "x" } },
      });
      expect((await caller(ADMIN).startState()).due).toBe(false);
    });

    it("a non-admin is never due and never triggers the CP pull", async () => {
      const s = await caller(MEMBER).startState();
      expect(s.due).toBe(false);
      expect(s.cloud).toBeNull();
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["offered", true],
      ["active", true],
      ["paused", true],
      ["completed", false],
      ["dismissed", false],
    ])("an admin with a %s start journey: due=%s", async (status, due) => {
      await addSpace(); // spaces exist: the start journey alone decides
      await seedJourney(ADMIN, status, {
        completedActionIds: [],
        values: { start: { v: 1 } },
      });
      expect((await caller(ADMIN).startState()).due).toBe(due);
    });
  });

  describe("listStarts (bundled, offline)", () => {
    it("lists valid starts in order, skips a broken or absent one, never calls the network", async () => {
      const starts = await caller(ADMIN).listStarts();
      expect(starts.map((s) => s.slug)).toEqual(["content-os", "crm"]);
      expect(h.fetch).not.toHaveBeenCalled();
    });
  });

  describe("recordStartStep", () => {
    it("deep-merges, keeps foreign step ids, and writes the model's prefix", async () => {
      await seedJourney(ADMIN, "offered", {
        currentActionId: "tools",
        completedActionIds: ["relay:tools", "start:intent"],
        values: {
          tools: [{ name: "Notion" }],
          start: {
            v: 1,
            intent: { slug: "old", source: "here", at: "t0", keep: "me" },
          },
        },
      });
      await caller(ADMIN).recordStartStep({
        step: "intent",
        patch: { slug: "crm", source: "here" },
      });
      const row = await progressOf(ADMIN);
      expect(row!.status).toBe("active");
      expect(row!.progress.values.tools).toEqual([{ name: "Notion" }]);
      const intent = row!.progress.values.start.intent;
      expect(intent).toMatchObject({ slug: "crm", source: "here", keep: "me" });
      expect(intent.at).not.toBe("t0");
      // `relay:` ids survive; start ids are the model's prefix (crm has 3 views).
      expect(row!.progress.completedActionIds).toEqual([
        "relay:tools",
        "start:intent",
      ]);
      expect(row!.progress.currentActionId).toBe("start:views");
    });

    it("a start with one view skips the views step", async () => {
      await caller(ADMIN).recordStartStep({
        step: "intent",
        patch: { slug: "content-os", source: "here" },
      });
      const row = await progressOf(ADMIN);
      expect(row!.progress.completedActionIds).toEqual([
        "start:intent",
        "start:views",
      ]);
      expect(row!.progress.currentActionId).toBe("start:path");
    });

    it("enforces transitions: no step past the next one", async () => {
      await expect(
        caller(ADMIN).recordStartStep({
          step: "path",
          patch: { kind: "quick" },
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await caller(ADMIN).recordStartStep({
        step: "intent",
        patch: { slug: "crm", source: "here" },
      });
      await expect(
        caller(ADMIN).recordStartStep({
          step: "path",
          patch: { kind: "quick" },
        })
      ).rejects.toMatchObject({ code: "CONFLICT" }); // views is next
      await caller(ADMIN).recordStartStep({
        step: "views",
        patch: { profile: "deal", view: "a", type: "kanban" },
      });
      await caller(ADMIN).recordStartStep({
        step: "path",
        patch: { kind: "quick" },
      });
      // A choice already made can be changed.
      await caller(ADMIN).recordStartStep({
        step: "path",
        patch: { kind: "cobuild" },
      });
      expect((await progressOf(ADMIN))!.progress.values.start.path.kind).toBe(
        "cobuild"
      );
    });

    it("refuses a non-admin, an unknown start, a derived step and a completed journey", async () => {
      await expect(
        caller(MEMBER).recordStartStep({
          step: "intent",
          patch: { slug: "crm", source: "here" },
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        caller(ADMIN).recordStartStep({
          step: "intent",
          patch: { slug: "nope", source: "here" },
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(
        caller(ADMIN).recordStartStep({ step: "done", patch: {} })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await seedJourney(ADMIN, "completed", {
        completedActionIds: [],
        values: {},
      });
      await expect(
        caller(ADMIN).recordStartStep({
          step: "intent",
          patch: { slug: "crm", source: "here" },
        })
      ).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("a cloud intent copies what the CP said, read on the pod; it is refused when the cloud answer is not ok", async () => {
      await caller(ADMIN).recordStartStep({
        step: "intent",
        patch: { slug: "crm", source: "cloud" },
      });
      const cloud = (await progressOf(ADMIN))!.progress.values.start.cloud;
      expect(cloud).toMatchObject({ start: "crm", workingOn: "a newsletter" });
      expect(cloud.readAt).toBeTruthy();

      await h.client!.exec(`delete from onboarding_journeys;`);
      cpOk(cpAnswers({ answers: null }));
      await expect(
        caller(ADMIN).recordStartStep({
          step: "intent",
          patch: { slug: "crm", source: "cloud" },
        })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
  });

  describe("startState.cloud (mocked CP): four states, never folded", () => {
    const cloud = async (userId = ADMIN) =>
      (await caller(userId).startState()).cloud;

    it("ok: the owner's answers, with the experiments", async () => {
      expect(await cloud()).toMatchObject({
        status: "ok",
        answers: { start: "crm", workingOn: "a newsletter" },
        experiments: { setupPath: "quick" },
      });
      expect(h.fetch.mock.calls[0]![0]).toBe(
        "https://cp.example/internal/onboarding-answers"
      );
    });

    it("ok on the admin email, case-insensitively", async () => {
      cpOk(
        cpAnswers({
          owner: { email: "someone@else.com", adminEmail: "ADA@ex.COM" },
        })
      );
      expect(await cloud()).toMatchObject({ status: "ok" });
    });

    it("a viewer who is not the owner gets no answers", async () => {
      h.admins.add(MEMBER); // an admin, but another person
      const state = await cloud(MEMBER);
      expect(state).toEqual({ status: "empty" });
      expect(JSON.stringify(state)).not.toContain("crm");
    });

    it("empty: no answers on the CP side is not a failure", async () => {
      cpOk(cpAnswers({ answers: null }));
      expect(await cloud()).toEqual({ status: "empty" });
    });

    it("not-linked: a pod with no Control Plane link never calls out", async () => {
      h.link = null;
      expect(await cloud()).toEqual({ status: "not-linked" });
      expect(h.fetch).not.toHaveBeenCalled();
    });

    it.each([
      [500, "server-error"],
      [403, "refused"],
      [401, "refused"],
      [404, "unknown-pod"],
    ])("failed: HTTP %s reads %s, not empty", async (status, reason) => {
      h.fetch.mockResolvedValue({ ok: false, status });
      expect(await cloud()).toEqual({ status: "failed", reason });
    });

    it("failed: an unreachable CP and an unreadable body", async () => {
      h.fetch.mockRejectedValue(new Error("ECONNRESET"));
      expect(await cloud()).toEqual({
        status: "failed",
        reason: "unreachable",
      });
      cpOk({ nonsense: true });
      expect(await cloud()).toEqual({ status: "failed", reason: "invalid" });
    });

    it("is asked only while the intent step is open", async () => {
      await caller(ADMIN).recordStartStep({
        step: "intent",
        patch: { slug: "crm", source: "here" },
      });
      h.fetch.mockClear();
      const s = await caller(ADMIN).startState();
      expect(s.cloud).toBeNull();
      expect(s.starts).toBeUndefined();
      expect(h.fetch).not.toHaveBeenCalled();
    });
  });
});
