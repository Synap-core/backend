/**
 * A POD-WIDE automation answers to its PERSON (decision 782c862e, founder
 * 2026-11-16; finding 54095e11).
 *
 * The defect: the pod-wide branch matched `automations.created_by = <event
 * userId>`. An agent-authored automation stores the AGENT as `created_by`, and
 * a fact recorded by another automation carries THAT automation's owning agent
 * as its userId — so agent ≠ agent ≠ person and nothing ever fired: the two
 * "Fix a finding" automations (3640f738 PR merged → merged, 2261b04b deployed →
 * verified, both by agent c340f738) sat active for nine days at runCount 0
 * while agent 0e0403a8's dev-loop automation recorded every `dev.pr_merged`.
 *
 * Proved through the REAL `handleAutomationTriggerMatch` against PGlite (the
 * real users / automations / workspace tables, the real
 * `podWideAutomationAnswersTo` SQL, the real `actorsOfSamePerson`):
 *   (a) an agent-authored pod-wide automation fires on an event by its person;
 *   (b) it fires on an event by ANOTHER agent of the same person (the
 *       finding's exact shape: 3640f738's config, a `dev.pr_merged` fact
 *       recorded by a second agent of the same person);
 *   (c) with audience `me` (the default) it does NOT fire on another person's
 *       event;
 *   (d) with audience `everyone` it DOES fire on another member's event, in a
 *       space its person can see — and not in a space its person cannot see
 *       (no data access widens);
 *   (e) an event by an agent nobody owns resolves to no person: fails closed.
 *
 * Stubbed (seams with their own suites): the pg-boss transport (captured), the
 * process engine (`syncProcessOnEvent`). What this does NOT cover: the executor
 * running the dispatched job; the dry-run half is
 * `services/rules/dry-run.audience.pglite.test.ts` in @synap/api.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sent: [] as Array<{ queue: string; automationId: string }>,
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
vi.mock("@synap/events", () => ({
  getBoss: () => ({
    send: async (queue: string, payload: { automationId: string }) => {
      h.sent.push({ queue, automationId: payload.automationId });
      return "job-id";
    },
  }),
}));
vi.mock("../../utils/process-sync.js", () => ({
  syncProcessOnEvent: async () => undefined,
}));

import { is, SQL } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { handleAutomationTriggerMatch } from "../automation-trigger-matcher.js";

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

/** The space the dev-loop facts land in (Builder, on the live pod). */
const WS = "22222222-2222-4222-8222-222222222222";
/** A space the automation's person is NOT a member of. */
const WS_FOREIGN = "33333333-3333-4333-8333-333333333333";
/** The person (the founder). */
const PERSON = "44444444-4444-4444-8444-444444444444";
/** The agent that AUTHORED the automation (c340f738 on the live pod). */
const AUTHOR_AGENT = "55555555-5555-4555-8555-555555555555";
/** Another agent of the same person, recording the fact (0e0403a8). */
const RECORDER_AGENT = "66666666-6666-4666-8666-666666666666";
/** Another pod member. */
const OTHER = "77777777-7777-4777-8777-777777777777";
/** An agent nobody owns. */
const ORPHAN_AGENT = "88888888-8888-4888-8888-888888888888";

/** 3640f738's trigger + flow shape (the guard + session_update), verbatim. */
const PR_MERGED_FLOW = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      data: { triggerType: "event", config: { eventPattern: "dev.pr_merged" } },
    },
    {
      id: "to-merged",
      type: "output",
      data: { outputType: "session_update", config: {} },
    },
  ],
  edges: [{ id: "e1", source: "t", target: "to-merged" }],
};

async function podWideAutomation(
  triggerConfig: Record<string, unknown>,
  createdBy = AUTHOR_AGENT
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, success_count, failure_count, run_count, version, metadata, state)
     values ($1, NULL, $2, $3, 'event', $4::jsonb, $5::jsonb, 'active', 0, 0, 0, 1, '{}'::jsonb, '{}'::jsonb)`,
    [
      id,
      createdBy,
      `rule-${id}`,
      JSON.stringify(triggerConfig),
      JSON.stringify(PR_MERGED_FLOW),
    ]
  );
  return id;
}

/** A `dev.pr_merged` fact as `recordObservation` emits it: userId = the recorder. */
const prMerged = (userId: string, workspaceId: string = WS) =>
  handleAutomationTriggerMatch({
    data: {
      eventType: "dev.pr_merged",
      subjectId: randomUUID(),
      userId,
      workspaceId,
      eventId: randomUUID(),
      data: {
        sessionId: randomUUID(),
        intoDefault: true,
        repo: "Synap-core/backend",
        number: 1,
      },
    } as never,
  });

const fired = (automationId: string) =>
  h.sent.filter(
    (s) => s.queue === "automation-execute" && s.automationId === automationId
  ).length;

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  h.sent.length = 0;
  await h.client!.exec(
    "delete from automations; delete from automation_runs; delete from automation_claims; delete from users; delete from workspace_members; delete from workspaces;"
  );
  await q(
    `insert into users (id, email, user_type) values ($1, 'p@x.test', 'human'), ($2, 'o@x.test', 'human')`,
    [PERSON, OTHER]
  );
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values
       ($1, 'a@x.test', 'agent', $3), ($2, 'r@x.test', 'agent', $3), ($4, 'z@x.test', 'agent', NULL)`,
    [AUTHOR_AGENT, RECORDER_AGENT, PERSON, ORPHAN_AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1, 'Builder', $3, '{}'::jsonb), ($2, 'Theirs', $4, '{}'::jsonb)`,
    [WS, WS_FOREIGN, PERSON, OTHER]
  );
  // PERSON and OTHER share WS; WS_FOREIGN is OTHER's alone.
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       ($1, $3, $5, 'owner'), ($2, $3, $6, 'editor'), ($4, $7, $6, 'owner')`,
    [randomUUID(), randomUUID(), WS, randomUUID(), PERSON, OTHER, WS_FOREIGN]
  );
});

describe("a pod-wide automation answers to its person", () => {
  it("(a) fires an agent-authored automation on an event by its person", async () => {
    const auto = await podWideAutomation({ eventPattern: "dev.pr_merged" });
    await prMerged(PERSON);
    expect(fired(auto)).toBe(1);
  });

  it("(b) fires it on a fact recorded by ANOTHER agent of the same person (finding 54095e11)", async () => {
    // 3640f738's exact config: no audience → the default `me`.
    const auto = await podWideAutomation({ eventPattern: "dev.pr_merged" });
    await prMerged(RECORDER_AGENT);
    expect(fired(auto)).toBe(1);
  });

  it("(c) audience `me` does NOT fire on another person's event", async () => {
    const implicit = await podWideAutomation({ eventPattern: "dev.pr_merged" });
    const explicit = await podWideAutomation({
      eventPattern: "dev.pr_merged",
      audience: "me",
    });
    await prMerged(OTHER);
    expect(fired(implicit)).toBe(0);
    expect(fired(explicit)).toBe(0);
  });

  it("(d) audience `everyone` fires on another member's event in a space its person can see", async () => {
    const auto = await podWideAutomation({
      eventPattern: "dev.pr_merged",
      audience: "everyone",
    });
    await prMerged(OTHER, WS);
    expect(fired(auto)).toBe(1);
  });

  it("(d') audience `everyone` does NOT run in a space its person cannot see", async () => {
    const auto = await podWideAutomation({
      eventPattern: "dev.pr_merged",
      audience: "everyone",
    });
    await prMerged(OTHER, WS_FOREIGN);
    expect(fired(auto)).toBe(0);
    // CONTROL: the same event in the shared space does fire it.
    await prMerged(OTHER, WS);
    expect(fired(auto)).toBe(1);
  });

  it("(e) an event by an agent nobody owns resolves to no person (fails closed)", async () => {
    const auto = await podWideAutomation({ eventPattern: "dev.pr_merged" });
    await prMerged(ORPHAN_AGENT);
    expect(fired(auto)).toBe(0);
  });

  it("a person's OWN automation still fires on their own event (the pre-decision case)", async () => {
    const auto = await podWideAutomation(
      { eventPattern: "dev.pr_merged" },
      PERSON
    );
    await prMerged(PERSON);
    expect(fired(auto)).toBe(1);
  });
});
