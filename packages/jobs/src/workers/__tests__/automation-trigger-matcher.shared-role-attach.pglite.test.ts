/**
 * A SHARED (pod-wide) role attached from one space reaches the rules of every
 * space the actor can reach — design « Lead → client in the product » W1
 * (pod document 05ed390c, founder-approved 2026-11-17).
 *
 * The defect: the facet door announces a pod-wide facet's attach under the
 * space it was written from (`fallbackWorkspaceId`, the caller's lens), and the
 * matcher kept a non-null-workspace event inside that one space. So the
 * `client` role attached from the CRM fired only CRM rules, and the Operations
 * « Onboard a client » activator (`{on: created}` on the client role) never
 * started. The announcement now says the subject is pod-wide
 * (`podWideSubject`), and the matcher matches it in the lens AND across the
 * actor's accessible floor, each match running in its own space.
 *
 * Proved through the REAL `handleAutomationTriggerMatch` against PGlite (real
 * automations / users / workspaces / members tables, the real floor SQL), with
 * the triggers compiled from the activator sentence the playbook declares:
 *   (a) a pod-wide client attached under the CRM fires Operations' activator,
 *       run IN OPERATIONS, and still fires the CRM's own client rule in the CRM;
 *   (b) a space-bound client facet attached under the CRM fires only the CRM;
 *   (c) a pod-wide lead attached under the CRM fires the CRM's lead activator
 *       once, in the CRM, and no client activator;
 *   (d) no widening: a space the actor cannot reach never fires;
 *   (e) the lens is kept when the actor is no member of it (an agent's write),
 *       so a rule that fired before still fires.
 *
 * Stubbed: the pg-boss transport (captured) and the process engine. Not
 * covered: the executor running the dispatched job, and the facet door's
 * announcement itself (`create-role-attach-emit.pglite.test.ts`, @synap/api).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  sent: [] as Array<{
    queue: string;
    automationId: string;
    workspaceId: string | null;
  }>,
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
    send: async (
      queue: string,
      payload: { automationId: string; workspaceId: string | null }
    ) => {
      h.sent.push({
        queue,
        automationId: payload.automationId,
        workspaceId: payload.workspaceId,
      });
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
import {
  playbookActivatorSentence,
  toBackendTrigger,
} from "@synap-core/types/automations";
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

/** The CRM: where the lead is converted and the client role attached. */
const CRM = "22222222-2222-4222-8222-222222222222";
/** Operations: the client space, whose playbook starts on a client. */
const OPS = "33333333-3333-4333-8333-333333333333";
/** A space the person cannot reach (another member's, not pod-visible). */
const FOREIGN = "99999999-9999-4999-8999-999999999999";
/** The person (the founder). */
const PERSON = "44444444-4444-4444-8444-444444444444";
/** Another pod member, alone in FOREIGN. */
const OTHER = "77777777-7777-4777-8777-777777777777";
/** An agent of PERSON, member of no space. */
const AGENT = "55555555-5555-4555-8555-555555555555";

const FLOW = {
  nodes: [
    {
      id: "t",
      type: "trigger",
      data: { triggerType: "event", config: {} },
    },
  ],
  edges: [],
};

/** The trigger a playbook's `{on: created}` activator on a ROLE compiles to. */
function activatorTrigger(profileSlug: string): Record<string, unknown> {
  const sentence = playbookActivatorSentence({
    playbookId: randomUUID(),
    profileSlug,
    on: "created",
    profileKind: "role",
    mode: "propose",
  });
  return toBackendTrigger(sentence.trigger!, sentence.conditions)
    .triggerConfig as Record<string, unknown>;
}

async function automationIn(
  workspaceId: string,
  triggerConfig: Record<string, unknown>,
  createdBy = PERSON
): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into automations (id, workspace_id, created_by, name, trigger_type, trigger_config, flow_definition, status, success_count, failure_count, run_count, version, metadata, state)
     values ($1, $2, $3, $4, 'event', $5::jsonb, $6::jsonb, 'active', 0, 0, 0, 1, '{}'::jsonb, '{}'::jsonb)`,
    [
      id,
      workspaceId,
      createdBy,
      `rule-${id}`,
      JSON.stringify(triggerConfig),
      JSON.stringify(FLOW),
    ]
  );
  return id;
}

/** The facet door's announcement, as the reactor hands it to the matcher. */
const attached = (opts: {
  profileSlug: string;
  podWideSubject: boolean;
  userId?: string;
}) => {
  const facetId = randomUUID();
  return handleAutomationTriggerMatch({
    data: {
      eventType: "entity_facet.attach.completed",
      subjectId: facetId,
      userId: opts.userId ?? PERSON,
      // The lens it was attached from: the CRM.
      workspaceId: CRM,
      eventId: randomUUID(),
      data: {
        entityId: randomUUID(),
        facetId,
        profileSlug: opts.profileSlug,
      },
      ...(opts.podWideSubject ? { podWideSubject: true } : {}),
    } as never,
  });
};

/** The spaces a given automation was dispatched to run in. */
const runsOf = (automationId: string) =>
  h.sent
    .filter(
      (s) => s.queue === "automation-execute" && s.automationId === automationId
    )
    .map((s) => s.workspaceId);

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
    `insert into users (id, email, user_type, created_by_user_id) values ($1, 'a@x.test', 'agent', $2)`,
    [AGENT, PERSON]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values
       ($1, 'CRM', $4, '{}'::jsonb), ($2, 'Operations', $4, '{}'::jsonb), ($3, 'Theirs', $5, '{}'::jsonb)`,
    [CRM, OPS, FOREIGN, PERSON, OTHER]
  );
  // PERSON is in the CRM and Operations; FOREIGN is OTHER's alone.
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       ($1, $4, $7, 'owner'), ($2, $5, $7, 'owner'), ($3, $6, $8, 'owner')`,
    [randomUUID(), randomUUID(), randomUUID(), CRM, OPS, FOREIGN, PERSON, OTHER]
  );
});

describe("a shared role attached from one space reaches every space's rules", () => {
  it("(a) a pod-wide client attached under the CRM starts Operations' « Onboard a client », in Operations", async () => {
    const onboard = await automationIn(OPS, activatorTrigger("client"));
    const crmClientRule = await automationIn(CRM, activatorTrigger("client"));

    await attached({ profileSlug: "client", podWideSubject: true });

    expect(runsOf(onboard)).toEqual([OPS]);
    // The CRM's own rule is unchanged: once, in the CRM.
    expect(runsOf(crmClientRule)).toEqual([CRM]);
  });

  it("(b) a space-bound client facet attached under the CRM fires only the CRM", async () => {
    const onboard = await automationIn(OPS, activatorTrigger("client"));
    const crmClientRule = await automationIn(CRM, activatorTrigger("client"));

    await attached({ profileSlug: "client", podWideSubject: false });

    expect(runsOf(onboard)).toEqual([]);
    expect(runsOf(crmClientRule)).toEqual([CRM]);
  });

  it("(c) a pod-wide lead under the CRM fires the CRM's lead activator once, and no client activator", async () => {
    const qualify = await automationIn(CRM, activatorTrigger("lead"));
    const onboard = await automationIn(OPS, activatorTrigger("client"));

    await attached({ profileSlug: "lead", podWideSubject: true });

    expect(runsOf(qualify)).toEqual([CRM]);
    expect(runsOf(onboard)).toEqual([]);
  });

  it("(d) never reaches a space the actor cannot reach", async () => {
    const theirs = await automationIn(
      FOREIGN,
      activatorTrigger("client"),
      OTHER
    );
    const onboard = await automationIn(OPS, activatorTrigger("client"));

    await attached({ profileSlug: "client", podWideSubject: true });

    expect(runsOf(theirs)).toEqual([]);
    // CONTROL: the same event does reach a space the actor can reach.
    expect(runsOf(onboard)).toEqual([OPS]);
  });

  it("(e) keeps the lens when the actor is no member of it (an agent's write)", async () => {
    const crmClientRule = await automationIn(CRM, activatorTrigger("client"));

    await attached({
      profileSlug: "client",
      podWideSubject: true,
      userId: AGENT,
    });

    expect(runsOf(crmClientRule)).toEqual([CRM]);
  });
});
