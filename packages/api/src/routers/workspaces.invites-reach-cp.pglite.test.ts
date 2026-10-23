/**
 * Pod invites reach the Control Plane on a pod that does not know its name.
 *
 * Installer-built pods set neither POD_SUBDOMAIN nor SERVER_DOMAIN. Before
 * this, `createInvite` sent the CP `podSubdomain: ""` (CP 400, never checked:
 * the inviter was told nothing and no email went), and `notifyCpInviteSync` /
 * `notifyCpInviteLifecycle` returned early — the CP never recorded the
 * invite, so redemption never created a CP membership. The CP identifies a
 * pod-signed caller by its key, so the pod sends its name only as a claim,
 * and the invite-email answer is reported back to the inviter.
 *
 * Driven through the REAL `createInvite` / `revokeInvite` procedures → REAL
 * SQL on PGlite → the REAL pod→CP senders, with `fetch` as the CP. Stubbed:
 * the pod→CP credential (`podCpAuthHeaders` — it has its own suite).
 *
 * What this CANNOT see: the CP's answer to these bodies (the CP suite
 * `internal.invites-caller-pod.test.ts` drives that side).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    podCpAuthHeaders: async () => ({
      via: "pod-jwt",
      headers: { Authorization: "Bearer pod-signed" },
      bearer: "pod-signed",
    }),
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { config } from "@synap-core/core";
import {
  workspaces,
  workspaceMembers,
  users,
  invites,
  syncGeneration,
} from "@synap/database/schema";
import { workspacesRouter } from "./workspaces.js";

const CP = "https://cp.test";
const OWNER = "owner-1";
const WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const dflt =
      c.name === "id" && type === "uuid" ? " default gen_random_uuid()" : "";
    const now =
      type.startsWith("timestamp") && c.hasDefault ? " default now()" : "";
    return `"${c.name}" ${type}${dflt}${now}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

/** The CP: every call the pod made, and the answer per path. */
const cp = {
  calls: [] as Array<{ path: string; body: Record<string, unknown> }>,
  answers: {} as Record<string, { status: number; body: unknown }>,
};

const caller = () =>
  workspacesRouter.createCaller({
    db: h.db,
    authenticated: true,
    userId: OWNER,
    workspaceId: WS,
    workspaceRole: "owner",
  } as never);

const callsTo = (path: string) => cp.calls.filter((c) => c.path === path);

beforeAll(async () => {
  // `syncGeneration`: the mutation middleware's replica guard reads it (an
  // empty table = this pod is not a read-only replica).
  for (const t of [
    workspaces,
    workspaceMembers,
    users,
    invites,
    syncGeneration,
  ])
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  await h.client!.query(
    `insert into workspaces (id, name, owner_id, settings, created_at, updated_at)
     values ($1, 'Studio', $2, '{}'::jsonb, now(), now())`,
    [WS, OWNER]
  );
  await h.client!.query(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values ($1, $2, $3, 'owner')`,
    [randomUUID(), WS, OWNER]
  );
  await h.client!.query(
    `insert into users (id, email, name) values ($1, 'alice@example.com', 'Alice')`,
    [OWNER]
  );
});

beforeEach(() => {
  // An installer-built pod: it does not know its own name.
  delete process.env.POD_SUBDOMAIN;
  delete process.env.SERVER_DOMAIN;
  (config.server as { controlPlaneUrl?: string }).controlPlaneUrl = CP;
  cp.calls = [];
  cp.answers = {
    "/internal/invite-email": { status: 200, body: { sent: true } },
    "/internal/invites/sync": { status: 200, body: { ok: true } },
    "/internal/invites/lifecycle": { status: 200, body: { ok: true } },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body: string }) => {
      const path = new URL(url).pathname;
      cp.calls.push({ path, body: JSON.parse(init.body) });
      const answer = cp.answers[path] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
});

const invite = (email: string) =>
  caller().createInvite({
    type: "workspace",
    workspaceId: WS,
    email,
    role: "editor",
  });

describe("createInvite on a pod with no POD_SUBDOMAIN", () => {
  it("asks the CP to email the invite AND records it there", async () => {
    const created = await invite("bob@example.com");

    expect(created).toMatchObject({ emailSent: true, emailError: null });
    const email = callsTo("/internal/invite-email");
    expect(email).toHaveLength(1);
    expect(email[0]!.body).toMatchObject({
      inviteToken: created.token,
      email: "bob@example.com",
      workspaceName: "Studio",
      // This pod redeems its own invites, so the CP links the email to the
      // pod's console invite page, not the landing site's CP redemption.
      orchestration: "pod_local",
    });
    // A name the pod does not have is not sent as an empty one.
    expect(email[0]!.body).not.toHaveProperty("podSubdomain");

    await vi.waitFor(() =>
      expect(callsTo("/internal/invites/sync")).toHaveLength(1)
    );
    const sync = callsTo("/internal/invites/sync")[0]!.body;
    expect(sync).toMatchObject({
      inviteToken: created.token,
      type: "workspace",
      workspaceId: WS,
      email: "bob@example.com",
    });
    expect(sync).not.toHaveProperty("podSubdomain");
  });

  it("sends the name as a claim when the deploy set one", async () => {
    process.env.POD_SUBDOMAIN = "alice";
    await invite("carol@example.com");
    expect(callsTo("/internal/invite-email")[0]!.body).toMatchObject({
      podSubdomain: "alice",
    });
    await vi.waitFor(() =>
      expect(callsTo("/internal/invites/sync")[0]?.body).toMatchObject({
        podSubdomain: "alice",
      })
    );
  });

  it("a CP refusal (400) reaches the inviter as emailSent:false with the reason — the invite is kept", async () => {
    cp.answers["/internal/invite-email"] = {
      status: 400,
      body: {
        error: "podSubdomain: String must contain at least 1 character(s)",
      },
    };
    const created = await invite("dave@example.com");

    expect(created.emailSent).toBe(false);
    expect(created.emailError).toContain("400");
    expect(created.emailError).toContain("podSubdomain");
    const rows = await h.client!.query<{ id: string }>(
      `select id from invites where id = $1`,
      [created.id]
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("a send the CP skipped ({sent:false, reason}) is not reported as sent", async () => {
    cp.answers["/internal/invite-email"] = {
      status: 200,
      body: { sent: false, reason: "No active subscription" },
    };
    const created = await invite("erin@example.com");
    expect(created).toMatchObject({
      emailSent: false,
      emailError: "No active subscription",
    });
  });
});

describe("revokeInvite on a pod with no POD_SUBDOMAIN", () => {
  it("tells the CP the invite was revoked", async () => {
    const created = await invite("frank@example.com");
    cp.calls = [];
    await caller().revokeInvite({ id: created.id });
    await vi.waitFor(() =>
      expect(callsTo("/internal/invites/lifecycle")).toHaveLength(1)
    );
    expect(callsTo("/internal/invites/lifecycle")[0]!.body).toMatchObject({
      inviteToken: created.token,
      event: "revoked",
    });
  });
});
