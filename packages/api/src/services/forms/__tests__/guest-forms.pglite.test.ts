/**
 * Sites W4 — public forms end to end on PGlite: the owner door, the minted
 * actor, the anonymous POST, the identity branch, the mode floor, the expiry
 * sweep and the generic-tools refusals.
 *
 * REAL: the `forms` tRPC router, the form service, the guest door, the public
 * Hono routes under the real hub auth + idempotency middleware, the `tools`
 * router, identity resolution, the governance RESOLVER + engine (against real
 * `users` / `governance_rules` rows), `resolvePendingProposalCap`, and the
 * expiry sweeper.
 *
 * THE GATE: `checkPermissionOrPropose` is a thin adapter over the REAL
 * `resolveAgentGovernanceDecision` (forcePropose passed through, exactly the
 * input the production gate hands it). A propose verdict inserts a real
 * `proposals` row so the expiry stamp and the sweeper act on stored data. A
 * non-agent actor is granted — EXACTLY the production gate's fall-through —
 * which is why the door's own actor floor is tested against it.
 * What this CANNOT see: the gate's RBAC, its pending-cap refusal (the ceiling
 * row it reads IS asserted), notifications, and DIRECT materialisation through
 * `entities.create` (the seam is replaced by a recorder; NEEDS-DOGFOOD).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  gateCalls: [] as Array<Record<string, unknown>>,
  ambientAtGate: [] as Array<string | undefined>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
  };
});
vi.mock("../../../utils/permission-check.js", async () => {
  const { resolveAgentGovernanceDecision } =
    await import("@synap/database/agent-governance");
  const { getActingAgentUserId } = await import("@synap/database");
  return {
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      h.ambientAtGate.push(getActingAgentUserId());
      const agentUserId = opts.agentUserId as string | undefined;
      // Production fall-through for a non-agent principal: granted.
      if (!agentUserId) return { granted: true };
      const gov = await resolveAgentGovernanceDecision({
        db: h.db as never,
        agentUserId,
        workspaceId: opts.workspaceId as string,
        subjectType: opts.subjectType as string,
        action: opts.action as string,
        forcePropose: opts.forcePropose as boolean | undefined,
      } as never);
      if (gov.decision === "not-agent") return { granted: true };
      if (gov.decision === "execute") {
        return { granted: true, autoApprovedProposalId: randomUUID() };
      }
      if (gov.decision === "deny") return { denied: true, reason: gov.reason };
      const id = randomUUID();
      await h.client!.query(
        `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, created_by, created_at)
         values ($1,$2,'entity',$3,'create',$4::jsonb,'pending',$5,$5, now())`,
        [
          id,
          opts.workspaceId,
          (opts.data as { id: string }).id,
          JSON.stringify({ data: opts.data }),
          agentUserId,
        ]
      );
      return {
        granted: false,
        proposalId: id,
        proposalType: "entity.create",
        summary: "",
        reasoning: "",
        reviewPath: "",
        reviewUrl: "",
      };
    }),
    previewPermissionDecision: vi.fn(),
    proposedMessageFor: vi.fn(() => "proposed"),
  };
});
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
vi.mock(
  "../../../notifications/mark-proposal-notifications-actioned.js",
  () => ({
    markProposalNotificationsActioned: vi.fn(),
  })
);

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { resolvePendingProposalCap } from "@synap/database/agent-governance";
import { hubAuthMiddleware } from "../../../routers/hub-protocol/_middleware/auth.js";
import { idempotencyMiddleware } from "../../../routers/hub-protocol/_middleware/idempotency.js";
import { registerPublicFormsRoutes } from "../../../routers/hub-protocol/rest/public-forms.js";
import { formsRouter } from "../../../routers/forms.js";
import { toolsRouter } from "../../../routers/tools.js";
import { expireLapsedProposals } from "../../proposals/expire-lapsed-proposals.js";
import {
  defaultGuestDeps,
  submitGuestForm,
  type GuestDeps,
} from "../guest-submit.js";
import { guestProvenanceFor } from "../guest-provenance.js";
import { mintTicket } from "../form-definition.js";

// ── Principals / fixtures ──
const A = randomUUID(); // workspace owner, human
const B = randomUUID(); // another human (member, not owner)
const AG = randomUUID(); // an ordinary agent acting for A
const CAPTURE = randomUUID(); // the shared capture agent
const W = randomUUID();
const KNOWN = randomUUID(); // an existing person with a strong email signal
const KNOWN_EMAIL = "known@example.test";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const isArray = t.endsWith("[]");
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      !c.primary && c.hasDefault
        ? type.startsWith("timestamp")
          ? " default now()"
          : type === "uuid"
            ? " default gen_random_uuid()"
            : ""
        : "";
    return `"${c.name}" ${type}${isArray && !type.endsWith("[]") ? "[]" : ""}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const human = (userId: string) =>
  formsRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);
const tools = (userId: string) =>
  toolsRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);

async function errOf(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

function makeApp(deps?: GuestDeps) {
  const app = new OpenAPIHono();
  app.use("/*", hubAuthMiddleware as never);
  app.use("/*", idempotencyMiddleware({ skipPaths: [] }));
  registerPublicFormsRoutes(app as never, deps);
  const root = new OpenAPIHono();
  root.route("/api/hub", app);
  return root;
}

async function post(
  app: ReturnType<typeof makeApp>,
  token: string,
  body: unknown,
  raw?: string
) {
  const res = await app.request(`/api/hub/public/forms/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw ?? JSON.stringify(body),
  });
  return {
    status: res.status,
    text: await res.text(),
    type: res.headers.get("content-type"),
  };
}

const CONFIG = {
  name: "Contact us",
  kind: "person",
  facet: { profileSlug: "lead", properties: { "lead-source": "form" } },
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "email", label: "Email", type: "email", required: true },
    { key: "message", label: "Message", type: "richtext" },
  ],
  titleField: "name",
  limits: { pendingCap: 5, minSubmitMs: 0 },
};

let formId = "";
let token = "";
let actorId = "";

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [A, B]) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      u,
      `${u}@example.test`,
    ]);
  }
  for (const [u, type] of [
    [AG, "custom"],
    [CAPTURE, "capture"],
  ] as const) {
    await q(
      `insert into users (id, email, user_type, agent_type, created_by_user_id, agent_metadata) values ($1,$2,'agent',$3,$4,'{}'::jsonb)`,
      [u, `${u}@agents.test`, type, A]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [W, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$2,$5,'editor')`,
    [randomUUID(), W, A, randomUUID(), B]
  );
  for (const [slug, kind, applicable] of [
    ["person", "kind", null],
    ["note", "kind", null],
    ["company", "kind", null],
    ["lead", "role", ["person", "company"]],
  ] as const) {
    await q(
      `insert into profiles (id, slug, profile_kind, applicable_kinds, is_active, display_name) values ($1,$2,$3,$4,true,$2)`,
      [randomUUID(), slug, kind, applicable]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, title, type, properties) values ($1,$2,$3,'Known Person','person',$4::jsonb)`,
    [KNOWN, A, W, JSON.stringify({ email: KNOWN_EMAIL })]
  );
  await q(
    `insert into entity_identity_signals (id, entity_id, signal_type, signal_value) values ($1,$2,'email',$3)`,
    [randomUUID(), KNOWN, KNOWN_EMAIL]
  );

  const created = await human(A).create({ workspaceId: W, config: CONFIG });
  formId = created.form.id;
  token = created.token;
  actorId = created.form.actorUserId;
}, 120_000);

beforeEach(() => {
  h.gateCalls.length = 0;
  h.ambientAtGate.length = 0;
});

const newSubmission = () => ({
  fields: {
    name: "Ada Guest",
    email: `ada-${randomUUID().slice(0, 8)}@example.test`,
    message: "hello",
  },
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the owner door mints a least-privilege, per-form actor", () => {
  it("token is shown once and stored ONLY as a hash", async () => {
    const [row] = (
      await q<{ metadata: unknown; text: string }>(
        `select metadata, metadata::text as text from tools where id=$1`,
        [formId]
      )
    ).rows;
    const form = (row!.metadata as { form: Record<string, unknown> }).form;
    expect(form.tokenHash).toBe(
      createHash("sha256").update(token).digest("hex")
    );
    expect(form.tokenPrefix).toBe(token.slice(0, 6));
    // Non-vacuity: the token is long and the row text is non-trivial.
    expect(token.length).toBeGreaterThan(30);
    expect(row!.text.length).toBeGreaterThan(200);
    expect(row!.text.includes(token)).toBe(false);
    // Nothing anywhere else in the database carries the plaintext.
    const everywhere = await q<{ n: number }>(
      `select count(*)::int as n from tools where metadata::text like $1`,
      [`%${token}%`]
    );
    expect(everywhere.rows[0]!.n).toBe(0);
  });

  it("the actor: agent, form:<id>, exactly [entity.create], system-made, no key, ONE editor membership", async () => {
    const [actor] = (
      await q<Record<string, unknown>>(`select * from users where id=$1`, [
        actorId,
      ])
    ).rows;
    expect(actor).toMatchObject({
      user_type: "agent",
      agent_type: `form:${formId}`,
      created_by_user_id: A,
      created_via: "system",
      is_personal_agent: false,
    });
    expect(
      (actor!.agent_metadata as { capabilities: string[] }).capabilities
    ).toEqual(["entity.create"]);
    const members = await q(
      `select workspace_id, role from workspace_members where user_id=$1`,
      [actorId]
    );
    expect(members.rows).toEqual([{ workspace_id: W, role: "editor" }]);
    const keys = await q<{ n: number }>(
      `select count(*)::int as n from api_keys where user_id=$1`,
      [actorId]
    );
    expect(keys.rows[0]!.n).toBe(0);
  });

  it("mode absent ⇒ the stored rule is PROPOSE; the ceiling is the form's cap", async () => {
    const rules = await q(
      `select verdict, target_pattern, scope_kind, workspace_id from governance_rules where agent_user_id=$1 and revoked_at is null`,
      [actorId]
    );
    expect(rules.rows).toEqual([
      {
        verdict: "propose",
        target_pattern: "entity.create",
        scope_kind: "workspace",
        workspace_id: W,
      },
    ]);
    expect(
      await resolvePendingProposalCap({
        db: h.db as never,
        agentUserId: actorId,
      })
    ).toBe(5);
  });

  it("only the signed-in workspace owner: agent, API key and a non-owner member are refused", async () => {
    const asAgent = formsRouter.createCaller({
      authenticated: true,
      userId: A,
      agentUserId: AG,
      keyType: "agent",
      workspaceId: null,
    } as never);
    const asKey = formsRouter.createCaller({
      authenticated: true,
      userId: A,
      keyType: "user_pat",
      workspaceId: null,
    } as never);
    for (const caller of [asAgent, asKey]) {
      expect(
        (await errOf(caller.create({ workspaceId: W, config: CONFIG })))?.code
      ).toBe("FORBIDDEN");
      expect((await errOf(caller.rotateToken({ formId })))?.code).toBe(
        "FORBIDDEN"
      );
    }
    expect(
      (await errOf(human(B).create({ workspaceId: W, config: CONFIG })))?.code
    ).toBe("FORBIDDEN");
    expect(
      (await errOf(human(B).update({ formId, config: CONFIG })))?.code
    ).toBe("FORBIDDEN");
  });

  it("a structural kind is refused at definition time", async () => {
    const bad = await errOf(
      human(A).create({
        workspaceId: W,
        config: { ...CONFIG, kind: "workspace" },
      })
    );
    expect(bad?.code).toBe("BAD_REQUEST");
  });
});

describe("the generic tools doors refuse form rows", () => {
  it("tools.update / delete / setApproved / setAuthBinding refuse; tools.create refuses metadata.form", async () => {
    for (const p of [
      tools(A).update({ id: formId, metadata: { form: { hijacked: true } } }),
      tools(A).update({ id: formId, name: "renamed" }),
      tools(A).delete({ id: formId }),
      tools(A).setApproved({ id: formId, approved: true }),
      tools(A).setAuthBinding({ id: formId, authBinding: "per_user" }),
    ]) {
      expect((await errOf(p))?.code).toBe("FORBIDDEN");
    }
    expect(
      (
        await errOf(
          tools(A).create({
            name: "sneaky",
            kind: "external",
            workspaceId: W,
            metadata: { form: { tokenHash: "0".repeat(64) } },
          })
        )
      )?.code
    ).toBe("FORBIDDEN");
    // Positive control: the same doors still work on an ordinary tool.
    const plain = await tools(A).create({
      name: "plain",
      kind: "external",
      workspaceId: W,
    });
    expect(plain.status).toBe("created");
    const upd = await tools(A).update({ id: plain.tool!.id, name: "renamed" });
    expect(upd.status).toBe("updated");
    // And the form row is untouched.
    const [row] = (
      await q<{ name: string; md: string }>(
        `select name, metadata::text as md from tools where id=$1`,
        [formId]
      )
    ).rows;
    expect(row!.name).toBe("Contact us");
    expect(row!.md.includes("hijacked")).toBe(false);
  });
});

describe("the anonymous door files ONE governed create, as the form's actor", () => {
  it("public GET serves the fields and a ticket — no id, kind, actor or secret", async () => {
    const res = await makeApp().request(`/api/hub/public/forms/${token}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.fields.map((f: { key: string }) => f.key)).toEqual([
      "name",
      "email",
      "message",
    ]);
    expect(typeof body.ticket).toBe("string");
    for (const secret of [
      formId,
      actorId,
      A,
      W,
      "tokenHash",
      "ticketSecret",
      "person",
    ]) {
      expect(text.includes(secret), secret).toBe(false);
    }
    const miss = await makeApp().request(
      `/api/hub/public/forms/nope-${randomUUID()}`
    );
    expect(miss.status).toBe(404);
  });

  it("a new email ⇒ a PROPOSED person + lead facet, filed as the form actor inside its scope, with an expiry", async () => {
    const res = await post(makeApp(), token, newSubmission());
    expect(res).toMatchObject({ status: 202, text: '{"received":true}' });
    expect(h.gateCalls).toHaveLength(1);
    const call = h.gateCalls[0]!;
    expect(call).toMatchObject({
      userId: A,
      agentUserId: actorId,
      workspaceId: W,
      subjectType: "entity",
      action: "create",
      forcePropose: true,
    });
    expect(h.ambientAtGate).toEqual([actorId]);
    expect(call.agentUserId).not.toBe(CAPTURE);
    const data = call.data as Record<string, unknown>;
    expect(data.profileSlug).toBe("person");
    expect(data.resolvedWorkspaceId).toBe(W);
    expect(data.facets).toEqual([
      { profileSlug: "lead", properties: { "lead-source": "form" } },
    ]);
    const [p] = (
      await q<{ agent_user_id: string; expires_at: Date | null }>(
        `select agent_user_id, expires_at from proposals where target_id=$1`,
        [data.id]
      )
    ).rows;
    expect(p!.agent_user_id).toBe(actorId);
    const days = (new Date(p!.expires_at!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
    // Provenance: the actor row says "guest", not AI.
    const [actor] = (
      await q<{ agent_type: string }>(
        `select agent_type from users where id=$1`,
        [actorId]
      )
    ).rows;
    expect(guestProvenanceFor(actor!.agent_type)).toEqual({
      actorKind: "guest",
      formId,
    });
  });

  it("the body cannot select kind, workspace, user, profile, mode, actor or extra properties", async () => {
    const res = await post(makeApp(), token, {
      ...newSubmission(),
      kind: "workspace",
      profileSlug: "workspace",
      workspaceId: randomUUID(),
      userId: B,
      agentUserId: AG,
      actorUserId: AG,
      mode: "direct",
      facets: [{ profileSlug: "admin" }],
      fields: {
        ...newSubmission().fields,
        profileSlug: "workspace",
        workspaceId: randomUUID(),
        role: "owner",
        userId: B,
      },
    });
    expect(res.status).toBe(202);
    const call = h.gateCalls[0]!;
    expect(call).toMatchObject({
      userId: A,
      agentUserId: actorId,
      workspaceId: W,
      forcePropose: true,
    });
    const data = call.data as Record<string, unknown>;
    expect(data.profileSlug).toBe("person");
    expect(Object.keys(data.properties as object).sort()).toEqual([
      "email",
      "message",
      "name",
    ]);
  });

  it("every gate call this door ever makes is entity.create (no update, no delete)", async () => {
    await post(makeApp(), token, newSubmission());
    await post(makeApp(), token, {
      fields: { name: "Known", email: KNOWN_EMAIL },
    });
    expect(h.gateCalls.length).toBe(2);
    for (const c of h.gateCalls) {
      expect([c.subjectType, c.action]).toEqual(["entity", "create"]);
    }
  });

  it("a replay collapses onto the same pre-minted id (idempotency namespaced per form)", async () => {
    const body = { ...newSubmission(), idempotencyKey: "abc" };
    await post(makeApp(), token, body);
    await post(makeApp(), token, body);
    const [a, b] = h.gateCalls.map((c) => (c.data as { id: string }).id);
    expect(a).toBe(b);
  });
});

describe("identity: a match NEVER reaches a person write, and the reply is identical", () => {
  it("known email ⇒ a submission NOTE, no signal key, same bytes as a new email", async () => {
    const app = makeApp();
    const fresh = await post(app, token, newSubmission());
    const known = await post(app, token, {
      fields: { name: "Someone", email: KNOWN_EMAIL, message: "hi" },
    });
    expect(known).toEqual(fresh);
    expect(fresh).toEqual({
      status: 202,
      text: '{"received":true}',
      type: expect.stringContaining("application/json"),
    });
    expect(h.gateCalls).toHaveLength(2);
    const note = h.gateCalls[1]!;
    expect(note).toMatchObject({ subjectType: "entity", action: "create" });
    const data = note.data as Record<string, unknown>;
    expect(data.profileSlug).toBe("note");
    const props = data.properties as Record<string, unknown>;
    expect(props).not.toHaveProperty("email");
    expect(props.submitterEmail).toBe(KNOWN_EMAIL);
    expect(props.possibleMatchEntityId).toBe(KNOWN);
    expect(data.facets).toBeUndefined();
    // The existing person is untouched.
    const [known0] = (
      await q<{ properties: Record<string, unknown> }>(
        `select properties from entities where id=$1`,
        [KNOWN]
      )
    ).rows;
    expect(known0!.properties).toEqual({ email: KNOWN_EMAIL });
  });

  it("both branches do the SAME awaited work, in the same order", async () => {
    const trace: string[] = [];
    const real = defaultGuestDeps();
    const traced = Object.fromEntries(
      Object.entries(real).map(([k, fn]) => [
        k,
        async (...args: unknown[]) => {
          if (k !== "now") trace.push(k);
          return (fn as (...a: unknown[]) => unknown)(...args);
        },
      ])
    ) as unknown as GuestDeps;
    traced.now = () => Date.now();
    const run = async (email: string) => {
      trace.length = 0;
      const outcome = await submitGuestForm(
        {
          token,
          rawBody: JSON.stringify({ fields: { name: "X", email } }),
        },
        traced
      );
      return { outcome, trace: [...trace] };
    };
    const a = await run(`new-${randomUUID().slice(0, 6)}@example.test`);
    const b = await run(KNOWN_EMAIL);
    expect(a.outcome).toBe("proposed");
    expect(b.outcome).toBe("proposed");
    // Non-vacuity: the lookups this guard is about are in the trace.
    expect(a.trace).toEqual(
      expect.arrayContaining([
        "resolveIdentity",
        "resolveFacet",
        "resolveRuleVerdict",
        "gate",
      ])
    );
    expect(b.trace).toEqual(a.trace);
  });
});

describe("fail closed: every failure path is the same 202, and files nothing", () => {
  const RECEIVED = { status: 202, text: '{"received":true}' };

  it("honeypot, unknown token, bad JSON, missing required field, oversized body", async () => {
    const app = makeApp();
    const cases = [
      await post(app, token, { ...newSubmission(), hp: "i am a bot" }),
      await post(app, `unknown-${randomUUID()}`, newSubmission()),
      await post(app, token, null, "{not json"),
      await post(app, token, { fields: { name: "No email" } }),
      await post(app, token, { fields: { name: "x", email: "not-an-email" } }),
      await post(app, token, {
        fields: { name: { nested: 1 }, email: "a@b.io" },
      }),
    ];
    for (const c of cases) expect(c).toMatchObject(RECEIVED);
    expect(h.gateCalls).toHaveLength(0);
    // Oversized: exercised on the door (the transport's own 16 KB cap is W3's).
    const big = await submitGuestForm({
      token,
      rawBody: JSON.stringify({ fields: { name: "x".repeat(17_000) } }),
    });
    expect(big).toBe("too_large");
  });

  it("a time-to-submit ticket is required when the form sets a minimum", async () => {
    const real = defaultGuestDeps();
    const loaded = (await real.loadFormByTokenHash(
      createHash("sha256").update(token).digest("hex")
    ))!;
    const strict = {
      ...loaded,
      form: {
        ...loaded.form,
        config: {
          ...loaded.form.config,
          limits: { ...loaded.form.config.limits, minSubmitMs: 5_000 },
        },
      },
    };
    const t0 = 1_800_000_000_000;
    const deps = {
      ...real,
      loadFormByTokenHash: async () => strict,
      now: () => t0,
    };
    const body = (ticket?: string) =>
      JSON.stringify({ ...newSubmission(), ...(ticket ? { ticket } : {}) });
    expect(await submitGuestForm({ token, rawBody: body() }, deps)).toBe(
      "ticket"
    );
    const fresh = mintTicket(strict.form.ticketSecret, formId, t0 - 1_000);
    expect(await submitGuestForm({ token, rawBody: body(fresh) }, deps)).toBe(
      "ticket"
    );
    const forged = `${t0 - 10_000}.AAAA`;
    expect(await submitGuestForm({ token, rawBody: body(forged) }, deps)).toBe(
      "ticket"
    );
    const ok = mintTicket(strict.form.ticketSecret, formId, t0 - 10_000);
    expect(await submitGuestForm({ token, rawBody: body(ok) }, deps)).toBe(
      "proposed"
    );
  });

  it("captcha: a failed verification drops; an unreachable provider degrades to a FORCED proposal", async () => {
    const real = defaultGuestDeps();
    const loaded = (await real.loadFormByTokenHash(
      createHash("sha256").update(token).digest("hex")
    ))!;
    const direct = {
      ...loaded,
      form: {
        ...loaded.form,
        config: {
          ...loaded.form.config,
          mode: "direct" as const,
          captcha: { enabled: true },
        },
      },
    };
    const base = {
      ...real,
      loadFormByTokenHash: async () => direct,
      resolveRuleVerdict: async () => "auto" as const,
      materializeDirect: vi.fn(async () => undefined),
    };
    const raw = JSON.stringify(newSubmission());
    expect(
      await submitGuestForm(
        { token, rawBody: raw },
        { ...base, verifyCaptcha: async () => "fail" }
      )
    ).toBe("captcha_failed");
    expect(h.gateCalls).toHaveLength(0);
    expect(
      await submitGuestForm(
        { token, rawBody: raw },
        { ...base, verifyCaptcha: async () => "unavailable" }
      )
    ).toBe("proposed");
    expect(h.gateCalls.at(-1)).toMatchObject({ forcePropose: true });
    expect(base.materializeDirect).not.toHaveBeenCalled();
  });

  it("a denied / capped gate is still the same 202", async () => {
    const real = defaultGuestDeps();
    const app = makeApp({
      ...real,
      gate: (async () => ({
        denied: true,
        reason: "Agent proposal limit reached",
      })) as never,
    });
    expect(await post(app, token, newSubmission())).toMatchObject(RECEIVED);
  });
});

describe("the actor floor: a dropped or widened actor is REFUSED, never granted", () => {
  const withActor = async (
    mutate: string,
    params: unknown[],
    restore: string,
    restoreParams: unknown[]
  ) => {
    await q(mutate, params);
    try {
      return await submitGuestForm({
        token,
        rawBody: JSON.stringify(newSubmission()),
      });
    } finally {
      await q(restore, restoreParams);
    }
  };

  it("control: the intact actor files", async () => {
    expect(
      await submitGuestForm({ token, rawBody: JSON.stringify(newSubmission()) })
    ).toBe("proposed");
  });

  it("empty capabilities (= unrestricted) ⇒ refused", async () => {
    const out = await withActor(
      `update users set agent_metadata = jsonb_set(agent_metadata, '{capabilities}', '[]'::jsonb) where id=$1`,
      [actorId],
      `update users set agent_metadata = jsonb_set(agent_metadata, '{capabilities}', '["entity.create"]'::jsonb) where id=$1`,
      [actorId]
    );
    expect(out).toBe("actor_refused");
    expect(h.gateCalls).toHaveLength(0);
  });

  it("missing capabilities ⇒ refused", async () => {
    const out = await withActor(
      `update users set agent_metadata = agent_metadata - 'capabilities' where id=$1`,
      [actorId],
      `update users set agent_metadata = jsonb_set(agent_metadata, '{capabilities}', '["entity.create"]'::jsonb) where id=$1`,
      [actorId]
    );
    expect(out).toBe("actor_refused");
  });

  it("widened capabilities ⇒ refused", async () => {
    const out = await withActor(
      `update users set agent_metadata = jsonb_set(agent_metadata, '{capabilities}', '["entity.create","entity.update"]'::jsonb) where id=$1`,
      [actorId],
      `update users set agent_metadata = jsonb_set(agent_metadata, '{capabilities}', '["entity.create"]'::jsonb) where id=$1`,
      [actorId]
    );
    expect(out).toBe("actor_refused");
  });

  it("actor retyped to a HUMAN (which the gate would GRANT) ⇒ refused", async () => {
    const out = await withActor(
      `update users set user_type='human' where id=$1`,
      [actorId],
      `update users set user_type='agent' where id=$1`,
      [actorId]
    );
    expect(out).toBe("actor_refused");
    expect(h.gateCalls).toHaveLength(0);
  });

  it("actor row dropped ⇒ refused", async () => {
    const [row] = (
      await q<Record<string, unknown>>(`select * from users where id=$1`, [
        actorId,
      ])
    ).rows;
    await q(`delete from users where id=$1`, [actorId]);
    try {
      expect(
        await submitGuestForm({
          token,
          rawBody: JSON.stringify(newSubmission()),
        })
      ).toBe("actor_refused");
      expect(h.gateCalls).toHaveLength(0);
    } finally {
      await q(
        `insert into users (id, email, user_type, agent_type, created_by_user_id, created_via, is_personal_agent, agent_metadata) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [
          row!.id,
          row!.email,
          row!.user_type,
          row!.agent_type,
          row!.created_by_user_id,
          row!.created_via,
          row!.is_personal_agent,
          JSON.stringify(row!.agent_metadata),
        ]
      );
    }
  });

  it("actor without its workspace membership ⇒ refused (no join-proposal spam)", async () => {
    const out = await withActor(
      `update workspace_members set workspace_id=$2 where user_id=$1`,
      [actorId, randomUUID()],
      `update workspace_members set workspace_id=$2 where user_id=$1`,
      [actorId, W]
    );
    expect(out).toBe("actor_refused");
  });
});

describe("mode: proposal unless BOTH stores say direct", () => {
  const setRule = (verdict: "auto" | "propose") =>
    q(
      `update governance_rules set verdict=$2 where agent_user_id=$1 and revoked_at is null`,
      [actorId, verdict]
    );
  const setMode = (mode: string | null) =>
    q(
      mode === null
        ? `update tools set metadata = metadata #- '{form,config,mode}' where id=$1`
        : `update tools set metadata = jsonb_set(metadata, '{form,config,mode}', to_jsonb($2::text)) where id=$1`,
      mode === null ? [formId] : [formId, mode]
    );
  const run = async () => {
    const deps = {
      ...defaultGuestDeps(),
      materializeDirect: vi.fn(async () => undefined),
    };
    const outcome = await submitGuestForm(
      { token, rawBody: JSON.stringify(newSubmission()) },
      deps
    );
    return { outcome, direct: deps.materializeDirect.mock.calls.length };
  };

  it("config direct + rule auto ⇒ direct (the positive control)", async () => {
    await setMode("direct");
    await setRule("auto");
    try {
      const r = await run();
      expect(h.gateCalls.at(-1)).toMatchObject({ forcePropose: false });
      expect(r).toEqual({ outcome: "direct", direct: 1 });
    } finally {
      await setMode("proposal");
      await setRule("propose");
    }
  });

  it("config direct but the rule drifted to propose ⇒ forced proposal", async () => {
    await setMode("direct");
    try {
      const r = await run();
      expect(h.gateCalls.at(-1)).toMatchObject({ forcePropose: true });
      expect(r).toEqual({ outcome: "proposed", direct: 0 });
    } finally {
      await setMode("proposal");
    }
  });

  it("rule auto but config says proposal ⇒ forced proposal (the rule alone never widens)", async () => {
    await setRule("auto");
    try {
      const r = await run();
      expect(h.gateCalls.at(-1)).toMatchObject({ forcePropose: true });
      expect(r).toEqual({ outcome: "proposed", direct: 0 });
    } finally {
      await setRule("propose");
    }
  });

  it("mode ABSENT from the stored row ⇒ the definition parses with the proposal default; never direct", async () => {
    await setRule("auto");
    await setMode(null);
    try {
      const r = await run();
      expect(h.gateCalls.at(-1)).toMatchObject({ forcePropose: true });
      expect(r.direct).toBe(0);
    } finally {
      await setMode("proposal");
      await setRule("propose");
    }
  });

  it("the owner switching to direct rewrites the ONE rule; back to proposal revokes it", async () => {
    await human(A).update({ formId, config: { ...CONFIG, mode: "direct" } });
    let rules = await q<{ verdict: string }>(
      `select verdict from governance_rules where agent_user_id=$1 and revoked_at is null`,
      [actorId]
    );
    expect(rules.rows).toEqual([{ verdict: "auto" }]);
    await human(A).update({ formId, config: CONFIG });
    rules = await q<{ verdict: string }>(
      `select verdict from governance_rules where agent_user_id=$1 and revoked_at is null`,
      [actorId]
    );
    expect(rules.rows).toEqual([{ verdict: "propose" }]);
  });
});

describe("rotate + disable", () => {
  it("rotating kills the old token; disabling makes the form a miss", async () => {
    const r = await human(A).rotateToken({ formId });
    expect(
      await submitGuestForm({ token, rawBody: JSON.stringify(newSubmission()) })
    ).toBe("unknown_form");
    token = r.token;
    expect(
      await submitGuestForm({ token, rawBody: JSON.stringify(newSubmission()) })
    ).toBe("proposed");
    await human(A).setEnabled({ formId, enabled: false });
    expect(
      await submitGuestForm({ token, rawBody: JSON.stringify(newSubmission()) })
    ).toBe("unknown_form");
    await human(A).setEnabled({ formId, enabled: true });
  });
});

describe("expiry: the sweeper honours expires_at for GUEST proposals only", () => {
  it("expires a lapsed guest proposal; keeps a lapsed non-guest one and an unlapsed guest one", async () => {
    const guestLapsed = randomUUID();
    const guestLive = randomUUID();
    const agentLapsed = randomUUID();
    const ins = (id: string, agent: string, expires: string) =>
      q(
        `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, created_at, expires_at)
         values ($1::uuid,$2,'entity',$1::text,'create','{}'::jsonb,'pending',$3, now() - interval '40 days', now() + $4::interval)`,
        [id, W, agent, expires]
      );
    await ins(guestLapsed, actorId, "-1 day");
    await ins(guestLive, actorId, "5 days");
    await ins(agentLapsed, AG, "-1 day");
    await expireLapsedProposals(new Date());
    const rows = await q<{ id: string; status: string }>(
      `select id, status from proposals where id = any($1::uuid[]) order by id`,
      [[guestLapsed, guestLive, agentLapsed]]
    );
    const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
    expect(byId[guestLapsed]).toBe("expired");
    expect(byId[guestLive]).toBe("pending");
    expect(byId[agentLapsed]).toBe("pending");
  });
});
