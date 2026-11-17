/**
 * The rule dry run counts the events the LIVE matcher answers a pod-wide
 * automation with (decision 782c862e, finding 54095e11): the caller's PERSON
 * and that person's agents, read through the same `actorsOfSamePerson` the
 * matcher calls. Before the decision the floor was `events.user_id = <caller>`,
 * so a fact recorded by one of the caller's agents (the dev-loop automation's
 * `dev.pr_merged`) matched live but never in the preview.
 *
 * Through the REAL `runRuleDryRun` on PGlite (every @synap/database table):
 *   - a fact by the person and a fact by another of the person's agents both
 *     count; another person's fact never does;
 *   - audience `everyone` does NOT widen the read (another member's history
 *     stays out) and says so in a caveat.
 *
 * Not covered here: the live matcher (its own PGlite suite in @synap/jobs,
 * `automation-trigger-matcher.audience.pglite.test.ts`).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  return { ...actual, db: drizzle(client, { schema }) };
});

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { runRuleDryRun, type RuleDryRunMatch } from "./dry-run.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function sqlDefault(d: unknown): string {
  if (is(d, SQL)) {
    return (d as SQL).queryChunks
      .map((c) => {
        const v = (c as { value?: unknown }).value;
        return Array.isArray(v) ? v.join("") : "";
      })
      .join("");
  }
  if (typeof d === "string") return `'${d.replace(/'/g, "''")}'`;
  if (typeof d === "number" || typeof d === "boolean") return String(d);
  if (d && typeof d === "object") return `'${JSON.stringify(d)}'::jsonb`;
  return "";
}

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = t.endsWith("[]")
      ? t
      : BASIC.test(t)
        ? t.replace(/\(.*\)/, "")
        : "text";
    const def =
      !c.hasDefault ||
      (c.default !== null &&
        typeof c.default === "object" &&
        !is(c.default, SQL) &&
        !/^json/.test(type))
        ? ""
        : sqlDefault(c.default);
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def ? ` default ${def}` : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const WS = "22222222-2222-4222-8222-222222222222";
const PERSON = "44444444-4444-4444-8444-444444444444";
const RECORDER_AGENT = "66666666-6666-4666-8666-666666666666";
const OTHER = "77777777-7777-4777-8777-777777777777";

async function prMergedFact(userId: string): Promise<void> {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, workspace_id, source)
     values ($1, now(), 'dev.pr_merged', $2, 'pull_request', '{}'::jsonb, $3, $4, 'automation')`,
    [randomUUID(), randomUUID(), userId, WS]
  );
}

const replay = (triggerConfig: Record<string, unknown>) =>
  runRuleDryRun({
    userId: PERSON,
    triggerType: "event",
    triggerConfig,
    windowDays: 7,
  }) as Promise<RuleDryRunMatch>;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  await h.client!.exec("delete from events; delete from users;");
  await q(
    `insert into users (id, email, user_type) values ($1, 'p@x.test', 'human'), ($2, 'o@x.test', 'human')`,
    [PERSON, OTHER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'r@x.test', 'agent', $2)`,
    [RECORDER_AGENT, PERSON]
  );
  await prMergedFact(PERSON);
  await prMergedFact(RECORDER_AGENT);
  await prMergedFact(OTHER);
});

describe("dry run × the person a pod-wide automation answers to", () => {
  it("counts the person's facts and their agents' facts, never another person's", async () => {
    const result = await replay({ eventPattern: "dev.pr_merged" });
    expect(result.status).toBe("ok");
    expect(result.scannedEventCount).toBe(2);
    expect(result.matchingEventCount).toBe(2);
  });

  it("audience `everyone` does not widen the read, and says so", async () => {
    const result = await replay({
      eventPattern: "dev.pr_merged",
      audience: "everyone",
    });
    expect(result.matchingEventCount).toBe(2);
    expect(result.caveats.some((c) => c.includes("everyone"))).toBe(true);
  });

  it("audience `me` carries no audience caveat", async () => {
    const result = await replay({ eventPattern: "dev.pr_merged" });
    expect(result.caveats.some((c) => c.includes("everyone"))).toBe(false);
  });
});
